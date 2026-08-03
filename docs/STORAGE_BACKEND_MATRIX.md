# Storage & DB backend matrix

A selection of storage / DB backends and their properties — the estate's own backends first, then the
external field for context. The dimensions are **the SocioProphet storage-standard properties**, not a
generic feature list: content-addressing, provenance, integrity-at-rest, fault tolerance, and
sovereignty are what the standard load-bears on. `(✓)` = supported via an adapter / optional dependency.

> Measure it or don't claim it. Perf numbers for any row belong in a reproducible **EvaluationRecord**
> (SocioProphet/socioprophet-standards-storage `evaluation-record-standard.v1`), produced by
> `ts/src/storage-bench.ts` — never inline in this table.

## Estate backends

| Backend | Model | Content-addressed | Provenance-stamped | Integrity-at-rest | Fault tolerance | Sovereign / BYOS | In-memory | Distributed | Fail-closed verify |
|---|---|---|---|---|---|---|---|---|---|
| `InMemoryObjectBackend` | blob KV | ✓ (sha256 key) | (via store) | (via codex) | – | – | ✓ | – | ✓ (bench) |
| `CanonicalObjectStore` | content-addressed object store | ✓ | ✓ (`ObjectProvenance`) | ✓ (**codex-seal** at ingest) | (backend) | (backend) | (backend) | (backend) | ✓ (`verify → Syndrome`) |
| `S3ObjectBackend` (BYOS) | object store on S3/MinIO | ✓ | (via store) | (via codex) | ✓ (S3/MinIO) | ✓ (customer holds bytes) | – | ✓ | ✓ (bench) |
| `RocksDBBackend` | embedded LSM KV (AtomSpace WAL) | ✓ (atom handle) | ✓ (log entry) | ✓ (replay) | ✓ (WAL) | ✓ (local-first) | (cache) | – | ✓ |
| `HypercoreBackend` | signed append-only log | ✓ | ✓ (signed) | ✓ (merkle) | ✓ (replicated) | ✓ (per-writer keys) | – | ✓ (Autobase) | ✓ |
| `AtomSpace` (metagraph) | typed hypergraph, PLN truth | ✓ (structural hash) | ✓ (Values) | ✓ (codex sealer) | (backend) | ✓ | ✓ | (super-peer) | ✓ |
| `FederatedAtomSpace` | Autobase-merged sovereign logs | ✓ | ✓ (per-op writer+seq) | ✓ (causal-cut proof) | ✓ (multi-writer) | ✓ (federation) | – | ✓ | ✓ (proof withholds) |

## External field (context)

| Backend | Model | Content-addressed | Provenance | Fault tolerance | In-memory | Distributed | Language |
|---|---|---|---|---|---|---|---|
| RocksDB | embedded LSM KV | – | – | ✓ (WAL) | (cache) | – | C++ |
| Neo4j | property graph | – | – | ✓ | (cache) | ✓ | Java |
| Kùzu | embedded graph | – | – | ✓ | ✓ | – | C++ |
| Redis | in-memory KV | – | – | (✓) | ✓ | ✓ | C |
| S3 / MinIO | object store | (by key) | – | ✓ | – | ✓ | Go / — |
| Postgres | relational | – | – | ✓ | (cache) | (✓) | C |
| IPFS | content-addressed | ✓ | – | ✓ | – | ✓ | Go |

## What the estate adds over the field

The standard-aligned columns are exactly where the estate backends differ from the external field:
**content-addressing + provenance + integrity-at-rest (codex-seal) + causal-cut proof** are first-class,
not bolt-ons. A backend that returns the wrong bytes fast is a *failure* here — see the fail-closed
integrity check in `storage-bench.ts` (a corrupting/losing backend fails the run, proven both ways in
`storage-bench.test.ts`).

## Running the benchmark

```ts
import { InMemoryObjectBackend } from './object-store.js'
import { benchObjectBackend, toEvaluationRecord } from './storage-bench.js'

const result = await benchObjectBackend(new InMemoryObjectBackend(),
  { backend_id: 'in-memory', n_ops: 10_000, payload_bytes: 4096, seed: 42 })

// store as evidence — a number is only a claim if it is backed by a reproducible record.
const record = toEvaluationRecord(result, {
  subject_ref: 'hellgraph:CanonicalObjectStore',
  evaluation_track_ref: 'track:storage-backend-perf.v1',
})
```

The `EvaluationRecord` conforms to SocioProphet/socioprophet-standards-storage
`standards/evaluation-record-standard.v1` (`subject_type: platform_capability`,
`attempt_mode: benchmark_run`), carrying the raw measurements as evidence so results are storable,
reviewable, and regression-checkable across epochs.
