/**
 * threshold-key — sovereign/premium-tier key custody (data-plane spec 10 key decision).
 *
 * Shamir secret sharing over GF(256): a masking key is split into `n` shares such that any
 * `t` reconstruct it and fewer than `t` reveal nothing. This is the sovereign tier — the key
 * is never held whole by any single party (not the operator, not the super-peer), so no one
 * can unmask alone. The standard tier (per-tenant KMS/Vault) is a separate KeyProvider; both
 * satisfy the `KeyProvider` contract (masking.ts), matching the tiered custody decision.
 *
 * Pure crypto — no infra, fully testable. GF(256) uses the AES field polynomial (0x11b).
 */

import { randomBytes } from 'node:crypto'
import type { KeyProvider } from './masking.js'

// ─── GF(256) arithmetic (AES field) ─────────────────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  // Generator 3 (0x03) is primitive for the AES field 0x11b; 2 is NOT (order 51).
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    const xt = ((x << 1) ^ ((x >> 7) * 0x1b)) & 0xff // xtime(x)
    x = xt ^ x // x * 3 = xtime(x) ⊕ x
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
})()

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!)
const gdiv = (a: number, b: number): number => (a === 0 ? 0 : EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!)

// ─── Shares ──────────────────────────────────────────────────────────────────────────
export interface Share { x: number; y: Buffer }

/** `x.hex` — portable share encoding for distribution to shareholders. */
export function shareToString(s: Share): string { return `${s.x}.${s.y.toString('hex')}` }
export function shareFromString(str: string): Share {
  const dot = str.indexOf('.')
  if (dot <= 0) throw new Error('invalid share')
  return { x: Number(str.slice(0, dot)), y: Buffer.from(str.slice(dot + 1), 'hex') }
}

/** Split a secret into `n` shares, `t` required to reconstruct (1 < t ≤ n ≤ 255). */
export function splitSecret(secret: Buffer, n: number, t: number, rand: (len: number) => Buffer = defaultRand): Share[] {
  if (t < 2 || t > n || n > 255) throw new Error('require 2 ≤ t ≤ n ≤ 255')
  const shares: Share[] = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: Buffer.alloc(secret.length) }))
  for (let b = 0; b < secret.length; b++) {
    const coeffs = [secret[b]!, ...rand(t - 1)] // constant term = secret byte
    for (const s of shares) {
      // Horner eval of the polynomial at x = s.x, in GF(256).
      let y = 0
      for (let k = coeffs.length - 1; k >= 0; k--) y = gmul(y, s.x) ^ coeffs[k]!
      s.y[b] = y
    }
  }
  return shares
}

/** Reconstruct the secret from ≥ t shares (Lagrange interpolation at x = 0). */
export function combineSecret(shares: Share[]): Buffer {
  if (shares.length < 2) throw new Error('need at least 2 shares')
  const len = shares[0]!.y.length
  // Validate shares: a duplicate/out-of-range x makes a Lagrange denominator (x_j ⊕ x_m) zero,
  // which SILENTLY reconstructs the WRONG key (no error). x=0 is the secret's own evaluation
  // point. Reject these — a caller/attacker must not corrupt the key undetectably.
  const seen = new Set<number>()
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > 255) throw new Error(`combineSecret: invalid share x=${s.x} (must be 1..255)`)
    if (seen.has(s.x)) throw new Error(`combineSecret: duplicate share x=${s.x}`)
    seen.add(s.x)
    if (s.y.length !== len) throw new Error('combineSecret: inconsistent share length')
  }
  const out = Buffer.alloc(len)
  for (let b = 0; b < len; b++) {
    let acc = 0
    for (let j = 0; j < shares.length; j++) {
      // Lagrange basis L_j(0) = ∏_{m≠j} x_m / (x_j ⊕ x_m)   (−x = x in GF(2^k))
      let basis = 1
      for (let m = 0; m < shares.length; m++) {
        if (m === j) continue
        basis = gmul(basis, gdiv(shares[m]!.x, shares[j]!.x ^ shares[m]!.x))
      }
      acc ^= gmul(shares[j]!.y[b]!, basis)
    }
    out[b] = acc
  }
  return out
}

function defaultRand(len: number): Buffer { return randomBytes(len) }

/**
 * A KeyProvider that reconstructs the masking key from a quorum of shares. The provider is
 * given only the shares it holds; getKey() throws unless it holds at least `threshold` of
 * them — the sovereignty guarantee that no under-quorum party can unmask.
 */
export class ThresholdKeyProvider implements KeyProvider {
  constructor(private readonly shares: Share[], private readonly threshold: number) {}
  getKey(): Buffer {
    if (this.shares.length < this.threshold) {
      throw new Error(`ThresholdKeyProvider: quorum not met (${this.shares.length}/${this.threshold})`)
    }
    return combineSecret(this.shares)
  }
}
