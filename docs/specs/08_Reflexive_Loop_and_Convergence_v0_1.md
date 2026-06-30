# Reflexive Loop and Convergence v0.1

## Purpose

Define the buildable core of the bidirectional epistemology/ontology engine over the
HellGraph hypergraph kernel:

- the hyperedge operations that move work in both directions (ontology -> epistemology
  and epistemology -> ontology)
- the convergence/fixpoint criterion ("truth is what survives the loop") as a concrete,
  checkable graph condition
- how the loop binds to the reasoning-evidence fabric and the authored-canon
  system-of-record, which remain authority

This spec adds no new value families and no new epistemic modes. It is an overlay
expressed entirely in the existing kernel vocabulary from
`02_Epistemic_Modes_and_Assertion_Model.md` and `03_Kernel_IDL_v0_1.md`.

## Scope Boundary (metaphor vs. mechanism)

The source material motivates this loop with a Hopf-fibration / `S^n` image
(ontology and epistemology as projections of one space, divergence as a misaligned
fiber, convergence as resonance). That image is **motivating metaphor only**.

Non-negotiable for this spec:

- no `S^n` topology, fibration math, or sphere/dimension counts appear in any contract
- no derived physics or topology numbers are computed, stored, or gated on
- "resonance" and "alignment" are defined here strictly as graph predicates over
  atoms, valuations, and the four value families — never as topological quantities

Everything below is falsifiable graph state. If a clause cannot be checked against the
kernel and the evidence fabric, it does not belong in this spec.

## Conceptual Grounding

The hypergraph is the **reflexive substrate**: a base over which two reasoning passes
operate and leave append-only valuations. It is not the authority for truth. Authority
stays where the kernel already puts it:

- `ProofValue` for hard gates (deterministic checker verdicts)
- `TruthValue` for evidence-bearing belief (non-authoritative for gating)
- the authored-canon system-of-record for what a model is *supposed* to be
- the reasoning-evidence fabric for what was actually reasoned and observed

The loop only *moves* work between an ontology view and an epistemology view of the
same atoms and records whether the two views agree.

### Two views, one graph

- **Ontology view** — the `Structural` atoms (`TypeSchema`, role specs, identity links,
  schema packs) plus the `Assertion` atoms that a structured model commits to. This is
  "the map".
- **Epistemology view** — the `Executable` atoms (queries, rules, inferences), the
  `Event` atoms they consume, and the `Assertion`/`State` valuations they produce. This
  is "the act of knowing".

Both views are projections over the same immutable atoms. A loop pass reads one view,
runs an operator family, and appends valuations that the other view can read on the next
pass. No atom is mutated; convergence is observed across snapshots, not by overwriting.

## Reflexive Operations

All operations are pass-scoped: each runs against a declared snapshot and an inherited
or declared `EpistemicMode` (Rule 5 of `02_*`). All produced links are native
`LinkAtom`s (n-ary hyperedges via `MATCH LINK` semantics), never silently flattened to
binary.

### Reserved overlay types

These extend the schema registry; they do not change kernel laws.

```rust
// Native LinkAtom types introduced by the reflexive overlay.
// All are versioned through schema packs like any other TypeSchema.
enum ReflexiveLinkType {
    // ontology -> epistemology
    HypothesisOf,      // links a model fragment to a generated, testable claim
    ChallengeOf,       // links an inference run to the model claim it tests

    // epistemology -> ontology
    PatternEvidence,   // links observed/queried atoms to a surfaced regularity
    ModelProposal,     // links surfaced regularity to a proposed/refined model fragment

    // loop bookkeeping (both directions)
    LoopPass,          // one ordered pass over the substrate; carries provenance
    Reconciliation,    // binds an ontology claim and its epistemology verdict per pass
}
```

Each `ReflexiveLinkType` is an `AssertionClass::Executable` or `AssertionClass::Assertion`
carrier per the attachment rules in `02_*`:

