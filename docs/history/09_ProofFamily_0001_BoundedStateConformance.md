# ProofFamily-0001: Bounded State Conformance

## Purpose

Define the first concrete proof family for HellGraph v0.1.

The checker answers a narrow but valuable question:

> Given a subject's current `FieldValue`, current evidence coverage, and the active `FieldPack`,
> is the subject within declared operational bounds?

This proof family is intentionally simple.
It is the wedge that proves the full pipeline works:
- state evaluation
- deterministic proof emission
- verdict-specific artifacts
- recommendation gating
- replayability

## Inputs

### Required
- `subject_atom`
- `snapshot_txn`
- `field_pack_id`
- `field_state`
- `evidence_count`
- `assumptions_hash`

### Optional but recommended
- `prior_field_state`
- `event_trace_hash`
- `witness_bundle_id`
- `counterexample_seed`

## Preconditions

The checker refuses to run if:
- field dimension count != pack dimension count
- any slot is outside its domain representation
- the pack basis fingerprint is unknown

## Verdict Semantics

### Proved
Returned when:
- all basis slots satisfy pack bounds
- `epsilon_eff <= epsilon_limit`
- evidence count meets minimum threshold

### Violated
Returned when:
- one or more basis slots violate declared bounds
- or `epsilon_eff > epsilon_limit`

### Inconclusive
Returned when:
- evidence count is below threshold
- required evidence artifacts are missing
- state cannot be interpreted under the active pack

## Reference Algorithm

1. validate pack/state shape
2. check minimum evidence threshold
3. check each dimension against declared bound interval
4. compute maximum violation magnitude
5. compare `epsilon_eff` to pack limit
6. emit verdict
7. attach witness or counterexample material as required

## Minimum Evidence Policy (v0.1)

Provisional runtime threshold:
- `evidence_count >= 3` for `Proved`
- `evidence_count >= 1` for `Violated`
- otherwise `Inconclusive`

Rationale:
- allow strong negative evidence to fail quickly
- prevent weak positive evidence from over-claiming safety

## Artifact Requirements

### For `Proved`
Must include:
- `assumptions_hash`
- basis fingerprint
- snapshot id
- pack id/version
- witness summary or certified trace hash

### For `Violated`
Must include:
- `assumptions_hash`
- basis fingerprint
- snapshot id
- violated dimension indices
- maximum violation magnitude
- counterexample summary or violating trace hash

### For `Inconclusive`
Must include:
- `assumptions_hash`
- insufficiency reason
- missing evidence summary

## Recommendation Gate Rules

- `Proved` -> recommendation eligible
- `Violated` -> recommendation must be marked `Blocked` or `Remediate`
- `Inconclusive` -> recommendation must be marked `ReviewRequired` or `Degraded`

Hard rule:
`Violated` is absorbing for policy gating in v0.1.
Truth confidence, activation, or ranking signals cannot override it.

## Counterexample Shape

A minimal counterexample artifact contains:
- subject atom
- snapshot txn
- active field pack id
- violated dimensions
- violating values
- replay seed (if synthetic)
- replay hash

## Deterministic Replay Tests

1. same pack + same state + same evidence -> same verdict
2. same violating state -> same violated-dimension set
3. same inconclusive state -> same insufficiency reason
4. same seed -> same synthetic counterexample

## Suggested Pilot Wiring

This proof family should be wired directly to:
- `FieldPack-0001`
- one recommendation gate
- one export bundle schema
- one Cypher read surface exposing `proof.current`
