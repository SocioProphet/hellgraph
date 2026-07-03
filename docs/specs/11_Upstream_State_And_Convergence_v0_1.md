# HellGraph Upstream State and Convergence Specification v0.1

## Status

Draft implementation specification.

This document supersedes older HellGraph planning that treated the repository as only a Rust local-first graph kernel scaffold. Current upstream is materially further along and must be treated as a polyglot graph engine with a TypeScript reference surface and a Rust convergence/kernel surface.

## Executive correction

The current product boundary is not merely:

```text
Rust kernel -> future RDF bridge -> future query facade
```

The current upstream boundary is:

```text
TypeScript OpenCog-compatible AtomSpace/metagraph engine
  + PLN
  + ECAN
  + pattern matcher
  + SPARQL subset
  + Gremlin subset
  + SHACL
  + Turtle
  + Atomese
  + ingestion
  + semantic/vector pipeline
  + brain import/export
  + sidecar bridge
  + StorageNode / RocksDB-style persistence edge
  + cogserver / health / ACR modules

Rust kernel and analytics crates
  + core atom/value families
  + field/proof/runtime/read kernel
  + deterministic analytics: PageRank, warm-start PageRank, Brandes betweenness, Louvain
```

Therefore, the correct next phase is not greenfield construction. It is convergence, conformance, hardening, and service parity.

## Repository identity

Repository:

```text
SocioProphet/hellgraph
```

Current repository role:

```text
polyglot HellGraph engine
```

The repository contains both:

- a TypeScript package: `@socioprophet/hellgraph`
- a Rust workspace: `hg_*` crates

## Current upstream inventory

### Root package

`package.json` declares:

```text
name: @socioprophet/hellgraph
version: 0.4.2
description: HellGraph — TypeScript OpenCog-compatible AtomSpace metagraph engine (PLN, ECAN, pattern matcher, SPARQL/Gremlin, SHACL, Atomese, StorageNode federation). Polyglot sibling of the Rust hellgraph crate.
```

Current package scripts:

```text
build: tsup
prepare: tsup
typecheck: tsc -p ts/tsconfig.json --noEmit
test: node --import tsx --test ts/src/*.test.ts
```

Current package issue:

```text
package.json says UNLICENSED, while repository root has an MIT LICENSE.
```

This must be resolved before external release, registry publication, customer demo, or enterprise distribution.

### TypeScript public API

`ts/src/index.ts` exports:

```text
atomspace
store
types
pln
ecan
patternMatcher
sparql
gremlin
shacl
turtle
atomese
consolidate
ingest
semantic
prometheus
sidecar
storage-client
cogserver
health
acr
rocksdb-backend
```

This is now the broad feature surface and should be treated as the reference implementation for high-level capabilities.

### TypeScript engine surface

The TypeScript engine currently includes:

- content-addressed AtomSpace
- TruthValues for PLN
- ECAN AttentionValues
- pluggable backend
- HellGraph property graph store
- PLN forward-chaining
- ECAN attention allocation
- pattern matcher
- SPARQL subset evaluator
- Gremlin/TinkerPop-style traversal engine
- SHACL validation
- Turtle parse/serialize
- Atomese projection
- consolidation
- ingestion
- Prometheus symbolic-regression hooks
- sidecar bridge
- StorageNode client
- RocksDB backend
- semantic vectorization pipeline
- brain import/export
- cogserver hooks
- health checks
- ACR module

### Rust workspace

Current root `Cargo.toml` workspace members:

```text
crates/hg_core
crates/hg_fieldpack
crates/hg_proof
crates/hg_kernel
crates/hg_runtime
crates/hg_read_kernel
crates/hg_analytics
```

The Rust surface is no longer only kernel scaffolding. It now includes a deterministic analytics crate.

### Rust analytics surface

`hg_analytics` currently implements:

- cold PageRank
- warm-start PageRank
- AtomId-facing PageRank wrapper
- exact Brandes betweenness centrality
- deterministic Louvain community detection

Product invariant:

```text
determinism is a hard product property
```

All analytics implementations should remain deterministic for fixed graph snapshot and parameters.

## Stale documentation audit

The root README is now stale in two ways.

### Stale claim 1 — SPARQL not implemented

README says:

```text
RDF-star/SPARQL bridge is specified but not implemented
```

Correction:

