# NLQ Typed-Plan Compiler v0.1

Implemented in `ts/src/nlq.ts` (engine 0.4.44). This note freezes the semantics; the module
docblock carries the working detail.

## Purpose

Turn a natural-language question into a **sealed, provenance-carrying plan** over a registry of
typed Semantic Actions — without executing anything.

```
question
  → deterministic tokenization (spans preserved)
  → ontology-annotated tokens (pluggable annotators)
  → side-effect-free restricted search over the typed action registry
  → sense-metric-ranked variant plans
  → winner emitted as a sealed receipt bound to the graph snapshot
```

## Contract

Actions conform to `SemanticAction.json`, vendored from `SourceOS-Linux/sourceos-spec` (PR #210) at
`ontology/semantic-action/` and embedded by `scripts/gen-semantic-action.mjs`. Its SHA-256
(`fd01c834…`) is **asserted at import**: a drifted contract fails at load, not at plan time. The
digest is sealed into every receipt, so a plan names the exact contract it was compiled against.

`ActionRegistry.declare` validates against the schema's own bytes and additionally enforces the two
invariants the contract documents but JSON Schema cannot express — input names unique within an
action, and every constraint subject resolving to a declared input or to `output`.

## Normative rules

1. **Purity.** Search never mutates the store; `store.version()` is identical before and after.
   Applicability is decided statically, by type — nothing is executed to discover what it returns.
2. **Effects are proposed, never taken.** An action declaring `sideEffects: 'effect-request'` is a
   leaf of the dataflow: it is never offered as an input provider (consuming its output is what
   would imply running it), so it only ever appears as the plan root, carrying an
   `EffectRequestProposal` with `status: 'proposed'`. The MPCC lifecycle (EffectRequest →
   EffectDecision → EffectRecord; decision before action) is never bypassed. Its own arguments may
   still be computed by pure actions — computing an argument is not taking the effect.
3. **Mentions are not values.** An annotated concept is evidence a *type* is in play, not that a
   *value* is in hand. Non-literal slots must be filled by an action that produces the value or by a
   declared registry default. This is what forces decomposition (`GetContactLists ← GetOrganization`)
   instead of a single node with an imaginary argument. Literal slots — types under
   `NLQ_LITERAL_TYPE` — are the exception: there the span text IS the value.

## Typed unification

An annotation or output of type `T` binds a slot declared `U` exactly when `isA(T, U)` in the
AtomSpace `TypeLattice`, so `:ContactList` satisfies a `:List` slot by subsumption. Cardinality is
checked (a set never fills a single-valued slot) and `constraints` are evaluated statically;
`instanceOf` is necessarily approximated by the same subsumption check at search time, since no
values exist yet — an executor re-checks it for real. Every binding records a `SubsumptionWitness`.

## Sense metric

| axis | meaning |
| --- | --- |
| `coverage` | content tokens the plan consumes, over content tokens available |
| `groundedness` | mean admissibility-discounted node weight; `creativity = 1 − groundedness` |
| `similarity` | concordance of the plan's pre-order walk with left-to-right question order |

`composite = coverage·w.coverage + groundedness·w.groundedness + similarity·w.similarity`, weights
explicit in the result (default `0.5 / 0.3 / 0.2`).

Every plan node **not** grounded in a token span or a registry default is an invention, so it is
routed through `admitClaim` as a `model-generated` claim and its weight becomes the admissibility
discount (×0.5). The creativity penalty *is* the opinion discount — one mechanism, not a parallel
heuristic. Under `admissibility: { allowOpinion: false }` an invented node is inadmissible and the
whole variant is dropped: an excluded claim carries weight 0 and must not enter the reasoning
context at all. A question the registry cannot serve then yields **no** variants rather than a guess.

The `similarity` prior (English questions run outer-intent → inner-argument) is a stated prior, not
a law: it is one weighted axis, never a filter.

## Sealing

`sha256` over the ranked output + `{seq, nodes, edges}` snapshot + the pinned contract digest,
matching `enrich` / `explore`. `seq` is the store's monotonic logical clock — the real receipt
binding, since counts alone collide. Same inputs against the same graph state ⇒ byte-identical seal.
