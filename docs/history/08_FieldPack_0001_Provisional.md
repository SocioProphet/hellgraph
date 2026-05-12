# FieldPack-0001 (Provisional Adapter Pack)

## Status

This is a **provisional adapter pack** for the first executable HellGraph pilot.
It is not claimed to be the user's final canonical 26-dimensional basis.
It exists to preserve:
- fixed basis cardinality (26)
- deterministic ordering
- domain discipline
- bound-check semantics
- replacement seams for the user's canonical calculus

When the canonical manuscript basis is transcribed into machine-readable form,
this pack should be replaced dimension-for-dimension while preserving stable
index ordering or an explicit migration table.

## Pilot Intent

FieldPack-0001 is optimized for the first bounded-state proof pilot:
**operational confinement and trust-boundary conformance**.

The pack is designed to be generic enough for:
- identity/capability state
- service boundary state
- evidence/provenance coverage
- resource pressure
- contradiction and recovery tracking

## Basis Ordering (Canonical for this provisional pack)

| Index | Name | Domain | Suggested Bounds | Interpretation |
|---:|---|---|---|---|
| 0 | identity_integrity | [0,1] | 0.70..1.00 | principal identity coherence |
| 1 | capability_scope | [0,1] | 0.60..1.00 | scope tightness / least-privilege quality |
| 2 | credential_exposure | [0,1] | 0.00..0.35 | credential exposure pressure |
| 3 | secret_residency | [0,1] | 0.70..1.00 | secrets remain in approved residency domains |
| 4 | boundary_permeability | [0,1] | 0.00..0.35 | leakage permeability |
| 5 | privilege_gradient | [0,1] | 0.00..0.40 | privilege discontinuity |
| 6 | egress_pressure | [0,1] | 0.00..0.55 | outbound transfer pressure |
| 7 | ingress_trust | [0,1] | 0.55..1.00 | quality of inbound trust anchors |
| 8 | data_sensitivity | [0,1] | 0.00..0.65 | sensitivity burden in active scope |
| 9 | policy_conformance | [0,1] | 0.75..1.00 | declared policy conformance |
| 10 | provenance_coverage | [0,1] | 0.70..1.00 | provenance completeness |
| 11 | evidence_completeness | [0,1] | 0.70..1.00 | evidentiary coverage |
| 12 | temporal_freshness | [0,1] | 0.65..1.00 | freshness of evidence and state |
| 13 | topology_reachability | [0,1] | 0.20..0.85 | reachable attack / service surface |
| 14 | service_health | [0,1] | 0.60..1.00 | health of governed service |
| 15 | load_saturation | [0,1] | 0.00..0.80 | saturation / backlog pressure |
| 16 | isolation_distance | [0,1] | 0.55..1.00 | isolation from forbidden domains |
| 17 | dependency_fragility | [0,1] | 0.00..0.55 | dependency-chain fragility |
| 18 | contradiction_mass | [0,1] | 0.00..0.25 | explicit contradiction burden |
| 19 | truth_confidence | [0,1] | 0.55..1.00 | confidence derived from truth valuations |
| 20 | replay_determinism | [0,1] | 0.85..1.00 | replay stability |
| 21 | recovery_integrity | [0,1] | 0.75..1.00 | checkpoint / recovery integrity |
| 22 | observability_density | [0,1] | 0.65..1.00 | observability richness |
| 23 | recommendation_stability | [0,1] | 0.55..1.00 | stability of suggested actions |
| 24 | counterexample_pressure | [0,1] | 0.00..0.40 | unresolved adversarial pressure |
| 25 | entropy_budget | [0,1] | 0.00..0.45 | uncontrolled entropy / unpredictability |

## Domain Rules

All 26 provisional dimensions use the same compact runtime domain:
- numeric scalar in `[0,1]`
- lower values are better for *pressure/burden* dimensions
- higher values are better for *quality/integrity* dimensions

To avoid semantic inversion bugs, every dimension carries a polarity:
- `HigherIsBetter`
- `LowerIsBetter`

The runtime stores the raw scalar and evaluates conformance using per-dimension bounds.

## Polarity Map

### HigherIsBetter
0, 1, 3, 7, 9, 10, 11, 12, 14, 16, 19, 20, 21, 22, 23

### LowerIsBetter
2, 4, 5, 6, 8, 13, 15, 17, 18, 24, 25

## Operator Set (Deterministic v0.1)

1. `AccumulateDelta`
   - apply ordered deltas to basis slots
2. `ClampToDomain`
   - clamp each slot to `[0,1]`
3. `EvidencePenalty`
   - reduce dimensions 10, 11, 12, and 22 when evidence is sparse/stale
4. `ContradictionPenalty`
   - raise dimension 18 when contradictory assertions rise
5. `DeterminismPenalty`
   - reduce dimension 20 if replay divergence is detected
6. `RecoveryPenalty`
   - reduce dimension 21 when checkpoint/recovery state is degraded
7. `EpsilonRecompute`
   - compute `epsilon_eff` from aggregate movement and contradiction pressure

Operator order is canonical and hash-stable.

## Epsilon Model (Provisional)

For the executable scaffold, the provisional runtime computes:

- `movement = mean(abs(delta_i))`
- `epsilon_eff = clamp(movement + 0.5 * contradiction_mass, 0, 1)`

This is a placeholder computational seam, not the user's final calculus.
Its purpose is deterministic replay, bound checking, and proof emission.

## Replacement Policy for the Canonical Basis

When the user's canonical field calculus is transcribed:

1. If the canonical basis has the same 26 slots in a different naming scheme:
   - keep the ordering stable
   - replace metadata only
2. If the canonical basis has different semantic ordering:
   - issue a `FieldPackMigrationPlan`
   - define slot-to-slot mapping and normalization rules
3. If any dimension requires a richer domain (interval, ordinal, algebraic payload):
   - widen only that slot's domain tag
   - preserve pack/version separation

## Acceptance Criteria

- pack loads deterministically
- dimension count is exactly 26
- every slot has polarity, bounds, and description
- basis fingerprint is stable across replays
- proof pilot can produce `Proved`, `Violated`, and `Inconclusive`
