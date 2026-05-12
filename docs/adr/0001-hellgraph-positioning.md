# ADR-0001: HellGraph positioning

## Status

Accepted.

## Context

HellGraph began as a local-first graph-runtime scaffold for evidence, proof, field-state, and persistence work. The repository also contains RDF and Cypher/GQL bridge specifications. Because Blazegraph is part of the surrounding semantic-layer discussion, the repository needs an explicit positioning decision before public or customer-facing use.

## Decision

HellGraph is a SocioProphet-native local-first graph runtime kernel with RDF/SPARQL interoperability.

It is not a direct Blazegraph fork and is not a drop-in Blazegraph replacement.

Blazegraph is treated as a behavioral oracle, migration source, and RDF/SPARQL compatibility reference for relevant workloads. HellGraph owns the native kernel semantics: typed atoms, append-only valuations, proof artifacts, field-state transitions, deterministic replay, provenance, and projection bridges.

## Rationale

The SocioProphet graph architecture is contract-first. RDF stores, property graph stores, hypergraph runtimes, vector stores, and proof/validation systems should be composed behind stable interfaces.

HellGraph should therefore implement the kernel laws:

- immutable typed atoms
- append-only versioned valuations
- explicit epistemic modes
- explicit security labels
- proof, truth, field, and activation as distinguishable value families
- deterministic replay and checkpoint semantics
- RDF/SPARQL and Cypher/GQL as projection/facade layers, not native authority

## Consequences

- Claims of Blazegraph compatibility must be test-backed.
- Upstream work against Blazegraph must be scoped separately.
- RDF bridge behavior must classify lossless, conditionally lossless, lossy, and unsupported projections.
- Cypher/GQL facade behavior must remain subordinate to kernel semantics.
- License and provenance boundaries are release blockers.
- Public releases before bridge/conformance completion must be marked alpha.