```text
The TypeScript engine implements a focused SPARQL 1.1 subset over the HellGraph triple projection. Rust-native SPARQL and RDF-star projection remain open.
```

### Stale claim 2 — query facade not implemented

README says:

```text
Cypher/GQL-shaped facade is specified but not implemented
```

Correction:

```text
The TypeScript engine implements a Gremlin/TinkerPop-style traversal surface and textual parser. Cypher/GQL remains open unless implemented separately.
```

### Stale claim 3 — vector/semantic retrieval is eventual

README says:

```text
eventual vector/semantic retrieval bindings
```

Correction:

```text
The TypeScript engine already implements semantic chunking, embedding, vector storage on DocumentChunk atoms, cosine semantic search, and brain import/export. Rust-native/vector-index hardening remains open.
```

### Stale claim 4 — Rust-only development posture

README only names Rust commands.

Correction:

```text
Development must include both Rust and TypeScript gates:

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm test
npm run build
```

## Architecture doctrine

HellGraph now has two active implementation planes.

### Plane A — TypeScript reference engine

Purpose:

```text
feature-complete reference surface for Noetica, platform consumers, graph reasoning, semantic search, and rapid product integration
```

Responsibilities:

- AtomSpace compatibility
- PLN/ECAN semantics
- SPARQL subset
- Gremlin subset
- SHACL/Turtle/Atomese
- ingestion and consolidation
- semantic vectors and brain import/export
- sidecar bridge
- StorageNode/RocksDB-compatible persistence path
- service-adjacent modules

### Plane B — Rust deterministic kernel

Purpose:

```text
deterministic, auditable, replayable, local-first kernel and performance-critical analytics destination
```

Responsibilities:

- typed atoms and value families
- field/proof/runtime cycle
- append-only valuation semantics
- journal/checkpoint/replay
- read-side kernel
- deterministic analytics
- eventual Rust-native query/projection/service kernels

### Convergence rule

TypeScript is the product/reference surface today.
Rust is the deterministic convergence and hardening destination.

Do not delete or demote the TypeScript engine. Do not pretend Rust already covers the TypeScript surface. Instead, maintain a parity ledger.

## TS-to-Rust parity ledger

| Capability | TypeScript status | Rust status | Required next move |
|---|---:|---:|---|
| AtomSpace | implemented | partial/native atom model | map AtomSpace atoms to Rust Atom/Link/Valuation model |
| TruthValues | implemented | partial TruthValue in hg_core | define semantic equivalence tests |
| ECAN AttentionValues | implemented | ActivationValue only | port ECAN or define activation compatibility boundary |
| PLN forward-chaining | implemented | not implemented | create Rust `hg_reasoning` or keep TS as reasoning reference |
| Pattern matcher | implemented | not implemented | define shared pattern IR before port |
| SPARQL subset | implemented | not implemented | create Rust `hg_sparql` only after RDF projection is pinned |
| Gremlin subset | implemented | not implemented | create Rust `hg_gremlin` or expose TS service first |
| SHACL | implemented | not implemented | define validation API and conformance fixtures |
| Turtle | implemented | not implemented | decide whether Rust uses external RDF parser or ports subset |
| Atomese | implemented | not implemented | define Atomese compatibility contract |
| Ingestion | implemented | partial semantic pipeline | formalize ingest job model |
| Semantic vectors | implemented | not implemented | create Rust vector binding types and conformance fixtures |
| Brain import/export | implemented | not implemented | define stable JSONL brain shard schema |
| RocksDB backend | implemented | not implemented in Rust workspace | decide storage substrate convergence path |
| StorageNode client | implemented | not implemented | define federation boundary |
| Cogserver | implemented | not implemented | decide service API replacement path |
| Health | implemented | not implemented | add service health contract |
| ACR | implemented | not mapped | document ACR semantics |
| PageRank | likely TS reference + Rust implemented | implemented | conformance against TS reference |
| Betweenness | TS reference + Rust implemented | implemented | conformance against TS reference |
| Louvain | TS reference + Rust implemented | implemented | conformance against TS reference |

## Neptune parity matrix

HellGraph parity must now be measured against three target surfaces.

### Neptune Database-style surface

