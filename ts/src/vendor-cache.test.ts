import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalObjectStore } from './object-store.js'
import { Governor, InMemoryAuditLog } from './policy.js'
import { StaticKeyProvider, isMasked, getAtPath } from './masking.js'
import { VendorCacheManager, type VendorFilesClient } from './vendor-cache.js'

// A fake vendor Files API that records what was uploaded.
class FakeVendor implements VendorFilesClient {
  readonly uploads = new Map<string, string>() // fileId → content
  private seq = 0
  async uploadFile(content: string): Promise<string> {
    const id = `file_${++this.seq}`
    this.uploads.set(id, content)
    return id
  }
  async deleteFile(fileId: string): Promise<void> { this.uploads.delete(fileId) }
}

const PAYLOAD = JSON.stringify({ phones: { home: '(123) 456-7890', work: '(456) 194-3754' } })

async function setup() {
  const store = new CanonicalObjectStore()
  await store.ingest('doc1', PAYLOAD, { mime: 'application/json', residency: 'EU', sensitiveFields: ['$.phones.home'] })
  store.setState('doc1', 'Served')
  const audit = new InMemoryAuditLog()
  const gov = new Governor({ rules: [] }, audit)
  const vendor = new FakeVendor()
  const mgr = new VendorCacheManager(store, gov, StaticKeyProvider.fromPassphrase('tenant-key'), { gemini: vendor })
  return { store, gov, audit, vendor, mgr }
}

test('materialization is denied without opt-in (default-off egress)', async () => {
  const { mgr, vendor, store } = await setup()
  const r = await mgr.materialize('doc1', 'gemini', { optIn: false, ttlMs: 1000 })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /egress denied/)
  assert.equal(vendor.uploads.size, 0, 'nothing left the cell')
  assert.equal(store.entry('doc1')!.state, 'Served', 'state unchanged')
})

test('opted-in materialization masks sensitive fields before egress + records a TTL handle', async () => {
  const { mgr, vendor, store } = await setup()
  const r = await mgr.materialize('doc1', 'gemini', { optIn: true, ttlMs: 1000, now: 0 })
  assert.equal(r.ok, true)
  const handle = (r as { handle: { fileId: string; ttlAt: number } }).handle
  assert.equal(handle.ttlAt, 1000)

  // The uploaded payload has the sensitive field MASKED; work is untouched.
  const uploaded = JSON.parse(vendor.uploads.get(handle.fileId)!)
  assert.ok(isMasked(getAtPath(uploaded, '$.phones.home')), 'home masked before egress')
  assert.equal(getAtPath(uploaded, '$.phones.work'), '(456) 194-3754', 'work untouched')

  assert.equal(store.entry('doc1')!.state, 'VendorMaterialized')
})

test('non-maskable (non-JSON) content with sensitive fields fails closed', async () => {
  const store = new CanonicalObjectStore()
  await store.ingest('doc2', 'a plain non-json note', { mime: 'text/plain', residency: 'EU', sensitiveFields: ['$.secret'] })
  store.setState('doc2', 'Served')
  const mgr = new VendorCacheManager(store, new Governor(), StaticKeyProvider.fromPassphrase('k'), { gemini: new FakeVendor() })
  const r = await mgr.materialize('doc2', 'gemini', { optIn: true, ttlMs: 1000 })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /cannot mask non-JSON/)
})

test('GC deletes the vendor file past TTL and moves to ExpiredVendorCache; rematerialize restores', async () => {
  const { mgr, vendor, store } = await setup()
  const m = await mgr.materialize('doc1', 'gemini', { optIn: true, ttlMs: 1000, now: 0 })
  const fileId = (m as { handle: { fileId: string } }).handle.fileId
  assert.ok(vendor.uploads.has(fileId))

  const gcd = await mgr.gc(2000) // past ttlAt=1000
  assert.equal(gcd, 1)
  assert.equal(vendor.uploads.has(fileId), false, 'vendor file deleted')
  assert.equal(mgr.handle('doc1', 'gemini'), undefined, 'handle dropped')
  assert.equal(store.entry('doc1')!.state, 'ExpiredVendorCache')

  const re = await mgr.rematerialize('doc1', 'gemini', { optIn: true, ttlMs: 1000, now: 3000 })
  assert.equal(re.ok, true, 're-materialized from canonical')
  assert.equal(store.entry('doc1')!.state, 'VendorMaterialized')
})
