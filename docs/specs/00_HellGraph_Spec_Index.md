# HellGraph Spec Index v0.1

This directory contains the pre-implementation specification set for HellGraph v0.1.

## Purpose

Freeze the canonical semantics, interfaces, projections, and pilot overlays before substantial implementation begins.

## Spec Set

1. `01_PreImplementation_Audit_and_Remediation.md`
   - audit of the prior design work
   - major misses, corrections, and design guardrails
   - remediation priorities

2. `02_Epistemic_Modes_and_Assertion_Model.md`
   - explicit world-assumption and reasoning modes
   - assertion categories
   - interaction rules across truth, proof, field, and activation families

3. `03_Kernel_IDL_v0_1.md`
   - canonical atom, type, valuation, time, provenance, and security model
   - immutability and MVCC contracts
   - identity and schema evolution primitives

4. `04_Cypher_Facade_v0_1.md`
   - supported GQL-shaped Cypher subset
   - native hyperedge extension (`MATCH LINK`)
   - planner/index contracts
   - path semantics and property projection rules

5. `05_RDF_Bridge_v0_1.md`
   - RDF projection/import/export rules
   - triples/quads/RDF-star/reified/binary modes
   - lossless/lossy round-trip contracts
   - SHACL validation and layered repository model

6. `06_FieldProof_Pilot_v0_1.md`
   - pilot 26D field-pack contract
   - proof-family contract
   - deterministic replay and counterexample harness
   - initial implementation plan

7. `07_Integrated_Implementation_Plan.md`
   - phased delivery plan
   - acceptance criteria
   - staffing and effort model
   - risk register and remediation sequence

## Canonical Kernel Theorem

One canonical core: immutable typed atoms plus versioned valuations.

Two projections:
- Cypher/GQL-shaped operational query
- RDF/SPARQL interoperability

Four authoritative value families:
- Truth
- Proof
- Field
- Activation

## Non-negotiable Rules

- Graph structure is immutable.
- State changes occur through append-only valuations.
- Proof is never silently downgraded to truth/confidence.
- Activation may affect ranking but never correctness.
- RDF is a projection bridge, not the native execution kernel.
- Cypher is an operator facade, not the semantic authority.
- Field packs and proof checkers are versioned, replayable artifacts.