| Capability | Current HellGraph status | Next move |
|---|---:|---|
| RDF/SPARQL | TS SPARQL subset exists | add conformance fixtures and RDF import/export matrix |
| Gremlin/TinkerPop | TS Gremlin subset exists | add traversal conformance fixtures and service endpoint |
| openCypher | not confirmed | decide whether to build or defer behind Gremlin/SPARQL |
| bulk loader | ingestion exists | formalize loader job API, status, cancel, reports |
| streams/change log | not confirmed | define commit stream API and retention semantics |
| Data API | partial service modules exist | define HTTP API contract around query/load/stream/status |
| backup/restore | not confirmed | add storage backup/restore contract |
| auth/IAM | not confirmed | add OIDC/JWT first; SigV4 optional |
| encryption | not confirmed | storage and transport security spec |
| metrics | Prometheus hooks exist | normalize metrics surface |
| replicas/read scaling | not implemented | future managed mode |

### Neptune Analytics-style surface

| Capability | Current HellGraph status | Next move |
|---|---:|---|
| PageRank | Rust implemented with warm-start | expose via procedure/API |
| Betweenness | Rust implemented | expose via procedure/API |
| Louvain/community | Rust implemented | expose via procedure/API |
| Similarity algorithms | not confirmed | add Jaccard/overlap/common-neighbor |
| Pathfinding | not confirmed | add BFS/shortest path/top-k path |
| Degree distribution | not confirmed | add graph summary/statistics |
| Vector search in graph | TS semantic search exists | define graph+vector query contract |
| openCypher CALL | not confirmed | define procedure invocation boundary |

### Neptune ML / GraphRAG surface

| Capability | Current HellGraph status | Next move |
|---|---:|---|
| semantic chunking | TS implemented | freeze schema |
| embedding | TS implemented, local Ollama default | define embedder provenance |
| vector storage | TS stores vectors on DocumentChunk atoms | define stable vector binding type |
| semantic search | TS cosine search implemented | add benchmarks and hybrid filters |
| brain import/export | TS implemented | freeze JSONL brain shard schema |
| link prediction | not confirmed | add ML job model |
| node/edge classification/regression | not confirmed | add candidate valuation model |
| model provenance | partial/not confirmed | define ML artifact/provenance contract |

## Blazegraph compatibility matrix

Blazegraph is no longer the product boundary. It is the RDF/SPARQL oracle and migration reference.

| Area | Required HellGraph behavior |
|---|---|
| RDF import | load RDF fixtures into HellGraph projection model |
| RDF export | export HellGraph RDF projection to standard formats |
| SPARQL BGP | compare TS SPARQL results to fixture/oracle outputs |
| FILTER | compare supported filter behavior |
| OPTIONAL | compare left-join behavior |
| ORDER/LIMIT/OFFSET | compare result ordering where deterministic |
| CONSTRUCT | compare generated triples |
| named graphs | specify current support or explicit non-support |
| RDF-star | Rust/spec-only unless TS supports it; must be explicit |
| update semantics | defer unless implemented |

Public claim rule:

```text
HellGraph supports a focused SPARQL subset today through the TS engine. Blazegraph-level compatibility is a conformance target, not a completed claim.
```

## OpenCog / AtomSpace compatibility matrix

HellGraph is now explicitly OpenCog-compatible in the TS package description and README.

Required compatibility contract:

- content-addressed atom identity
- AtomSpace node/link semantics
- TruthValue semantics
- AttentionValue / ECAN semantics
- PLN inference semantics
- Atomese projection
- StorageNode-compatible persistence/federation boundary

Open issue:

```text
Decide whether Rust kernel becomes an AtomSpace-compatible backend, a separate native kernel with projection, or both.
```

Recommended answer:

```text
Both. Rust should expose a native kernel and an AtomSpace compatibility adapter. TS remains the high-level reference engine until Rust reaches parity.
```

## Public claim boundaries

Allowed claims today:

- HellGraph is a polyglot graph engine.
- HellGraph includes a TypeScript OpenCog-compatible AtomSpace/metagraph engine.
- HellGraph includes PLN, ECAN, SPARQL subset, Gremlin subset, SHACL, Turtle, Atomese, ingestion, semantic vector search, and StorageNode federation surfaces in TypeScript.
- HellGraph includes a Rust local-first kernel/runtime scaffold.
- HellGraph includes deterministic Rust graph analytics for PageRank, warm-start PageRank, betweenness, and Louvain.
- HellGraph targets Neptune-style graph database and graph analytics parity.
- Blazegraph is an RDF/SPARQL oracle and compatibility reference.

Forbidden or premature claims:

