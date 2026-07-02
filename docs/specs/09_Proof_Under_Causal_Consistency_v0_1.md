# HellGraph Proof Under Causal Consistency v0.1

## Purpose

Preserve the non-negotiable rule — **proof is never silently downgraded to confidence** — when
HellGraph state is federated across sovereign, eventually-consistent append-only logs
(see `08_Federated_Sovereign_HellGraph_v0_1.md`).

This spec is the crux of the federated model. If proof binding is wrong, eventual
consistency silently invalidates proofs on causal fork-reordering, breaking the kernel's
central law. Everything else in the federation is mechanical; this is the part that must
be exactly right.

## The problem

Under the federated model, the shared AtomSpace is the Autobase linearization of many
sovereign Hypercores. Autobase ordering is **eventually consistent**: as new causal
information arrives, previously-ordered operations may be reordered when causal forks
resolve.

A proof artifact (`hg_proof`) is computed against some state. If that state is "the current
global linearization," then a later fork-reorder can change the dependency set the proof
was checked against — and the proof becomes a claim about a history that no longer exists.
Treating it as still-valid is exactly the silent downgrade the kernel forbids.

## The rule

> A proof is never global. A proof is valid **relative to a causal cut**, and only within it.

This is the formalization of "knowledge comes in time": a proof is true *at a time*, and
time is local. There is no global "now" against which a proof is universally true.

## Causal cut

A **causal cut** is a version vector over participant Hypercores:

```rust
/// A causal cut: the exact set of per-writer log heads a computation observed.
/// Keys are Hypercore public keys (writer identity); values are that writer's
/// sequence length at observation time.
struct CausalCut {
    heads: BTreeMap<HypercoreKey, u64>, // writer -> length (seq of last-observed op + 1)
}
```

A cut names a downward-closed set of operations: every op with `seq < heads[writer]` for
its writer is *in* the frame; everything else is *outside* it. Because each writer's own
log is linear (local time), a cut is unambiguous per writer; the vector composes the local
orders into one observed frame.

## Proof binding contract

Every proof artifact carries the cut it was derived against:

```rust
struct ProofArtifact {
    // ... existing hg_proof fields (statement, checker id/version, witness) ...
    derived_against: CausalCut,   // REQUIRED. The frame the proof is true in.
    dependency_ops: Vec<OpId>,    // the specific ops the checker actually read
}
```

Rules:

1. **Frame-relative validity.** A proof asserts nothing outside `derived_against`. A reader
   evaluating the proof MUST supply a read cut; the proof is honored iff the read cut is a
   causal superset that preserves every op in `dependency_ops` in the same relative order.

2. **No silent downgrade.** If a fork-reorder changes the relative order of any op in
   `dependency_ops`, the proof does not degrade to confidence — it becomes **out-of-frame**
   and MUST be re-checked against the new cut. Out-of-frame is an explicit state, never a
   confidence value.

3. **Monotone frames.** Because `dependency_ops` is downward-closed within `derived_against`,
   a proof stays valid under any cut extension that only *adds* ops causally after the
   dependency set. Append-only growth never invalidates a proof; only reordering of
   observed dependencies does.

4. **Determinism.** Re-checking a proof against a given cut is deterministic (kernel law).
   Two peers at the same cut compute the same verdict. This is what makes proof portable
   across the federation without a trusted authority.

## Field-state valuations

Append-only valuations (truth, field, activation families) bind to a cut the same way, but
with weaker obligations than proof:

- Valuations are **frame-stamped** with the writing peer's local head at write time.
- Truth/field revision under PLN composes valuations across cuts; the composed value is
  itself frame-relative (valid at the join of the input cuts).
- Activation (ECAN) is explicitly allowed to be cut-relative and approximate — it affects
  ranking, never correctness, so eventual consistency is acceptable with no re-check
  obligation.

## Read semantics

A federated read specifies (or defaults) a cut:

- **`AT(cut)`** — read the AtomSpace as linearized at an explicit cut. Reproducible,
  proof-honoring, the default for any proof-sensitive query.
- **`LATEST`** — read the peer's current best linearization. Convenient, but proofs
  attached to results carry their own `derived_against` and may be out-of-frame relative
  to `LATEST`; the reader is told so explicitly.

The query surface MUST surface a proof's frame status (`in-frame` / `out-of-frame`) in
results. It MUST NOT collapse an out-of-frame proof into a truth/confidence score.

## Conflict and fork resolution

- Autobase linearization decides the **order** of unproven operations. That is a ranking/
  ordering concern and may reorder freely.
- Proofs constrain nothing about global order; they only assert "given these ops in this
  relative order, this statement holds." Forks therefore never *conflict with* proofs —
  they either preserve a proof's dependency order (proof stays in-frame) or they don't
  (proof goes out-of-frame and is re-checked). There is no third outcome, and none of them
  is a silent downgrade.

## Invariants (must hold in every conformance run)

- P1. Every `ProofArtifact` has a non-empty `derived_against`.
- P2. No code path converts an out-of-frame proof into a truth/activation value.
- P3. Re-check at a fixed cut is deterministic and peer-independent.
- P4. Append-only extension beyond a proof's dependency set never changes its verdict.
- P5. A read that returns a proof also returns its frame status relative to the read cut.

## Open questions

- Cut compaction: version vectors grow with the writer set; needs a checkpoint/GC story
  aligned to Hyperbee snapshots so cuts stay bounded.
- Cross-cut proof composition: proving a statement whose witnesses come from disjoint cuts
  (join semantics, and whether the joined proof is stronger or merely conjunctive).
- Revocation: a signed op cannot be unwritten, so "retraction" is a forward append; proof
  interaction with retraction ops needs its own contract.
