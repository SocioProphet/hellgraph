# Integrated Implementation Plan

## Objective

Build HellGraph v0.1 as:
- a single-node local-first graph kernel
- with immutable typed atoms
- append-only valuations
- a GQL-shaped Cypher facade
- an RDF/SPARQL bridge
- one field-pack runtime
- one proof family
- conformance, replay, and security discipline

## Phase Plan

### Phase 0 — Contract Freeze
Deliverables:
- epistemic modes
- assertion model
- kernel IDL
- query facade spec
- RDF bridge spec
- field/proof pilot spec

Acceptance:
- no unresolved ambiguity on value-family boundaries
- no unresolved ambiguity on projection loss
- no unresolved ambiguity on snapshot/time semantics

Estimated effort:
- 160–260 hours

### Phase 1 — Kernel Storage and Snapshot Engine
Deliverables:
- atom store
- valuation store
- snapshot manager
- space catalog
- schema registry
- identity index
- exact indexes

Acceptance:
- immutable atom contract enforced
- append-only valuations enforced
- deterministic snapshot reads
- role/cardinality checks functional

Estimated effort:
- 900–1400 hours

### Phase 2 — Native Pattern IR and Query Core
Deliverables:
- pattern IR
- planner IR
- operator runtime
- exact and semantic index adapters
- EXPLAIN / PROFILE primitives

Acceptance:
- node, binary, and link-role patterns execute
- planner emits deterministic operator trees
- index hints do not alter correctness

Estimated effort:
- 700–1100 hours

### Phase 3 — Cypher Facade
Deliverables:
- parser
- semantic analyzer
- lowering pipeline
- update semantics
- curated conformance harness

Acceptance:
- supported clause set passes curated conformance suite
- MATCH LINK works
- retirement semantics work

Estimated effort:
- 700–1100 hours

### Phase 4 — RDF Bridge
Deliverables:
- triples/quads/RDF-star/reified/binary export
- import pipeline
- repository layering
- SHACL validation
- SPARQL projection endpoint

Acceptance:
- RDF-native subset round-trips cleanly
- RDF-star support works for quoted binary assertions
- invalid exports/imports can be blocked by SHACL
- BinaryRDF transport is functional

Estimated effort:
- 700–1100 hours

### Phase 5 — Field and Proof Pilot
Deliverables:
- field pack loader
- evaluator
- bound checker
- ProofArtifact / CounterExampleArtifact
- replay harness

Acceptance:
- one field pack loads and runs deterministically
- one checker family yields all three verdicts
- replay is stable

Estimated effort:
- 900–1500 hours

### Phase 6 — Security / Packaging / Export
Deliverables:
- valuation-level redaction
- artifact bundle schema
- proof-only export mode
- local-only witness retention
- signed bundles

Acceptance:
- proof export can exclude local-only witnesses
- exports are deterministic and auditable

Estimated effort:
- 500–900 hours

### Phase 7 — Benchmarks, Fuzzing, and Soak
Deliverables:
- benchmark corpus
- differential harnesses
- local-device perf dashboards
- crash/recovery tests
- query/path/projection fuzzing

Acceptance:
- no silent projection loss
- no proof/truth conflation in decision paths
- restart/replay deterministic within declared bounds

Estimated effort:
- 700–1100 hours

## Total Engineering Estimate

Total realistic range:
- 5,260 to 8,460 hours for the single-node v0.1 described here

Recommended staffing:
- 3 strong systems engineers for ~8–11 months
or
- 2 strong systems engineers for ~12–18 months

## Recommended Team Shape

### Engineer A — Kernel/Storage
Owns:
- atom/valuation store
- snapshots
- indexes
- lifecycle/compaction
- export bundle core

### Engineer B — Query/RDF
Owns:
- query IR
- planner
- Cypher facade
- RDF bridge
- SHACL/SPARQL projection

### Engineer C — Field/Proof/Conformance
Owns:
- field pack runtime
- proof checker
- replay harness
- conformance/benchmark suite
- recommendation gate integration

## Critical Risks

### 1. Semantic drift
Mitigation:
- freeze contracts first
- conformance harnesses from day one

### 2. Projection drift
Mitigation:
- explicit lossless/lossy contracts
- RDF-star/reified split
- projection regression tests

### 3. Proof/truth conflation
Mitigation:
- separate types and APIs
- policy gate tests
- blocking verdict semantics

### 4. Schema/identity drift
Mitigation:
- schema pack versioning
- canonicalization links
- migration plans as first-class artifacts

### 5. Path semantics explosion
Mitigation:
- bounded path subset in v0.1
- defer advanced recursion

## Benchmark and Conformance Plan

### Conformance
- curated openCypher/GQL-shaped subset
- RDF import/export round-trip
- RDF-star projection tests
- field/proof deterministic replay
- security/redaction export tests

### Workload Corpus
- binary assertion-heavy
- hyperedge-heavy
- provenance-heavy
- path-heavy
- field-transition-heavy
- proof-heavy
- local-device mixed operational workload

## Immediate Implementation Sequence

1. lock spec set
2. build kernel data model and snapshot visibility
3. build native pattern IR
4. build MATCH LINK execution
5. build minimal Cypher parser/lowering
6. build RDF export/import skeleton with RDF-star
7. build field/proof pilot
8. add SHACL and BinaryRDF
9. add conformance + benchmark harnesses
10. only then tune performance aggressively

## Gate for First Real Integration Demo

A first integration demo is acceptable only when it can show:

- create and query native hyperedges
- attach truth/proof/field/activation values distinctly
- export an RDF-native subset plus RDF-star annotations
- run one field evaluation and one proof check
- block a recommendation on `ProofValue::Violated`
- replay the run deterministically from an artifact bundle

## Bottom Line

This is buildable now, but the implementation must be contract-first.
Any shortcut that starts with storage code or parser code before the semantics are frozen will create drift that is expensive to unwind later.
