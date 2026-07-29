# SemanticAction — typed-action registry contract (vendored)

**File:** `SemanticAction.json`
**SHA-256:** `fd01c834f5ca9bbaf524ea777a37cdd7fecdb3a12468b46b18de3244bc741eda`
**Bytes:** 8,974 (trailing newline preserved — the hash is over raw bytes)
**Schema `$id`:** `https://schemas.srcos.ai/v2/SemanticAction.json`
**Contract version:** `specVersion` const `0.1.0`
**Retrieved:** 2026-07-29

## Source
- **`SourceOS-Linux/sourceos-spec`** @ `origin/main`, path `schemas/SemanticAction.json`
- Commit `ee7e43a42d5b3c30897eee296832ca127e8f6099` (2026-07-29,
  "schemas: KnowledgeNugget + SemanticAction v0.1 — L2 content grain + typed-action registry")
- Merged in **PR #210** (`b532d918f03fa10be1a48e7c08e79451b06e7fbc`, 2026-07-29).
- The bytes are unchanged between `ee7e43a4` and `origin/main` at time of vendoring.

## What it is
The **SemanticAction** contract: a declarative, typed action registration that the NL→plan
compiler discovers, instantiates, and composes **by type** — ontology URIs over inputs and
output, with subsumption constraints — never by executing them. Polymorphism works via
`subClassOf`: a value binds to a slot when its type is a subclass of the slot's `typeRef`.

Its normative **search-time purity rule** is the rule `ts/src/nlq.ts` implements: actions are
side-effect-free at plan-search time, and any world-changing execution must go through the MPCC
effect lifecycle (EffectRequest → EffectDecision → EffectRecord; decision before action).
`sideEffects: "effect-request"` declares that the executor emits a *proposal* and defers;
`sideEffects: "none"` declares a pure lookup/computation. There is deliberately no vocabulary
for direct world mutation.

## Why vendored
Validation must need no network and no spec checkout. The SHA-256 is asserted **at import**
(`ts/src/semantic-action-data.ts`): a drifted or hand-edited copy fails LOUDLY at load, never
silently at `declareAction` time. The registry's whole claim is "what enters the action registry
conforms to the estate contract", so the contract itself must be tamper-evident.

## Regeneration
The embedded copy the engine ships (`ts/src/semantic-action-data.ts`) is generated from this
file by `scripts/gen-semantic-action.mjs` — the engine bundles to a single file per format
(`tsup.config.ts`), so there is no runtime asset to read; the schema ships embedded exactly as
KKO does. Re-vendor by copying the file byte-identically from `sourceos-spec`, updating this
block, then:

```bash
node scripts/gen-semantic-action.mjs   # rewrites ts/src/semantic-action-data.ts (text + pinned sha)
npm run build                          # rebuild ts/dist
```

Commit both the `.json` and the regenerated `semantic-action-data.ts`.