- `HypothesisOf`, `ModelProposal` -> `Assertion` (claim-bearing; may carry `TruthValue`)
- `ChallengeOf`, `PatternEvidence`, `LoopPass`, `Reconciliation` -> `Executable`
  (carry provenance, activation, proof-of-well-formedness; do not carry `TruthValue`)

### Direction A — Ontology -> Epistemology

From a structured model fragment, generate testable claims, then run reasoning against
the model to validate or challenge them.

1. **Generate hypotheses.** For a selected ontology fragment (a set of `Structural` and
   `Assertion` atoms under a schema pack), emit `HypothesisOf` hyperedges. Each binds the
   source model fragment to a new `Assertion` atom expressing a checkable claim.
   - mode: typically `Counterfactual` ("if the model holds, then ...") or
     `BoundedSnapshot` when the claim is about a concrete evidence window
   - the hypothesis `Assertion` carries a `TruthValue` with `TruthMode::Derived`
2. **Challenge by reasoning.** For each hypothesis, run an `Executable` (query/rule/proof
   check) against the snapshot, emitting a `ChallengeOf` hyperedge bound to:
   `{ hypothesis, executable, evidence_atoms[], snapshot_txn }`.
   - if a proof checker applies, the run yields a `ProofValue` (`Proved` / `Violated` /
     `Inconclusive`) under `BoundedSnapshot`
   - otherwise it yields a `TruthValue` update on the hypothesis (`TruthMode::Empirical`
     or `Derived`), never a proof
3. **Record outcome.** The verdict is attached as a valuation on the hypothesis atom
   (`proof.current` or `tv.default`). Per Rule 1 of `02_*`, a `ProofValue::Violated`
   here cannot be overridden by `TruthValue` or `ActivationValue`.

### Direction B — Epistemology -> Ontology

From querying/reasoning/linking, surface regularities, then propose or refine the model.

1. **Surface patterns.** Over the `Event`/`State`/`Assertion` atoms produced by exploration,
   emit `PatternEvidence` hyperedges binding the observed atoms to a candidate regularity
   (a new `Assertion` atom). Mode is usually `OpenWorld` (absence is unknown, not false)
   or `BoundedSnapshot` when the pattern is claimed only within a window.
2. **Propose model refinement.** From a supported regularity, emit a `ModelProposal`
   hyperedge binding the regularity to a proposed `Structural` change (new type, role,
   identity/canonicalization link, or schema-pack delta).
   - a `ModelProposal` is **not** asserted as actual model state; it is a proposal atom.
     Promotion into the ontology view requires explicit canon admission (see
     "Binding to authored-canon" below). This mirrors Rule on `Counterfactual` /
     `Simulation`: derived/synthetic results are not promoted without explicit action.
3. **Identity discipline.** Any proposed merge/alias/supersession uses the existing
   `IdentityLinkType` (`SameAs`, `Canonicalizes`, `Supersedes`, `AliasOf`, `ImportedFrom`).
   Imported and native identity must not be silently collapsed (`03_*` identity rules).

### Pass structure

```rust
struct LoopPass {
    pass_id: AtomId,              // the LoopPass LinkAtom
    direction: LoopDirection,     // OntologyToEpistemology | EpistemologyToOntology
    base_snapshot_txn: TxnId,     // snapshot the pass read
    result_txn: TxnId,            // txn under which this pass's valuations became visible
    epistemic_mode: EpistemicMode,
    provenance: ProvenanceRef,    // required; ties pass to the reasoning-evidence fabric
}

enum LoopDirection {
    OntologyToEpistemology,
    EpistemologyToOntology,
}
```

Rules:

- a pass appends only; it never mutates prior atoms or valuations
- a pass with no readable provenance into the evidence fabric is non-conformant
- the two directions alternate or interleave; convergence is evaluated across the
  resulting sequence of `result_txn` snapshots

## Convergence / Fixpoint Criterion

"Truth is what survives the loop" is defined as a **reconciliation fixpoint** over
repeated passes: a model claim and its epistemic verdict stop changing across successive
passes, and the change they would induce in the other view is null.

