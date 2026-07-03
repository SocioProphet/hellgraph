import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalObjectStore } from './object-store.js'
import { decide } from './policy.js'

const ingest = (s: CanonicalObjectStore) =>
  s.ingest('doc1', 'the open gate', { mime: 'text/plain', residency: 'EU', sensitiveFields: ['$.phones.home'], division: 42 })

test('ingest seals codex + catalogs; stored content re-verifies INTACT', () => {
  const store = new CanonicalObjectStore()
  const entry = ingest(store)
  assert.equal(entry.version, 1)
  assert.equal(entry.state, 'Normalized')
  assert.equal(entry.codex.gematria, 116, 'codex sealed at ingest')
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/)

  const v = store.verify('doc1')
  assert.equal(v.class, 'INTACT')
  assert.equal(v.verdict, 'POS')
})

test('integrity-at-rest: external drift is detected and classified', () => {
  const store = new CanonicalObjectStore()
  ingest(store)
  const drift = store.verify('doc1', 'the open gaze') // substitution
  assert.equal(drift.class, 'substitution')
  assert.equal(drift.verdict, 'NEG')
})

test('versioning: new version bumps + re-seals; current version verifies against its own seal', () => {
  const store = new CanonicalObjectStore()
  const v1 = ingest(store)
  const v2 = store.newVersion('doc1', 'the open gate now')
  assert.equal(v2.version, 2)
  assert.notEqual(v2.contentHash, v1.contentHash, 'new bytes → new hash')
  assert.notEqual(v2.codex._sha256, v1.codex._sha256, 'new content → new codex seal')
  assert.equal(store.verify('doc1').class, 'INTACT', 'current version verifies against its own seal')
})

test('provenance travels: derived artifact carries canonical id + version + codex + cut', () => {
  const store = new CanonicalObjectStore()
  const entry = ingest(store)
  const cut = { aaaa: 3, bbbb: 1 }
  const prov = store.provenanceOf('doc1', cut)
  assert.equal(prov.canonicalId, 'doc1')
  assert.equal(prov.version, 1)
  assert.equal(prov.contentHash, entry.contentHash)
  assert.equal(prov.codexSha, entry.codex._sha256)
  assert.deepEqual(prov.cut, cut, 'causal frame (spec 09) carried into the derived path')
})

test('catalog bridges to the policy engine (L1 → L5): residency + sensitivity flow through', () => {
  const store = new CanonicalObjectStore()
  store.setState('missing', 'Served') // no-op, no throw
  ingest(store)
  store.setState('doc1', 'Served')

  const obj = store.toPolicyObject('doc1')
  assert.equal(obj.residency, 'EU')
  assert.deepEqual(obj.sensitiveFields, ['$.phones.home'])

  // Egress of this canonical object to a vendor is default-deny (not opted in).
  const d = decide({ action: 'egress', object: obj, target: { kind: 'vendor' } })
  assert.equal(d.effect, 'deny')
})

test('get returns the stored canonical bytes', () => {
  const store = new CanonicalObjectStore()
  ingest(store)
  assert.equal(store.get('doc1')?.content, 'the open gate')
})
