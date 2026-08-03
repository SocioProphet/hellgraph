import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryObjectBackend, type ObjectBackend } from './object-store.js'
import { benchObjectBackend, toEvaluationRecord } from './storage-bench.js'

const CFG = { backend_id: 'in-memory', n_ops: 64, payload_bytes: 256, seed: 42 }

test('a correct backend passes with full integrity + populated latency/throughput', async () => {
  const r = await benchObjectBackend(new InMemoryObjectBackend(), CFG)
  assert.equal(r.result, 'pass')
  assert.equal(r.integrity_verified, CFG.n_ops)
  assert.equal(r.integrity_failures, 0)
  const put = r.ops.find((o) => o.op === 'put')!
  assert.equal(put.count, CFG.n_ops)
  assert.ok(put.latency.p95_ms >= put.latency.p50_ms)      // percentiles ordered
  assert.ok(put.throughput_ops_s > 0 && put.throughput_mb_s > 0)
})

test('the run is deterministic for a fixed seed (reproducible — the standard requires it)', async () => {
  const a = await benchObjectBackend(new InMemoryObjectBackend(), CFG)
  const b = await benchObjectBackend(new InMemoryObjectBackend(), CFG)
  assert.equal(a.integrity_verified, b.integrity_verified)
  assert.equal(a.result, b.result)
})

// a fast liar: stores nothing and returns wrong bytes. It MUST fail the bench.
class CorruptingBackend implements ObjectBackend {
  async put(): Promise<void> {}
  async get(): Promise<Buffer> { return Buffer.from('not the bytes you stored') }
}

test('a backend that returns the wrong bytes FAILS (integrity is first-class, teeth both ways)', async () => {
  const r = await benchObjectBackend(new CorruptingBackend(), CFG)
  assert.equal(r.result, 'fail')
  assert.ok(r.integrity_failures > 0)
  assert.equal(r.integrity_verified, 0)
})

// a backend that loses data (get returns undefined) is also a failure, counted as a get failure.
class LosingBackend implements ObjectBackend {
  async put(): Promise<void> {}
  async get(): Promise<Buffer | undefined> { return undefined }
}

test('a backend that loses data FAILS (missing blob is not a silent pass)', async () => {
  const r = await benchObjectBackend(new LosingBackend(), CFG)
  assert.equal(r.result, 'fail')
  const get = r.ops.find((o) => o.op === 'get')!
  assert.equal(get.failures, CFG.n_ops)
})

test('toEvaluationRecord conforms to the storage standard shape', async () => {
  const r = await benchObjectBackend(new InMemoryObjectBackend(), CFG)
  const rec = toEvaluationRecord(r, {
    subject_ref: 'hellgraph:InMemoryObjectBackend',
    evaluation_track_ref: 'track:storage-backend-perf.v1',
  })
  assert.equal(rec.subject_type, 'platform_capability')
  assert.equal(rec.attempt_refs[0]!.attempt_mode, 'benchmark_run')
  assert.ok(['pass', 'fail'].includes(rec.result))
  assert.equal(rec.review_state, 'draft')
  for (const k of ['id', 'evaluation_track_ref', 'subject_ref', 'evidence_bundle_ref', 'created_at', 'updated_at'])
    assert.ok((rec as Record<string, unknown>)[k], `missing required field ${k}`)
  // the raw, reproducible measurements are carried as evidence (no bare numbers).
  assert.equal(rec.attempt_refs[0]!.measurements.integrity_verified, CFG.n_ops)
})