This is a concrete graph condition, not a topological one.

### Reconciliation object

For each ontology claim under evaluation, every pass emits one `Reconciliation` hyperedge:

```rust
enum ReconcileState {
    Convergent,    // claim and verdict agree and are stable this pass
    Divergent,     // claim and verdict disagree (misalignment)
    Unstable,      // verdict or claim changed vs. the previous pass
    Insufficient,  // not enough evidence in snapshot to decide (maps to Inconclusive)
}

struct Reconciliation {
    recon_id: AtomId,             // the Reconciliation LinkAtom
    claim_atom: AtomId,           // ontology-view Assertion under test
    verdict_pass: AtomId,         // the LoopPass that produced the verdict
    proof: Option<ProofValue>,    // if a checker applied
    truth: Option<TruthValue>,    // evidence-bearing belief otherwise
    state: ReconcileState,
    prev_recon: Option<AtomId>,   // the same claim's Reconciliation in the prior pass
    snapshot_txn: TxnId,
}
```

### Per-claim convergence predicate

A claim `c` is **convergent at pass `n`** when ALL hold:

1. **Verdict agreement.** Either
   - a `ProofValue` exists with `verdict == Proved` (under its declared assumptions), or
   - no checker applies and the `TruthValue` `strength` and `confidence` both sit on the
     declared side of a per-claim policy threshold, with `contradiction` below its limit.
   A `ProofValue::Violated` makes `c` **divergent**, regardless of `TruthValue` (Rule 1).
2. **Stability.** The verdict-bearing valuation for `c` is byte-identical in value family
   and verdict to the prior pass `prev_recon`, under the same `assumptions_hash`
   (for proof) or within the declared truth-delta tolerance (for truth).
3. **Null cross-induction.** The pass in the *opposite* direction, run against `c`,
   produces no new `ModelProposal` or `HypothesisOf` that would alter `c`'s model fragment
   or its claim text. Formally: the set of proposal/hypothesis atoms newly bound to `c`'s
   fragment this pass is empty.

`Insufficient`/`Inconclusive` is never convergence; it gates or degrades (Rule 1).

### Loop fixpoint (system condition)

The loop has reached a **fixpoint over a claim set `C` and an epistemic mode** when:

- every `c` in `C` is convergent at the latest pass, AND
- a further pass in either direction produces a `Reconciliation` set whose `state` is
  `Convergent` for all `c` and whose newly emitted `HypothesisOf` / `ChallengeOf` /
  `PatternEvidence` / `ModelProposal` atoms that touch `C` is empty.

This is checkable directly: it is the standard "one more iteration changes nothing"
fixpoint test, applied to append-only valuations across two snapshots.

- **Convergence = resonance** (metaphor): the two views agree and stop moving.
- **Divergence = misalignment** (metaphor): at least one `Divergent`/`Unstable` claim
  remains; the loop must run again or the disagreement is surfaced for governance.

### Termination and non-convergence

- a maximum pass budget per claim set is declared on the driving `Executable`; exhausting
  it without fixpoint yields a `Divergent`/`Unstable` residual that is reported, not hidden
- oscillation (a claim alternating `Convergent`/`Divergent` across passes) is detected via
  the `prev_recon` chain and reported as non-convergent; activation must not be used to
  damp or hide it (Rule 2)
- non-convergence is a first-class result, not an error to be smoothed over

## Binding to the Reasoning-Evidence Fabric

The evidence fabric is the authority for *what was reasoned and observed*. The loop does
not replace it; every pass writes into it.

- each `LoopPass` and `ChallengeOf` carries a `ProvenanceRef` (`03_*`) whose
  `artifact_id` resolves to an evidence-fabric run record (the SocioProphet
  `ReasoningRun`/`Event`/`Receipt` lineage used across the platform). A pass without
  resolvable provenance is non-conformant.
