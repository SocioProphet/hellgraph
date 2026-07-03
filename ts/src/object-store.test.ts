import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalObjectStore, S3ObjectBackend, type S3Client } from './object-store.js'
import { decide } from './policy.js'

const ingest = (s: CanonicalObjectStore) =>
  s.ingest('doc1', 'the open gate', { mime: 'text/plain', residency: 'EU', sensitiveFields: ['$.phones.home'], division: 42 })

test('ingest seals codex + catalogs; stored content re-verifies INTACT', async () => {
  const store = new CanonicalObjectStore()
  const entry = await ingest(store)
  assert.equal(entry.version, 1)
  assert.equal(entry.state, 'Normalized')
  assert.equal(entry.codex.gematria, 116, 'codex sealed at ingest')
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/)

  const v = await store.verify('doc1')
  assert.equal(v.class, 'INTACT')
  assert.equal(v.verdict, 'POS')
})

test('integrity-at-rest: external drift is detected and classified', async () => {
  const store = new CanonicalObjectStore()
  await ingest(store)
  const drift = await store.verify('doc1', 'the open gaze') // substitution
  assert.equal(drift.class, 'substitution')
  assert.equal(drift.verdict, 'NEG')
})

test('versioning: new version bumps + re-seals; current version verifies against its own seal', async () => {
  const store = new CanonicalObjectStore()
  const v1 = await ingest(store)
  const v2 = await store.newVersion('doc1', 'the open gate now')
  assert.equal(v2.version, 2)
  assert.notEqual(v2.contentHash, v1.contentHash, 'new bytes → new hash')
  assert.notEqual(v2.codex._sha256, v1.codex._sha256, 'new content → new codex seal')
  assert.equal((await store.verify('doc1')).class, 'INTACT', 'current version verifies against its own seal')
})

test('provenance travels: derived artifact carries canonical id + version + codex + cut', async () => {
  const store = new CanonicalObjectStore()
  const entry = await ingest(store)
  const cut = { aaaa: 3, bbbb: 1 }
  const prov = store.provenanceOf('doc1', cut)
  assert.equal(prov.canonicalId, 'doc1')
  assert.equal(prov.version, 1)
  assert.equal(prov.contentHash, entry.contentHash)
  assert.equal(prov.codexSha, entry.codex._sha256)
  assert.deepEqual(prov.cut, cut, 'causal frame (spec 09) carried into the derived path')
})

test('catalog bridges to the policy engine (L1 → L5): residency + sensitivity flow through', async () => {
  const store = new CanonicalObjectStore()
  await ingest(store)
  store.setState('doc1', 'Served')

  const obj = store.toPolicyObject('doc1')
  assert.equal(obj.residency, 'EU')
  assert.deepEqual(obj.sensitiveFields, ['$.phones.home'])

  // Egress of this canonical object to a vendor is default-deny (not opted in).
  const d = decide({ action: 'egress', object: obj, target: { kind: 'vendor' } })
  assert.equal(d.effect, 'deny')
})

test('get returns the stored canonical bytes', async () => {
  const store = new CanonicalObjectStore()
  await ingest(store)
  assert.equal((await store.get('doc1'))?.content, 'the open gate')
})

// ─── S3/BYOS backend ──────────────────────────────────────────────────────────────────
// An in-memory fake S3 client proves the adapter logic (content-addressed keys, prefix,
// round-trip, miss→undefined); the live endpoint is an injected dependency (BYOS).
class FakeS3 implements S3Client {
  readonly objects = new Map<string, Buffer>()
  async putObject(bucket: string, key: string, body: Buffer): Promise<void> { this.objects.set(`${bucket}/${key}`, body) }
  async getObject(bucket: string, key: string): Promise<Buffer | undefined> { return this.objects.get(`${bucket}/${key}`) }
}

test('S3ObjectBackend stores content-addressed under a prefix and round-trips', async () => {
  const s3 = new FakeS3()
  const store = new CanonicalObjectStore(new S3ObjectBackend(s3, 'tenant-bucket', 'hg/'))
  const entry = await ingest(store)

  // The blob landed in the customer bucket, keyed by content hash under the prefix.
  assert.ok(s3.objects.has(`tenant-bucket/hg/${entry.contentHash}`), 'stored at <bucket>/<prefix><sha256>')
  assert.equal((await store.get('doc1'))?.content, 'the open gate', 'round-trips through S3')
  assert.equal((await store.verify('doc1')).class, 'INTACT', 'integrity holds over S3')

  // Same content dedupes to the same key.
  const s2 = new CanonicalObjectStore(new S3ObjectBackend(s3, 'tenant-bucket', 'hg/'))
  const dup = await s2.ingest('doc2', 'the open gate', { mime: 'text/plain', residency: 'EU' })
  assert.equal(dup.contentHash, entry.contentHash, 'identical bytes → identical content-address (dedup)')
})
