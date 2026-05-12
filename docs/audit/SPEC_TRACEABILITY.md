# HellGraph Spec Traceability

## Purpose

This audit maps the v0.1 specification set to the current Rust workspace. It is intentionally conservative: a feature is marked implemented only when there is code, not just prose.

## Status key

- `implemented`: present in code and at least lightly tested
- `partial`: present in code but incomplete against the spec
- `specified-only`: described in specs but not implemented
- `missing`: required by spec and absent from code
- `risk`: present but semantically dangerous or under-governed

## Workspace inventory

Root workspace members:

- `hg_core`
- `hg_fieldpack`
- `hg_proof`
- `hg_kernel`
- `hg_runtime`
- `hg_read_kernel`

## Traceability matrix

| Spec area | Status | Current evidence | Gap / next action |
|---|---:|---|---|
| Immutable typed atoms | partial | `hg_core::Atom`, `NodeAtom`, `LinkAtom`; `hg_kernel::SpaceStore::create_node/create_link` | No explicit retirement, canonical hash, type IDs, space IDs, or schema validation yet. |
| Append-only valuations | partial | `ValueEnvelope`, `CommitBatch`, `commit_batch`, retirement of prior active value by txn | No full temporal scope, provenance ref, key registry, or scalar/list/map payload family. |
| Epistemic modes | partial | `EpistemicMode` enum exists and commit values carry mode | Query/planner enforcement absent. Imported/open-world behavior absent. |
| Security labels | partial | `SecurityLabel` enum exists and values carry label | Atom/artifact-level labels and export redaction not implemented. |
| Truth value family | partial | `TruthValue` exists in `hg_core` | Not accepted in `ValuePayload`; no truth propagation or source provenance. |
| Proof value family | implemented/partial | `ProofValue`, `ProofArtifact`, bounded-state checker, artifact records | Only one proof family; no checker registry, witness/counterexample artifact separation, or cryptographic assumptions hash. |
| Field value family | implemented/partial | `FieldState26`, `FieldValue`, `FieldPack26`, runtime cycle | Canonical 26-slot basis remains provisional; field domains are thin; no full canonical pack artifact lifecycle. |
| Activation value family | partial | `ActivationValue` exists | Not accepted in `ValuePayload`; no activation cache/decay semantics. |
| Explicit spaces | specified-only | `SpaceId` appears in spec | No code-level `Space`, `SpaceCatalog`, or atom `space_id`. |
| Type schemas | specified-only | `TypeSchema` appears in spec | No schema registry, role cardinality checks, target-type constraints, or type IDs. |
| Identity/schema evolution | specified-only | Identity link/spec pack concepts in spec | No identity index, canonicalization graph facts, migration pack runtime. |
| Temporal model | missing | Txn-based snapshots exist | No valid-time or observed-time filters; no `TemporalScope`. |
| Provenance model | partial/risk | Proof artifacts carry fingerprints; values do not carry full provenance refs | Spec requires provenance for Truth/Proof/Field/imported atoms; current model under-represents provenance. |
| Journal/checkpoint/replay | implemented/partial | `JournaledStore`, frame checksum, checkpoint, replay tests | Frame ordering/monotonicity and stronger checksum/hashing are not yet sufficient for adversarial provenance. |
| RDF bridge | specified-only | `docs/specs/05_RDF_Bridge_v0_1.md` | No bridge crate, projection model, SHACL validation, BinaryRDF, or Blazegraph oracle tests. |
| Cypher/GQL facade | specified-only | `docs/specs/04_Cypher_Facade_v0_1.md` | No parser, planner, path semantics implementation, or `MATCH LINK`. |
| Read kernel | partial | `snapshot_subject`, `incident_links`, active value count | Snapshot model is txn-only and security filtering is absent. |
| Vector/embedding refs | specified-only | IDL reserves `EmbeddingRef`/`embed.*` | No embedding payload or vector binding model. |
| Governance docs | partial | specs exist | License/provenance/notice/ADR are added by this hardening branch. |

## Highest-priority gaps

1. Add provenance refs to valuation and artifact paths.
2. Introduce explicit `Space`/`SpaceId` and `TypeSchema` boundaries.
3. Add role/cardinality/target-type validation on link creation.
4. Replace or clearly mark FNV1A64 as non-security hash; introduce cryptographic manifest hashing for audit-critical paths.
5. Add RDF bridge crate skeleton with projection loss classification.
6. Add explicit failing/pending tests for unimplemented RDF/Cypher bridge claims.
7. Add security-filtered read/export semantics.

## Release posture

Until the top seven gaps are addressed, HellGraph should remain private or alpha-marked. It is suitable for kernel iteration, internal demos, and compatibility experiments, not for production or customer claims of RDF/SPARQL replacement.
