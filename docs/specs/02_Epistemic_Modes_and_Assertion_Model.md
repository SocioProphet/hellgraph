# Epistemic Modes and Assertion Model v0.1

## Purpose

Define the world-assumption and statement-status model for HellGraph so that:
- query semantics are explicit
- proof semantics are explicit
- field calculus semantics are explicit
- RDF and Cypher projections do not smuggle in conflicting assumptions

## Epistemic Modes

```rust
enum EpistemicMode {
    OpenWorld,        // absence != false
    ClosedWorld,      // bounded absence may be treated as false within scope
    BoundedSnapshot,  // reasoning over an explicit evidence window/snapshot
    Counterfactual,   // hypothetical variation on a base state
    Simulation,       // generated or simulated state trajectory
}
```

## Rules

### OpenWorld
Use for:
- RDF-native imported knowledge
- public ontologies
- identity graphs
- incomplete semantic datasets

Semantics:
- missing assertion means unknown, not false
- contradiction detection is possible, but non-entailment is not falsehood

### ClosedWorld
Use for:
- bounded operational policy checks
- deterministic inventory checks
- "must exist" integrity conditions within a declared scope

Semantics:
- within a declared scope and evidence basis, missing required fact may be treated as failure

### BoundedSnapshot
Use for:
- proofs
- field bound evaluation
- replay
- differential testing

Semantics:
- all reasoning is tied to a concrete snapshot/evidence set
- "not provable in snapshot S" is not automatically global falsehood

### Counterfactual
Use for:
- what-if planning
- policy simulation
- rollback previews
- impact analysis

Semantics:
- derived from a base snapshot plus declared hypothetical modifications
- results are not asserted as actual facts without explicit promotion

### Simulation
Use for:
- generated trajectories
- synthetic adversarial sequences
- performance/load experiments

Semantics:
- synthetic provenance required
- must not silently mix with actual observed facts

## Assertion Categories

```rust
enum AssertionClass {
    Structural,  // topology, identity scaffolding, schema-carrying links
    Assertion,   // claim-bearing link about the world
    State,       // mutable state snapshot or bounded state attachment
    Event,       // observed or emitted event
    Executable,  // query, rule, plan, or rewrite object
}
```

## Value Family Attachment Rules

### Structural
Can carry:
- properties
- provenance
- security labels
- activation
May carry:
- truth (rarely, if the structural fact itself is uncertain)
Should not normally carry:
- proof, unless a structural invariant is being checked

### Assertion
Can carry:
- truth
- proof
- provenance
- activation
May carry:
- field references when the assertion is derived from a field state

### State
Can carry:
- field
- proof
- provenance
- activation
May carry:
- truth only when the state is uncertain or estimated

### Event
Can carry:
- provenance
- proof
- activation
May carry:
- truth if event capture itself is uncertain or inferred

### Executable
Can carry:
- provenance
- activation
- proof of well-formedness or verification
Should not normally carry:
- truth, unless represented as an asserted claim about an executable artifact

## Value Families

### TruthValue
- evidence-bearing
- uncertainty-compatible
- non-authoritative for policy gating

### ProofValue
- deterministic checker verdict
- authoritative for hard gating where checker applies

### FieldValue
- bounded multidimensional state
- authoritative only within declared field pack and snapshot semantics

### ActivationValue
- ranking / recency / salience
- never authoritative for correctness

## Composition Rules

### Rule 1 — Proof beats truth in hard gates
If a decision boundary is governed by a checker and a `ProofValue` exists, then:
- `Violated` blocks
- `Proved` allows only with its assumptions
- `Inconclusive` gates or degrades, depending on policy

Truth/confidence may inform investigation priority but cannot override a hard proof verdict.

### Rule 2 — Activation never changes correctness
Activation can:
- reorder candidate presentation
- influence cache/materialization
- prioritize exploration

Activation cannot:
- change query result correctness
- convert unknown to known
- override proof failures

### Rule 3 — Truth propagation is operator-specific
Truth values do not automatically propagate through joins and path composition without an explicit operator policy.

### Rule 4 — Field state is not truth
A field coordinate is a bounded state descriptor, not a claim of truth by itself.

### Rule 5 — Mode must be explicit or inherited
All of the following must either declare or inherit an `EpistemicMode`:
- query
- proof check
- field evaluation
- recommendation generation
- export job

## Recommendation Object Rules

Recommendations must record:
- epistemic mode
- value-family dependencies
- whether the recommendation was blocked, gated, degraded, or allowed by proof state

## Default Policies

- RDF import defaults to `OpenWorld`
- Cypher facade defaults to `BoundedSnapshot` when executed against a snapshot
- Proof checks default to `BoundedSnapshot`
- Field simulation defaults to `Simulation`
- Policy what-if analysis defaults to `Counterfactual`

## Acceptance Criteria

A subsystem is non-conformant if it:
- treats absence as false without declared mode/scope
- converts `ProofValue` into `TruthValue` silently
- uses `ActivationValue` for correctness
- mixes simulated data with observed data without explicit provenance and mode
