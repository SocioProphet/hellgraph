import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { ingestEdgeRecord } from './cskg-ingest'
import {
  ROUTE_HANDLES, putEdge, getEdge, deleteEdge, resolveSameAs, commitSnapshot,
} from './cskg-surface'

function seed(): AtomSpace {
  const as = new AtomSpace('cskg-surface', false)
  ingestEdgeRecord(as, { id: 'e1', node1: '/c/en/rain', relation: '/r/IsA', node2: '/c/en/weather_event', sources: ['CN'] })
  ingestEdgeRecord(as, { id: 'e2', node1: '/c/en/rain', relation: 'mw:SameAs', node2: 'wn:rain.n.01', sources: ['WN'] })
  ingestEdgeRecord(as, { id: 'e3', node1: 'wn:rain.n.01', relation: 'mw:SameAs', node2: 'Q7907', sources: ['WD'] })
  return as
}

test('route handles match the spec (19/20/23/24)', () => {
  assert.deepEqual(ROUTE_HANDLES, { GetEdge: 19, DeleteEdge: 20, ResolveSameAs: 23, CommitSnapshot: 24 })
})

test('GetEdge by id and by triple', () => {
  const as = seed()
  assert.equal(getEdge(as, { id: 'e1' })?.node2, '/c/en/weather_event')
  assert.equal(getEdge(as, { node1: '/c/en/rain', relation: '/r/IsA', node2: '/c/en/weather_event' })?.id, 'e1')
  assert.equal(getEdge(as, { id: 'nope' }), null)
})

test('PutEdge upserts and is retrievable', () => {
  const as = seed()
  const { edgeId } = putEdge(as, { id: 'e9', node1: '/c/en/dog', relation: '/r/IsA', node2: '/c/en/animal' })
  assert.equal(edgeId, 'e9')
  assert.equal(getEdge(as, { id: 'e9' })?.node1, '/c/en/dog')
})

// ─── DeleteEdge → semantic.commit.v1 (erase-iso) ────────────────────────────────

test('DeleteEdge tombstones and closes with semantic.commit.v1', () => {
  const as = seed()
  const { result, commit } = deleteEdge(as, { id: 'e1' })
  assert.equal(result.tombstoned, true)
  assert.equal(getEdge(as, { id: 'e1' }), null)                 // logically gone
  assert.ok(commit)
  assert.equal(commit!.kind, 'semantic.commit.v1')
  assert.equal(commit!.commitKind, 'tombstone')
  assert.equal(commit!.subjectId, 'e1')
  assert.match(commit!.receiptHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(commit!.policyAttestation, undefined)           // not authoritative
})

test('authoritative DeleteEdge attaches policy_attestation_v1 (signed when a signer is given)', () => {
  const as = seed()
  const { commit } = deleteEdge(as, { id: 'e1', commitKind: 'invalidate', authoritative: true },
    { attest: (b) => ({ signer: 'did:key:zTest', signature: 'sig:' + b.length }) })
  assert.equal(commit!.commitKind, 'invalidate')
  assert.ok(commit!.policyAttestation)
  assert.equal(commit!.policyAttestation!.kind, 'policy.attestation.v1')
  assert.equal(commit!.policyAttestation!.signer, 'did:key:zTest')
  assert.match(commit!.policyAttestation!.attestationHash, /^sha256:/)
})

test('DeleteEdge on a missing/already-tombstoned edge is a no-op', () => {
  const as = seed()
  deleteEdge(as, { id: 'e1' })
  const again = deleteEdge(as, { id: 'e1' })
  assert.equal(again.result.found, false)
  assert.equal(again.commit, undefined)
})

// ─── ResolveSameAs ──────────────────────────────────────────────────────────────

test('ResolveSameAs consolidates the mw:SameAs equivalence set', () => {
  const as = seed()
  const r = resolveSameAs(as, { nodeId: '/c/en/rain' })
  // members: /c/en/rain, wn:rain.n.01, Q7907 → canonical = byte-smallest
  assert.deepEqual([r.canonical, ...r.aliases].sort(), ['/c/en/rain', 'Q7907', 'wn:rain.n.01'].sort())
  assert.equal(r.canonical, '/c/en/rain')          // '/' (0x2f) sorts before 'Q'/'w'
  assert.ok(r.evidence.some((e) => e.edgeId === 'e2') && r.evidence.some((e) => e.edgeId === 'e3'))
})

test('ResolveSameAs on an isolated node returns just itself', () => {
  const as = seed()
  const r = resolveSameAs(as, { nodeId: '/c/en/weather_event' })
  assert.equal(r.canonical, '/c/en/weather_event')
  assert.deepEqual(r.aliases, [])
})

// ─── CommitSnapshot → replay-anchor ─────────────────────────────────────────────

test('CommitSnapshot freezes a deterministic manifest + replay-anchor commit', () => {
  const as = seed()
  const a = commitSnapshot(as, { snapshotId: 'snap-1', datasetVersion: 'v1' })
  assert.equal(a.result.edgeCount, 3)
  assert.match(a.result.manifestDigest, /^sha256:/)
  assert.equal(a.commit.commitKind, 'replay_anchor')
  assert.ok(a.commit.policyAttestation)             // snapshot always attests
  // deterministic: same state → same manifest digest
  const b = commitSnapshot(as, { snapshotId: 'snap-1', datasetVersion: 'v1' })
  assert.equal(b.result.manifestDigest, a.result.manifestDigest)
})

test('CommitSnapshot excludes tombstoned edges and reflects the cut', () => {
  const as = seed()
  const before = commitSnapshot(as, { snapshotId: 's' }).result
  deleteEdge(as, { id: 'e1' })
  const after = commitSnapshot(as, { snapshotId: 's' }).result
  assert.equal(after.edgeCount, before.edgeCount - 1)
  assert.notEqual(after.manifestDigest, before.manifestDigest)
  assert.ok(after.cut >= before.cut)                // logical clock advanced by the tombstone write
})
