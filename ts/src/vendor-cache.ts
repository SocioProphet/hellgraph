/**
 * vendor-cache — L3 vendor materialization (data-plane spec 10). OPT-IN, default-off.
 *
 * Materializes canonical content to a frontier model's Files API (Gemini / Claude / OpenAI) as
 * a disposable, TTL/GC'd, re-materializable cache. This is egress to a third-party cloud, so it
 * is admissible ONLY under L5: every materialization is gated by the policy engine's opt-in
 * egress decision, and sensitive fields are masked (spec-10 masking) before anything leaves the
 * cell. Canonical (L1) never leaves without a decision; the vendor copy is disposable.
 *
 * The Files clients are injected (like S3) — dependency-free + testable; the real vendor SDKs
 * implement VendorFilesClient. The key provider is either tier (KMS / threshold).
 */

import type { CanonicalObjectStore } from './object-store.js'
import { Governor, decide } from './policy.js'
import { applyEgressObligations } from './masking.js'
import type { KeyProvider } from './masking.js'
import type { ContentObject } from './lifecycle.js'

/** A frontier Files API — an adapter over Gemini / Claude / OpenAI file handling implements this. */
export interface VendorFilesClient {
  uploadFile(content: string, mime: string): Promise<string> // returns a vendor file id
  deleteFile(fileId: string): Promise<void>
}

export interface VendorHandle {
  objectId: string
  vendor: string
  fileId: string
  materializedAt: number
  ttlAt: number
}

export type MaterializeResult = { ok: true; handle: VendorHandle } | { ok: false; reason: string }

export interface MaterializeOptions {
  /** Deliberate opt-in for this egress (default-off). Without it, the policy denies. */
  optIn: boolean
  ttlMs: number
  now?: number
}

export class VendorCacheManager {
  private readonly handles = new Map<string, VendorHandle>()

  constructor(
    private readonly store: CanonicalObjectStore,
    private readonly governor: Governor,
    private readonly key: KeyProvider,
    private readonly clients: Record<string, VendorFilesClient>,
  ) {}

  private keyOf(objectId: string, vendor: string): string { return `${objectId}:${vendor}` }

  /** Live (unexpired) handle for an object at a vendor, if any. */
  handle(objectId: string, vendor: string): VendorHandle | undefined {
    return this.handles.get(this.keyOf(objectId, vendor))
  }

  /** Materialize a Served object to a vendor (opt-in, gated + masked). */
  async materialize(objectId: string, vendor: string, opts: MaterializeOptions): Promise<MaterializeResult> {
    return this.push(objectId, vendor, 'vendor_materialize', opts)
  }

  /** Re-push an expired object from canonical (opt-in, gated + masked). */
  async rematerialize(objectId: string, vendor: string, opts: MaterializeOptions): Promise<MaterializeResult> {
    return this.push(objectId, vendor, 'rematerialize', opts)
  }

  private async push(
    objectId: string,
    vendor: string,
    trigger: 'vendor_materialize' | 'rematerialize',
    opts: MaterializeOptions,
  ): Promise<MaterializeResult> {
    const entry = this.store.entry(objectId)
    if (!entry) return { ok: false, reason: `object ${objectId} not in catalog` }
    const client = this.clients[vendor]
    if (!client) return { ok: false, reason: `no client for vendor ${vendor}` }

    const obj: ContentObject = { ...this.store.toPolicyObject(objectId), vendorOptIn: opts.optIn }

    // 1. Policy egress gate (opt-in default-deny) → also yields the mask obligations.
    const eg = decide({ action: 'egress', object: obj, target: { kind: 'vendor', id: vendor } })
    if (eg.effect === 'deny') return { ok: false, reason: `egress denied: ${eg.reason}` }

    // 2. Mask sensitive fields BEFORE egress.
    const got = await this.store.get(objectId)
    if (!got) return { ok: false, reason: `object ${objectId} bytes missing` }
    let payload = got.content
    const maskObligations = eg.obligations.filter((o) => o.startsWith('mask:'))
    if (maskObligations.length > 0) {
      let parsed: unknown
      try { parsed = JSON.parse(got.content) } catch {
        return { ok: false, reason: 'cannot mask non-JSON content before egress (fail-closed)' }
      }
      payload = JSON.stringify(applyEgressObligations(parsed, maskObligations, this.key.getKey()))
    }

    // 3. Upload the (masked) payload to the vendor.
    const fileId = await client.uploadFile(payload, entry.mime)

    // 4. Move the lifecycle state (gated + audited) and record the disposable handle.
    this.governor.transition(obj, trigger)
    this.store.setState(objectId, obj.state)
    const now = opts.now ?? Date.now()
    const handle: VendorHandle = { objectId, vendor, fileId, materializedAt: now, ttlAt: now + opts.ttlMs }
    this.handles.set(this.keyOf(objectId, vendor), handle)
    return { ok: true, handle }
  }

  /**
   * Garbage-collect expired vendor caches: delete the vendor file, drop the handle, and move the
   * object to ExpiredVendorCache (re-materializable from canonical). Returns the count GC'd.
   */
  async gc(now: number): Promise<number> {
    let n = 0
    for (const [k, h] of [...this.handles]) {
      if (h.ttlAt > now) continue
      await this.clients[h.vendor]?.deleteFile(h.fileId)
      this.handles.delete(k)
      const obj: ContentObject = { ...this.store.toPolicyObject(h.objectId), vendorOptIn: true }
      this.governor.transition(obj, 'ttl_gc')
      this.store.setState(h.objectId, obj.state)
      n++
    }
    return n
  }
}