- proof outcomes use the existing `ProofArtifact` / `CounterExampleArtifact` contracts
  (`06_FieldProof_Pilot_v0_1.md`): a `Reconciliation` carrying `ProofValue::Violated` must
  reference a counterexample artifact; `Proved` must reference a witness or certification
  trace.
- deterministic replay (`06_*`) extends to the loop: the same base snapshot + same
  `Executable` + same checker seed must reproduce the same `Reconciliation` set. Replay is
  how a survived-the-loop claim is independently re-checked.
- `Simulation`/`Counterfactual` passes carry mode-specific synthetic provenance and must
  not silently mix with `Empirical` observed facts (acceptance criteria of `02_*`).

## Binding to the Authored-Canon System-of-Record

Authored canon is the authority for *what the model is supposed to be*. The hypergraph is
the reflexive substrate where proposals are explored; it is not self-authorizing.

- `ModelProposal` atoms produced by Direction B are candidate ontology changes. They sit
  in the epistemology view as proposals and are **never** promoted to authoritative
  `Structural`/`Assertion` model state by the loop itself.
- promotion is an explicit canon-admission step (a governed `Executable`) that:
  1. reads the convergence predicate — only `Convergent` proposals are eligible
  2. records an `EpistemicMode` and the proof/truth dependency on the resulting
     `Recommendation Object` (per the Recommendation Object Rules in `02_*`:
     mode + value-family dependencies + whether blocked/gated/degraded/allowed)
  3. emits the admission as a new schema-pack delta or identity link, versioned through
     the existing `SchemaPack` mechanism (`03_*`)
- canonicalization decisions remain explicit graph facts (`03_*` identity rules). A loop
  that merges identities without an explicit `IdentityLinkType` fact is non-conformant.
- the authored-canon glossary/definitions remain frontier-authored, not loop-authored:
  the loop may *surface* a term or regularity (`PatternEvidence`) and *propose* a model
  change (`ModelProposal`), but the authoritative definition admitted into canon is
  authored, not minted by the substrate.

Authority order is unchanged: **proof gates, canon defines, evidence records, the loop
proposes and measures agreement.**

## Recommendation Object Interaction

When a loop result feeds a decision, the `Recommendation Object` must record (extending
`02_*` and `06_*`):

- epistemic mode of the deciding pass
- the `ReconcileState` and, if present, the `ProofValue::verdict`
- value-family dependencies (truth / proof / field / activation)
- whether the recommendation was blocked, gated, degraded, or allowed

Hard rules (inherited, restated for the loop):

- `Divergent` with `ProofValue::Violated` cannot be ranked into eligibility by truth or
  activation
- `Insufficient`/`Inconclusive` cannot be promoted to `Convergent` by activation
- only `Convergent` claims are eligible for canon admission

## Conformance / Acceptance Criteria

The reflexive loop overlay is conformant when:

- every pass declares or inherits an `EpistemicMode` and carries resolvable evidence-fabric
  provenance
- all reflexive links are native `LinkAtom`s and are not forced into binary projection for
  native execution
- the per-claim convergence predicate is computed only from the four value families and the
  `prev_recon` chain — never from any topological/`S^n` quantity (none exist in this overlay)
- `ProofValue::Violated` always yields `Divergent` and is never overridden by truth or
  activation
- `ModelProposal` atoms are never promoted to authoritative model state without an explicit,
  governed canon-admission `Executable`
- identity merges occur only through explicit `IdentityLinkType` facts
- the loop fixpoint is reproducible under deterministic replay from a base snapshot
- non-convergence and oscillation are reported as first-class results, not suppressed

## Non-goals for v0.1

- topological/fibration computation of any kind (explicitly out of scope; metaphor only)
- automatic, ungoverned promotion of proposals into canon
- multi-user fiber/perspective modeling beyond per-pass `EpistemicMode` and provenance
- generalized theorem proving beyond the one proof family in `06_*`
- distributed/federated loop execution
- truth propagation across joins without the explicit operator policy required by `02_*`