- full Neptune replacement
- full Blazegraph replacement
- full SPARQL 1.1 compatibility
- full Gremlin/TinkerPop compatibility
- full openCypher/GQL support
- production HA database
- production security/compliance posture
- Rust parity with TS engine
- RDF-star bridge completed unless explicitly implemented

## Release blockers

### Blocker 1 — license contradiction

`package.json` says `UNLICENSED`; root repository has MIT license.

Resolution options:

1. Set package license to MIT, if intended.
2. Keep package private/unpublished and document why.
3. Split package/license policy by workspace and publish explicit `LICENSES.md`.

Recommended:

```text
Set package.json license to MIT only if all TS code is intended to follow repository MIT license. Otherwise add LICENSES.md and package publication guardrails.
```

### Blocker 2 — root README stale

Root README must be updated to reflect the polyglot engine.

Required new README sections:

- TypeScript engine
- Rust workspace
- Current implemented surfaces
- TS vs Rust convergence
- Query surfaces
- Semantic/vector surface
- Analytics surface
- Known limitations

### Blocker 3 — CI incomplete for polyglot repo

CI must include:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm ci
npm run typecheck
npm test
npm run build
```

### Blocker 4 — no formal parity ledger

This file starts the parity ledger. It must become test-backed.

### Blocker 5 — conformance missing

Need fixtures for:

- SPARQL subset
- Gremlin subset
- SHACL
- Turtle
- semantic search
- brain import/export
- analytics deterministic outputs
- TS/Rust analytics parity

## Immediate execution plan

### PR A — documentation correction

Files:

- `README.md`
- `package.json`
- `docs/specs/08_UPSTREAM_STATE_AND_CONVERGENCE_SPEC.md`

Actions:

- update README to polyglot state
- resolve or document license contradiction
- add this spec

### PR B — CI correction

Files:

- `.github/workflows/ci.yml`

Actions:

- add Node/TS build, typecheck, tests
- retain Rust checks
- add docs guardrails that prevent stale README claims

### PR C — conformance fixtures

Files:

- `fixtures/sparql/`
- `fixtures/gremlin/`
- `fixtures/semantic/`
- `fixtures/analytics/`
- `fixtures/brain/`
- `tests/conformance/`

Actions:

- prove supported query claims
- prove semantic import/export behavior
- prove analytics determinism

### PR D — Neptune parity tracker

Files:

- `docs/specs/09_NEPTUNE_PARITY_MATRIX.md`
- issue backlog

Actions:

- split Neptune Database, Neptune Analytics, Neptune ML/GraphRAG
- map each to implemented/partial/missing
- create issues for missing API/service capabilities

## Engineering milestones from current upstream

### M1 — stabilize current product surface

- README correction
- license correction
- TS/Rust CI
- conformance fixtures
- API docs for TS package

### M2 — formalize TS as reference engine

- freeze public TS API
- mark supported SPARQL subset
- mark supported Gremlin subset
- mark semantic brain shard schema
- mark StorageNode contract

### M3 — Rust convergence for analytics

- add Rust/TS analytics conformance fixtures
- expose Rust analytics through sidecar/API
- port or bind graph algorithm procedure surface

### M4 — query and validation conformance

- SPARQL fixtures
- Gremlin fixtures
- SHACL fixtures
- Turtle fixtures
- Atomese projection fixtures

### M5 — service parity

- query endpoint
- explain/profile/status/cancel
- loader API
- stream API
- health API
- metrics API

### M6 — managed graph parity

- backup/restore
- auth
- encryption
- deployment charts
- observability dashboard

### M7 — GraphRAG and ML parity

- vector binding type
- hybrid symbolic/vector query plan
- link prediction baseline
- prediction-as-candidate-valuation
- model provenance artifacts

## Bottom line

HellGraph is much further upstream than the old Rust-only spec implies.

The correct path forward is:

```text
1. Correct stale documentation and license metadata.
2. Treat the TypeScript engine as the current broad reference implementation.
3. Treat Rust as deterministic kernel and analytics convergence.
4. Build conformance fixtures before expanding claims.
5. Split parity into Blazegraph RDF/SPARQL, Neptune Database, Neptune Analytics, OpenCog/AtomSpace, and GraphRAG/ML surfaces.
6. Drive the repo with a test-backed parity ledger.
```

This is now the controlling spec for moving HellGraph forward from the actual upstream state.
