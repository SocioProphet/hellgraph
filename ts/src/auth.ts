/**
 * auth — authentication + authorization for the super-peer surface (production hardening).
 *
 * The super-peer HTTP endpoints (/health /cut /query /admit) are the cell's front door; in
 * production they MUST be authenticated. This module provides a stateless bearer-token model:
 * a token carries a Principal (id + tenant + scopes), HMAC-signed so it verifies without a
 * lookup. The default HmacTokenVerifier is self-contained (testable, no infra); JWT/OIDC/mTLS
 * verifiers implement the same TokenVerifier interface for real deployments.
 *
 * Scopes gate endpoints: 'read' (health/cut), 'query' (retrieval), 'admit' (admit a sovereign
 * writer — a governance action). Absence of a configured verifier = dev/open mode; production
 * MUST configure one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type Scope = 'read' | 'query' | 'admit'

export interface Principal {
  id: string
  tenant?: string
  scopes: Scope[]
  /** Optional expiry (epoch-ms). */
  exp?: number
}

export interface TokenVerifier {
  /** Return the Principal for a valid token, or null if invalid/expired. */
  verify(token: string): Principal | null
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope)
}

const b64url = (b: Buffer): string => b.toString('base64url')

/**
 * Stateless HMAC-signed bearer tokens: `<base64url(principal-json)>.<base64url(hmac)>`.
 * Verification recomputes the HMAC and compares in constant time; no server-side session.
 */
export class HmacTokenVerifier implements TokenVerifier {
  private constructor(private readonly secret: Buffer) {}
  static fromSecret(secret: string): HmacTokenVerifier { return new HmacTokenVerifier(Buffer.from(secret, 'utf8')) }

  private sign(payloadB64: string): string {
    return b64url(createHmac('sha256', this.secret).update(payloadB64).digest())
  }

  /** Mint a token for a principal (token issuance — dev/tests and an operator CLI). */
  mint(principal: Principal): string {
    const payload = b64url(Buffer.from(JSON.stringify(principal), 'utf8'))
    return `${payload}.${this.sign(payload)}`
  }

  verify(token: string): Principal | null {
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const payload = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = this.sign(payload)
    // constant-time compare (equal length required by timingSafeEqual)
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    let principal: Principal
    try { principal = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Principal } catch { return null }
    if (!principal || !Array.isArray(principal.scopes) || typeof principal.id !== 'string') return null
    if (principal.exp !== undefined && Date.now() > principal.exp) return null
    return principal
  }
}

/** Extract a bearer token from an Authorization header value.
 *  Linear-time scan (no backtracking quantifiers) — avoids js/polynomial-redos
 *  on adversarial headers like `Bearer\t\t\t…`. */
export function bearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const s = authHeader.trim()
  const sp = s.search(/\s/)                            // first whitespace: end of the scheme token
  if (sp < 0) return null
  if (s.slice(0, sp).toLowerCase() !== 'bearer') return null
  const token = s.slice(sp + 1).trim()
  return token.length ? token : null
}
