# Pre-Implementation Audit and Remediation

## Executive Summary

The earlier architecture work was directionally strong but semantically under-constrained.

The main weakness was not component choice. The weakness was that the system was still described as a stack of technologies instead of a semantics-first kernel with explicit contracts. That invites drift: one subsystem starts treating "not found" as false, another treats it as unknown, a third treats it as "not provable yet", and the planner silently launders those differences into a ranking score.

This document turns the earlier work into a remediation checklist.

## What We Got Right

### 1. Blazegraph should be an oracle, not the future architecture
We correctly reframed Blazegraph as:
- a behavioral oracle
- a migration source
- a performance reference
and not as the long-term kernel.

### 2. The core must be graph-native
We correctly moved away from forcing the entire system into:
- plain RDF triples only
- plain property graph only
- or ad hoc document blobs

A typed hypergraph / metagraph kernel is the correct center.

### 3. Field calculus belongs in the formal core
The earlier demotion of the field calculus was wrong and was later corrected.
That correction was necessary.

### 4. Proofs must be first-class
We correctly separated proof/evidence from ranking and recommendation.

### 5. Local-first execution is the correct baseline
The architecture now properly assumes:
- laptops
- edge nodes
- small servers
as first-class execution environments.

## What We Missed

### 1. Epistemic modes were implicit
We did not freeze the difference between:
- open-world semantics
- closed-world checks
- bounded-snapshot reasoning
- counterfactual reasoning
- simulation

Without that, "unknown", "false", and "not provable on this evidence set" collapse into mush.

### 2. RDF-star / quoted triples were omitted
We jumped too quickly from plain triples/quads to full reification.
RDF-star is the right middle layer for:
- metadata about statements
- provenance on statements
- quoted but unasserted statements
- some truth/proof annotations

### 3. We underused AtomSpace's strongest lessons
The real prize is:
- immutable atoms
- immutable values
- mutable atom->value association
- per-atom keyed valuations
- queries as graphs
- rewrite rules as graphs
- executable graph fragments

We mentioned some of this but did not promote it to kernel law early enough.

### 4. We underused RDF4J's strongest lesson
RDF4J's most useful idea for us is not "Java RDF library"; it is:
- Repository over SAIL
- stackable layers
- SHACL on commit
- binary transport

That layering pattern should be copied directly into HellGraph.

### 5. We failed to specify projection loss clearly
We said there would be projections into RDF and a Cypher-like facade, but we did not say:
- what round-trips losslessly
- what must be reified
- what needs a sidecar
- what cannot be projected without information loss

### 6. We did not define path semantics
Path variables, variable-length traversal, path constraints, and truth/proof aggregation over paths were not frozen.

### 7. We under-specified identity and schema evolution
We need native support for:
- aliases
- canonicalization
- supersession
- imported identity
- schema versions
- migration packs

### 8. We under-specified time
We need at least:
- transaction time
- valid time
- observed time

### 9. We did not define value-family composition rules
We distinguished truth and proof, but not operationally enough.
We still need explicit rules for:
- truth propagation through query operators
- proof precedence over ranking
- field-value use in recommendations
- activation's non-authoritative role

### 10. We did not freeze benchmark and conformance suites
Without benchmark corpora and conformance harnesses, planner and storage decisions become guesswork.

## Design Corrections

### Correction A — Freeze a canonical kernel
The system must have:
- one canonical graph kernel
- one valuation model
- one temporal model
- one identity/evolution model

Everything else is an overlay or a projection.

### Correction B — Separate the four value families rigorously
We need four and only four authoritative value families in v0.1:

1. Truth
   - evidence-bearing
   - probabilistic / empirical / imported / simulated
2. Proof
   - deterministic checker verdicts
   - never silently reduced to confidence
3. Field
   - bounded multidimensional state in a declared basis
4. Activation
   - salience / recency / cache warmth / working-memory relevance

### Correction C — Add explicit assertion classes
Not every atom should be interpreted as a truth-bearing assertion.
We need explicit classes:
- structural
- assertion
- state
- event
- executable

### Correction D — Add RDF-star to the bridge contract
Bridge modes must become:
- Triples
- Quads
- RDF-star
- Reified
- BinaryRDF

### Correction E — Freeze a GQL-shaped Cypher subset
We should not chase total historical Cypher parity.
We should implement:
- a useful subset
- aligned with stable GQL direction where practical
- with one native hypergraph extension

### Correction F — Make stored queries and rewrite rules native
Reserved native types should include:
- QueryAtom
- RuleAtom
- PlanAtom
- ExecutableAtom

### Correction G — Make lifecycle explicit
We must model:
- retirement
- retraction
- compaction
- checkpointing
- physical GC
- replay fidelity

## What We Should Defer

Defer from v0.1:
- distributed/federated execution
- broad theorem-proving beyond one proof family
- full historical openCypher parity
- wide OpenCog taxonomy import
- generalized recursive/path wizardry beyond a constrained subset
- heavy vector-native semantics inside the canonical kernel

## Remediation Sequence

### P0 — freeze semantics
- epistemic modes
- kernel IDL
- value families
- assertion model
- temporal model
- identity/schema evolution
- projection loss contracts

### P1 — freeze query and bridge surfaces
- GQL-shaped Cypher subset
- MATCH LINK semantics
- RDF bridge modes
- SHACL validation boundary
- BinaryRDF transport profile

### P2 — freeze pilot overlays
- one FieldPack
- one proof family
- deterministic replay contract
- counterexample artifact contract

### P3 — build benchmark/conformance harnesses
- Cypher subset conformance
- RDF import/export/RDF-star round-trip
- field/proof deterministic replay
- local-device workload suite

## Acceptance Criteria for Remediation

The architecture is ready for implementation only when:
- every query declares or inherits an epistemic mode
- proof/truth/field/activation are separable in both storage and APIs
- path semantics are frozen for supported query forms
- RDF projection loss is documented
- one field pack and one proof family are fully specified
- benchmark and conformance plans are written

## Bottom Line

The system is now cohesive enough to build, but only if implementation starts from the contracts in this spec set rather than from ad hoc code experiments.
