# HellGraph Kernel Seam Audit

## Scope

This audit covers the current kernel seam across:

- `hg_core`
- `hg_fieldpack`
- `hg_proof`
- `hg_kernel`
- `hg_runtime`
- `hg_read_kernel`

It evaluates whether the implementation currently enforces the v0.1 kernel doctrine: immutable typed atoms plus append-only versioned valuations, with proof/truth/field/activation remaining distinguishable.

## Positive findings

### Core type families exist

`hg_core` defines atom IDs, artifact IDs, transaction IDs, 26 field dimensions, epistemic modes, security labels, truth values, activation values, field values, proof values, atom kinds, link semantics, role bindings, and atom envelopes.

This is the right nucleus. The system already separates proof, field, truth, and activation at the type level.

### Append-only valuation pattern exists

`hg_kernel::SpaceStore::commit_batch` appends new value envelopes and retires prior active values for the same `(subject_atom, key)` pair by setting `retired_at_txn`. It does not mutate the payload of prior values.

This matches the append-only valuation doctrine at the first implementation layer.

### Runtime cycle ties field and proof together

`hg_runtime::run_cycle_and_commit_with` reads a prior field snapshot, applies operator semantics, checks bounded-state proof, commits field and proof values, and stores a proof artifact in the same batch.

This is a credible seam for proof-aware state transitions.

### Journal/checkpoint/replay exists

`JournaledStore` writes journal frames, persists checkpoints, replays frames, validates frame checksums, and supports reopen tests through runtime and read-kernel tests.

This gives the project a real local-first persistence nucleus.

### Read kernel exists

`hg_read_kernel` can produce subject snapshots with atom type, field/proof values, active value count, and incident links.

This is enough for the first operational read model.

## Risks and gaps

### 1. Provenance is under-modeled

The spec requires explicit provenance for TruthValue, ProofValue, FieldValue, and imported atoms. Current values carry epistemic mode and security label but no first-class `ProvenanceRef`.

Impact: the kernel can commit state that cannot yet explain source, signer, artifact, or observation context.

Remediation: add a `ProvenanceRef` or provenance bundle reference to `ValueEnvelope` and artifact records, then update commit APIs and tests.

### 2. Spaces are absent in code

The IDL requires explicit spaces as semantic/governance boundaries. Current atoms do not carry `space_id`.

Impact: multi-corpus, multi-tenant, or security-bounded graphs cannot be represented natively.

Remediation: introduce `SpaceId`, `Space`, and `SpaceCatalog`; require atoms to belong to exactly one space.

### 3. Type schemas are absent in code

Current atoms use `type_name: String`; the IDL requires type IDs, role specs, cardinality, target-type constraints, and RDF projection metadata.

Impact: link creation can only check target atom existence, not semantic validity.

Remediation: add `TypeSchema`, `RoleSpec`, and schema-pack validation for create_node/create_link.

### 4. Temporal semantics are txn-only

The read path supports snapshot transaction visibility but not valid time or observed time.

Impact: evidence, real-world temporal claims, and late-arriving observations cannot be modeled correctly.

Remediation: add `TemporalScope` to valuations and update lookup APIs to accept temporal filters.

### 5. Hashing is provisional

FNV1A64 is useful for deterministic fingerprints but is not cryptographic and should not be used as an audit-integrity primitive.

Impact: artifact/checkpoint/proof provenance may sound stronger than it is.

Remediation: retain FNV1A64 only for non-security fingerprints; add SHA-256/BLAKE3 manifest hashing for audit-critical artifacts and journal chains.

### 6. Journal replay lacks strict frame monotonicity validation

Frames have sequence numbers and checksums, but replay should explicitly enforce monotonic sequence progression and transaction ordering.

Impact: malformed or reordered journals may not be rejected strongly enough.

Remediation: add tests for duplicate frame sequence, skipped sequence, backward transaction, corrupted payload, missing END, and checkpoint/journal mismatch.

### 7. Proof artifact linkage is good but narrow

Proof values can receive artifact refs during batch commit. That is good. But only proof artifacts exist today.

Impact: field, truth, activation, provenance, RDF exports, and bridge materializations have no comparable artifact lifecycle.

Remediation: extend artifact payload families and require artifact refs for governed value families where appropriate.

### 8. RDF and Cypher are entirely outside code

The bridge and query facade are specified but not implemented.

Impact: external interoperability claims must remain alpha/spec-only.

Remediation: create bridge/facade crates with explicit pending tests first, then implement minimal projection paths.

## Recommended next PRs

1. `kernel/provenance-ref` — add provenance refs to value envelopes and proof artifacts.
2. `kernel/spaces-and-schema-pack` — introduce spaces, schema pack IDs, type IDs, and role specs.
3. `kernel/journal-integrity-tests` — add corrupted/reordered journal negative fixtures.
4. `bridge/rdf-projection-skeleton` — create RDF bridge crate with projection loss classification types.
5. `facade/cypher-parser-skeleton` — create parser/planner boundary without pretending to support full Cypher.

## Verdict

HellGraph has a credible kernel nucleus. The code is not just prose. However, the current implementation is still a scaffold: enough to support disciplined internal iteration, not enough to support public claims of production graph-runtime completeness.

The next engineering step should harden provenance, spaces, schema validation, and journal integrity before expanding query or RDF surfaces.
