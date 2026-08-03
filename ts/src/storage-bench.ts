/**
 * storage-bench — a performance + integrity benchmark harness for storage / DB backends,
 * aligned to the SocioProphet storage standard (evidence-first: a number is only a claim if it is
 * backed by a reproducible record).
 *
 * It measures any `ObjectBackend` (InMemory / S3-BYOS / RocksDB / …) on the operations a
 * content-addressed store actually performs — put, get, and verify (get + re-hash) — reporting
 * latency percentiles and throughput. Integrity is a FIRST-CLASS result, not a footnote: if a
 * round-tripped blob does not byte-match, or its content hash does not re-derive, the run is a
 * FAILURE. A fast backend that returns the wrong bytes fails here; that is the point.
 *
 * `toEvaluationRecord` emits a record conforming to
 * SocioProphet/socioprophet-standards-storage `standards/evaluation-record-standard.v1.md`
 * (subject_type=platform_capability, attempt_mode=benchmark_run) so a result is storable,
 * reviewable, and regression-checkable — never a bare number.
 */
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ObjectBackend } from './object-store.js'

export interface StorageBenchConfig {
  backend_id: string
  n_ops: number
  payload_bytes: number
  /** deterministic seed so a run is reproducible (the storage standard requires it) */
  seed?: number
}

export interface LatencyStats {
  p50_ms: number
  p95_ms: number
  p99_ms: number
  max_ms: number
  mean_ms: number
}

export interface OpResult {
  op: 'put' | 'get' | 'verify'
  count: number
  failures: number
  latency: LatencyStats
  throughput_ops_s: number
  throughput_mb_s: number
}

export interface StorageBenchResult {
  backend_id: string
  config: StorageBenchConfig
  ops: OpResult[]
  integrity_verified: number
  integrity_failures: number
  /** fail-closed: any integrity failure (or op failure) makes the whole run a failure */
  result: 'pass' | 'fail'
  started_at: string
  finished_at: string
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Deterministic pseudo-random bytes from a seed, so a run reproduces exactly. */
function seededPayload(seed: number, i: number, size: number): Buffer {
  const out = Buffer.allocUnsafe(size)
  let x = (seed ^ (i * 2654435761)) >>> 0
  for (let j = 0; j < size; j++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[j] = x & 0xff
  }
  return out
}

function stats(samples: number[]): LatencyStats {
  if (!samples.length) return { p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0, mean_ms: 0 }
  const s = [...samples].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
  return {
    p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), max_ms: s[s.length - 1],
    mean_ms: samples.reduce((a, b) => a + b, 0) / samples.length,
  }
}

function opResult(op: OpResult['op'], lat: number[], failures: number, bytesEach: number): OpResult {
  const totalMs = lat.reduce((a, b) => a + b, 0) || 1
  return {
    op,
    count: lat.length,
    failures,
    latency: stats(lat),
    throughput_ops_s: (lat.length / totalMs) * 1000,
    throughput_mb_s: ((lat.length * bytesEach) / (1024 * 1024) / totalMs) * 1000,
  }
}

/**
 * Benchmark an ObjectBackend over `n_ops` content-addressed blobs: put, then get, then verify
 * (re-hash the retrieved bytes). Deterministic given `seed`. Fail-closed on any integrity mismatch.
 */
export async function benchObjectBackend(
  backend: ObjectBackend,
  config: StorageBenchConfig,
): Promise<StorageBenchResult> {
  const seed = config.seed ?? 0x5010
  const started_at = new Date().toISOString()
  const hashes: string[] = []
  const putLat: number[] = []
  const getLat: number[] = []
  const verLat: number[] = []
  let putFail = 0, getFail = 0
  let integrity_verified = 0, integrity_failures = 0

  for (let i = 0; i < config.n_ops; i++) {
    const bytes = seededPayload(seed, i, config.payload_bytes)
    const hash = sha256(bytes)
    hashes.push(hash)
    const t0 = performance.now()
    try { await backend.put(hash, bytes) } catch { putFail++ }
    putLat.push(performance.now() - t0)
  }

  for (let i = 0; i < hashes.length; i++) {
    const expected = seededPayload(seed, i, config.payload_bytes)
    const t0 = performance.now()
    let got: Buffer | undefined
    try { got = await backend.get(hashes[i]!) } catch { got = undefined }
    getLat.push(performance.now() - t0)
    if (!got) { getFail++; continue }

    // verify: bytes round-trip AND the content hash re-derives (content-addressing holds).
    const tv = performance.now()
    const rehash = sha256(got)
    verLat.push(performance.now() - tv)
    if (rehash === hashes[i] && got.equals(expected)) integrity_verified++
    else integrity_failures++
  }

  const opFailures = putFail + getFail
  const finished_at = new Date().toISOString()
  return {
    backend_id: config.backend_id,
    config: { ...config, seed },
    ops: [
      opResult('put', putLat, putFail, config.payload_bytes),
      opResult('get', getLat, getFail, config.payload_bytes),
      opResult('verify', verLat, 0, config.payload_bytes),
    ],
    integrity_verified,
    integrity_failures,
    result: integrity_failures === 0 && opFailures === 0 && integrity_verified === config.n_ops ? 'pass' : 'fail',
    started_at,
    finished_at,
  }
}

// ── SocioProphet storage-standard EvaluationRecord (evaluation-record-standard.v1) ──────────────

export interface EvaluationRecord {
  id: string
  evaluation_track_ref: string
  subject_ref: string
  subject_type: 'platform_capability'
  attempt_refs: { id: string; attempt_mode: 'benchmark_run'; measurements: StorageBenchResult }[]
  metric_refs: string[]
  result_summary: string
  result: 'pass' | 'pass_with_findings' | 'remediation_required' | 'fail' | 'blocked' | 'unknown'
  evidence_bundle_ref: string
  review_state: 'draft'
  created_at: string
  updated_at: string
}

/** Wrap a bench result as a storage-standard EvaluationRecord (evidence-first, regression-checkable). */
export function toEvaluationRecord(
  r: StorageBenchResult,
  opts: { subject_ref: string; evaluation_track_ref: string },
): EvaluationRecord {
  const put = r.ops.find((o) => o.op === 'put')!
  const get = r.ops.find((o) => o.op === 'get')!
  const now = new Date().toISOString()
  return {
    id: `evalrec:storage-bench:${r.backend_id}:${r.started_at}`,
    evaluation_track_ref: opts.evaluation_track_ref,
    subject_ref: opts.subject_ref,
    subject_type: 'platform_capability',
    attempt_refs: [{ id: `attempt:${r.backend_id}:${r.started_at}`, attempt_mode: 'benchmark_run', measurements: r }],
    metric_refs: ['put.p95_ms', 'get.p95_ms', 'put.throughput_mb_s', 'integrity_verified'],
    result_summary:
      `${r.backend_id}: ${r.config.n_ops}×${r.config.payload_bytes}B — ` +
      `put p95 ${put.latency.p95_ms.toFixed(3)}ms, get p95 ${get.latency.p95_ms.toFixed(3)}ms, ` +
      `integrity ${r.integrity_verified}/${r.config.n_ops}`,
    result: r.result === 'pass' ? 'pass' : 'fail',
    evidence_bundle_ref: `evidence:storage-bench:${r.backend_id}:${r.started_at}`,
    review_state: 'draft',
    created_at: r.started_at,
    updated_at: now,
  }
}
