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

8. `08_Federated_Sovereign_HellGraph_v0_1.md`
   - managed offering as a federation of sovereign append-only logs
   - DAS + Hypercore/Autobase/Hyperbee conformance targets
   - super-peer (derived index) vs. participant (source of truth)
   - causal consistency; retires client→server `StorageNodeClient` federation

9. `09_Proof_Under_Causal_Consistency_v0_1.md`
   - causal cut (version vector over Hypercores)
   - proof binding: frame-relative validity, no silent downgrade
   - field-state / valuation and read semantics under eventual consistency
   - invariants and open questions (cut compaction, cross-cut composition, retraction)

10. `10_Content_Data_Plane_v0_1.md`
   - content/object plane as the same canonical+derived+policy spine (see ADR-0003)
   - 7-layer seam map onto HellGraph + estate; content lifecycle state model
   - policy plane (L5): engine, retention/legal-hold, audit=evidence spine
   - masking as a HellGraph policy-graph; opt-in default-off vendor/connector egress
   - L3⇄L5 coupling; key-management open decision

11. `11_Upstream_State_And_Convergence_v0_1.md`
   - positioning correction: HellGraph is a polyglot engine (TS reference surface +
     Rust convergence/kernel surface), not a Rust-only kernel scaffold
   - upstream-state + convergence spec (renumbered from a colliding `08` on merge)

12. `12_Codex_TriTRPC_Reconciliation_v0_1.md`
   - binds codex (GKG-CODEX) to TriTRPC wire conventions (CTRL243 Path-B profile, not Path-A)
   - verdict/evidence two-axis mapping (State243.epistemic + CTRL243.evidence); no 3rd vocab
   - marker-band parity (default 9 only); topic23.v1 residue source; unbalanced ternary v0
   - dependency ordering; codex past G3 BLOCKED upstream (profile alloc + topic23.v1 freeze)

13. `13_Reflexive_Loop_and_Convergence_v0_1.md`
   - bidirectional ontology↔epistemology loop over the kernel; convergence = "truth is what
     survives the loop" as a checkable graph fixpoint (no new value families/epistemic modes)
   - Hopf-fibration/S^n imagery is motivating metaphor ONLY — everything is falsifiable graph
     state; authority stays with ProofValue + authored-canon + reasoning-evidence fabric

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
