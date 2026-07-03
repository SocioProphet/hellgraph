/**
 * masking — reversible, field-level, predicate-driven masking (data-plane spec 10, L5).
 *
 * The egress-safety mechanism: before content leaves the cell (vendor materialization,
 * connectors), sensitive fields are encrypted IN PLACE as delimited ciphertext ({#…#}), so
 * the payload stays structurally valid and round-trips losslessly on unmask. This is the
 * executor for the `mask:<path>` obligations the policy engine (policy.ts) emits at egress.
 *
 * The policy itself is a data-flow graph (Json Processor → selector + predicate → Mask/Unmask
 * Processor) and lives natively in HellGraph via maskingPolicyToGraph — versioned, provable,
 * codex-sealable like any subgraph.
 *
 * KEY CUSTODY is an open decision (spec 10): per-tenant KMS vs sovereign/threshold keys. The
 * KeyProvider is injected; the default is a passphrase-derived static key for local/test use.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { HellGraphStore } from './store.js'

// ─── Key custody (injected; production model is an open decision) ────────────────────
export interface KeyProvider { getKey(keyId?: string): Buffer }

export class StaticKeyProvider implements KeyProvider {
  private constructor(private readonly key: Buffer) {}
  static fromPassphrase(passphrase: string): StaticKeyProvider {
    return new StaticKeyProvider(createHash('sha256').update(passphrase, 'utf8').digest())
  }
  getKey(): Buffer { return this.key }
}

// ─── Reversible field cipher — AES-256-GCM, delimited in place ───────────────────────
const WRAP = /^\{#(.*)#\}$/

/** True if a value is already a masked ciphertext wrapper. */
export function isMasked(v: unknown): boolean { return typeof v === 'string' && WRAP.test(v) }

/** Encrypt a plaintext to `{#base64(iv|tag|ct)#}`. Authenticated (GCM), random IV. */
export function maskValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return `{#${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}#}`
}

/** Recover a plaintext from a `{#…#}` wrapper. Throws if not masked or auth fails (wrong key/tamper). */
export function unmaskValue(wrapped: string, key: Buffer): string {
  const m = WRAP.exec(wrapped)
  if (!m) throw new Error('unmaskValue: not a masked value')
  const buf = Buffer.from(m[1]!, 'base64')
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// ─── Minimal JSONPath (dot-path) resolve/set: $.a.b.c ────────────────────────────────
function pathKeys(jpath: string): string[] {
  return jpath.replace(/^\$\.?/, '').split('.').filter(Boolean)
}
export function getAtPath(obj: unknown, jpath: string): unknown {
  return pathKeys(jpath).reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), obj)
}
export function setAtPath(obj: unknown, jpath: string, value: unknown): void {
  const keys = pathKeys(jpath)
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]!] = value
}

// ─── Apply mask / unmask over a payload ──────────────────────────────────────────────
/** Mask each protected path in place (only string leaves; already-masked values are left). */
export function applyMask(payload: unknown, paths: string[], key: Buffer): unknown {
  const clone = structuredClone(payload)
  for (const p of paths) {
    const v = getAtPath(clone, p)
    if (typeof v === 'string' && !isMasked(v)) setAtPath(clone, p, maskValue(v, key))
  }
  return clone
}

/** Unmask each protected path in place (only masked leaves). */
export function applyUnmask(payload: unknown, paths: string[], key: Buffer): unknown {
  const clone = structuredClone(payload)
  for (const p of paths) {
    const v = getAtPath(clone, p)
    if (isMasked(v)) setAtPath(clone, p, unmaskValue(v as string, key))
  }
  return clone
}

/**
 * The L5 → masking bridge: apply the `mask:<path>` obligations from a policy egress decision
 * (policy.ts `decide`) to a payload before it egresses. Non-mask obligations are ignored here.
 */
export function applyEgressObligations(payload: unknown, obligations: string[], key: Buffer): unknown {
  const paths = obligations.filter((o) => o.startsWith('mask:')).map((o) => o.slice('mask:'.length))
  return applyMask(payload, paths, key)
}

// ─── The policy AS a HellGraph subgraph (Image 1) ────────────────────────────────────
/**
 * Encode a masking policy as a HellGraph data-flow graph: a Json Processor root with, per
 * protected path, a `mask` edge (selector + predicate encrypt) to a Mask Processor and an
 * `unmask` edge (selector + predicate decrypt) to an Unmask Processor. The policy is then a
 * versioned, provable, codex-sealable subgraph — the policy engine self-hosts in the graph.
 */
export function maskingPolicyToGraph(g: HellGraphStore, policyId: string, paths: string[]): void {
  const root = `policy:${policyId}:json-processor`
  const mask = `policy:${policyId}:mask-processor`
  const unmask = `policy:${policyId}:unmask-processor`
  g.addNode(root, ['JsonProcessor'], { policyId })
  g.addNode(mask, ['MaskProcessor'], { op: 'encrypt' })
  g.addNode(unmask, ['UnmaskProcessor'], { op: 'decrypt' })
  for (const p of paths) {
    g.addEdge('mask', root, mask, { selector: p, predicate: 'encrypt' })
    g.addEdge('unmask', root, unmask, { selector: p, predicate: 'decrypt' })
  }
}
