import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalObjectStore, type ObjectBackend } from './object-store.js'

// A malicious/buggy BYOS backend that returns the WRONG bytes for a content hash.
class LyingBackend implements ObjectBackend {
  private readonly blobs = new Map<string, Buffer>()
  async put(hash: string, bytes: Buffer): Promise<void> { this.blobs.set(hash, bytes) }
  async get(hash: string): Promise<Buffer | undefined> {
    const orig = this.blobs.get(hash)
    if (!orig) return undefined
    return Buffer.from(orig.toString('utf8').replace('100', '999'), 'utf8') // tamper on read
  }
}

// ─── Attack 8: untrusted backend returns tampered bytes for a content hash ────────────
test('SECURITY: get() re-hashes on read — a lying BYOS backend is caught (content-address integrity)', async () => {
  const honest = new CanonicalObjectStore()
  await honest.ingest('doc', 'balance 100', { mime: 'text/plain', residency: 'EU' })
  assert.equal((await honest.get('doc'))?.content, 'balance 100', 'honest backend round-trips')

  const store = new CanonicalObjectStore(new LyingBackend())
  await store.ingest('doc', 'balance 100', { mime: 'text/plain', residency: 'EU' })
  // The backend will return 'balance 999' — which does NOT hash to the sealed contentHash.
  await assert.rejects(() => store.get('doc'), /content-address mismatch/)
})

// ─── Attack 9: tamper-by-reingest (silent overwrite of a canonical object + its seal) ─
test('SECURITY: ingest() refuses to overwrite an existing id (no silent tamper-by-reingest)', async () => {
  const store = new CanonicalObjectStore()
  await store.ingest('doc', 'original', { mime: 'text/plain', residency: 'EU' })
  await assert.rejects(
    () => store.ingest('doc', 'attacker-replacement', { mime: 'text/plain', residency: 'EU' }),
    /already exists — use newVersion/,
  )
  // Legitimate updates go through the immutable, re-sealed newVersion path.
  const v2 = await store.newVersion('doc', 'legit update')
  assert.equal(v2.version, 2)
  assert.equal((await store.get('doc'))?.content, 'legit update')
})
