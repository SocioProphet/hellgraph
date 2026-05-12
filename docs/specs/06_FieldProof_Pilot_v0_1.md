# Field and Proof Pilot v0.1

## Purpose

Define the first implementation-grade pilot for:
- one field-pack runtime
- one proof family
- deterministic replay
- counterexample generation
- policy-gated recommendations

The pilot is intentionally small but must be semantically complete.

## Pilot Scope

### Field Pilot
- one 26-dimensional field pack
- one declared basis ordering
- one deterministic evaluator
- one bounded-state checker
- one serialized FieldValue model

### Proof Pilot
- one checker family
- one witness/counterexample contract
- one assumptions-hash contract
- one replay harness

## FieldPack Contract

```rust
struct FieldBasisDim {
    index: u16,
    name: String,
    domain_tag: TypeId,
    lower_bound: Option<ValuePayload>,
    upper_bound: Option<ValuePayload>,
    notes: Option<String>,
}

struct FieldOperatorSpec {
    name: String,
    input_keys: Vec<KeyId>,
    deterministic: bool,
    evaluation_order: u32,
}

struct FieldBoundSpec {
    name: String,
    axis_constraints: Vec<(u16, ValuePayload, ValuePayload)>,
    epsilon_limit: f64,
}

struct FieldPack {
    artifact_id: ArtifactId,
    name: String,
    basis_version: u32,
    dims: Vec<FieldBasisDim>,
    operators: Vec<FieldOperatorSpec>,
    bounds: Vec<FieldBoundSpec>,
    serializer_hash: [u8; 32],
}
```

Rules:
- `dims.len()` must equal 26 in the pilot
- basis order is canonical and hash-stable
- operator evaluation order is explicit
- all domain tags must resolve through schema registry

## Field Evaluation Contract

```rust
struct FieldTransitionInput {
    subject_atom: AtomId,
    snapshot_txn: TxnId,
    event_atoms: Vec<AtomId>,
    valuation_inputs: Vec<(AtomId, KeyId)>,
    field_pack: ArtifactId,
}

struct FieldTransitionOutput {
    prior_state: Option<FieldValue>,
    next_state: FieldValue,
    operator_trace_hash: [u8; 32],
    evidence_artifacts: Vec<ArtifactId>,
}
```

Rules:
- same input bundle must produce same output
- missing evidence must be explicit
- simulated/counterfactual runs must carry mode-specific provenance

## Proof Pilot Contract

### Checker Family
Initial v0.1 checker family:
- bounded-state conformance against FieldPack-defined bounds

This yields:
- `Proved`
- `Violated`
- `Inconclusive`

### Proof Artifact Contract

```rust
struct ProofArtifact {
    artifact_id: ArtifactId,
    checker_name: String,
    checker_version: u32,
    snapshot_txn: TxnId,
    subject_atom: AtomId,
    assumptions_hash: [u8; 32],
    field_pack: Option<ArtifactId>,
    witness_hash: Option<[u8; 32]>,
    counterexample_hash: Option<[u8; 32]>,
    verdict: ProofVerdict,
}
```

Rules:
- `Proved` requires witness or machine-checkable certification trace
- `Violated` requires counterexample trace or violating axis report
- `Inconclusive` requires explicit insufficiency reason

## CounterExample Artifact

```rust
struct CounterExampleArtifact {
    artifact_id: ArtifactId,
    base_snapshot_txn: TxnId,
    subject_atom: AtomId,
    generated_inputs: Vec<ArtifactId>,
    violated_bounds: Vec<String>,
    replay_hash: [u8; 32],
}
```

## Recommendation Interaction

Recommendations generated from field/proof state must record:
- epistemic mode
- field pack version
- proof verdict
- whether the recommendation is blocked, gated, degraded, or allowed

Hard rule:
- `Violated` cannot be ranked away by activation or truth

## Deterministic Replay Harness

Required fixtures:
1. same inputs -> same field transition output
2. same inputs -> same proof artifact
3. same counterexample generator seed -> same generated counterexample
4. exported proof bundle -> replayable locally

## Minimum Acceptance Suite

### Field
- load field pack
- validate 26 dimensions and domain registry bindings
- run deterministic state transition
- serialize and deserialize FieldValue

### Proof
- produce `Proved`
- produce `Violated`
- produce `Inconclusive`
- verify verdict-specific artifact requirements

### Integration
- query current field state from Cypher facade
- export related RDF projection with sidecar rules
- enforce security labels on witness export

## Initial Implementation Order

1. FieldPack loader
2. domain validator
3. canonical serializer
4. deterministic evaluator
5. bound checker
6. ProofArtifact emitter
7. CounterExampleArtifact emitter
8. replay harness
9. recommendation gate integration

## Non-goals for v0.1

- generalized theorem proving
- distributed proof execution
- multiple proof families
- multiple field packs
- dynamic basis mutation
