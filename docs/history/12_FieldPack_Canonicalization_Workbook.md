# FieldPack-0001 Canonicalization Workbook

This workbook is the direct replacement seam for `FieldPack-0001-Provisional`.

## Instructions

For each slot 0..25, replace the provisional placeholder with the canonical dimension from the user's field calculus.
Each row must freeze:
- canonical dimension name,
- domain kind,
- polarity,
- lower/upper bound semantics,
- operator family,
- coupling notes,
- export / projection rules.

## Template

| Slot | Provisional Name | Canonical Name | Domain Kind | Polarity | Lower Bound | Upper Bound | Operator Family | Couplings | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 0 | identity_integrity |  |  |  |  |  |  |  |  |
| 1 | capability_scope |  |  |  |  |  |  |  |  |
| 2 | credential_exposure |  |  |  |  |  |  |  |  |
| 3 | secret_residency |  |  |  |  |  |  |  |  |
| 4 | boundary_permeability |  |  |  |  |  |  |  |  |
| 5 | privilege_gradient |  |  |  |  |  |  |  |  |
| 6 | egress_pressure |  |  |  |  |  |  |  |  |
| 7 | ingress_trust |  |  |  |  |  |  |  |  |
| 8 | data_sensitivity |  |  |  |  |  |  |  |  |
| 9 | policy_conformance |  |  |  |  |  |  |  |  |
| 10 | provenance_coverage |  |  |  |  |  |  |  |  |
| 11 | evidence_completeness |  |  |  |  |  |  |  |  |
| 12 | temporal_freshness |  |  |  |  |  |  |  |  |
| 13 | topology_reachability |  |  |  |  |  |  |  |  |
| 14 | service_health |  |  |  |  |  |  |  |  |
| 15 | load_saturation |  |  |  |  |  |  |  |  |
| 16 | isolation_distance |  |  |  |  |  |  |  |  |
| 17 | dependency_fragility |  |  |  |  |  |  |  |  |
| 18 | contradiction_mass |  |  |  |  |  |  |  |  |
| 19 | truth_confidence |  |  |  |  |  |  |  |  |
| 20 | replay_determinism |  |  |  |  |  |  |  |  |
| 21 | recovery_integrity |  |  |  |  |  |  |  |  |
| 22 | observability_density |  |  |  |  |  |  |  |  |
| 23 | recommendation_stability |  |  |  |  |  |  |  |  |
| 24 | counterexample_pressure |  |  |  |  |  |  |  |  |
| 25 | entropy_budget |  |  |  |  |  |  |  |  |

## Acceptance criteria

A canonical pack is ready when:
1. every slot is named and typed,
2. every slot has explicit bound semantics,
3. the basis ordering is frozen,
4. operator families are named,
5. migration from provisional to canonical is defined.
