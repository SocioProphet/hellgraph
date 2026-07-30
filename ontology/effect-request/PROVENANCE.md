# EffectRequest — proposed-side-effect contract (vendored)

**File:** `EffectRequest.json`
**SHA-256:** `99829aa50b0ebb7d663072028c37e3a29cf4cb6d2fbbbe5d6af0dda979264084`
**Bytes:** 5,743 (trailing newline preserved — the hash is over raw bytes)
**Schema `$id`:** `https://schemas.srcos.ai/v2/EffectRequest.json`
**Contract version:** `specVersion` const `0.1.0`
**Retrieved:** 2026-07-29

## Source
- **`SourceOS-Linux/sourceos-spec`** @ `origin/main`, path `schemas/EffectRequest.json`
- Commit `487e4b614b79e556af3aea2c70471eca13281377` (2026-07-28,
  "schemas: MPCC event contract v0.1 — conversation + trading event family")
- Merged in **PR #204** (`b6506bd`).
- The bytes are unchanged between `487e4b61` and `origin/main` (`f656559c`) at time of vendoring,
  and are byte-identical to the copy `prophet-platform/apps/hellgraph-service/src/schemas/`
  already pins in `contract.ts` — the same digest, independently arrived at.

## What it is
The **EffectRequest** contract: a *proposed* side effect. Its own description states the rule this
module exists to obey — "a requested effect is a proposal only: it is not permission, not
execution, and not evidence that anything happened." Lifecycle: EffectRequest (requested) →
EffectDecision (approved / denied / deferred / expired / revoked) → EffectRecord (what actually
happened). Decision before action.

`ts/src/vendor-graph.ts` emits one of these when the derived staleness verdict says a pin should
move. The engine **never executes** the re-vendor, exactly as `ts/src/nlq.ts`'s restricted search
never executes an action: it emits a proposal and stops. Membrane approval happens outside the
engine, and only an approving `EffectDecision` may cause anything to be re-vendored.

## Why vendored
Validation must need no network and no spec checkout. The SHA-256 is asserted **at import**
(`ts/src/effect-request-data.ts` via `ts/src/vendor-graph.ts`): a drifted or hand-edited copy
fails LOUDLY at load, never silently when a proposal is emitted. A proposal that does not conform
to the estate's own effect contract cannot be carried by the estate's spine, so the contract
itself must be tamper-evident.

Note the recursion, and that it is not decoration: this vendored copy is exactly the kind of
object `registry/vendor-freshness.yaml` governs — it is declared there as
`sourceos-spec-schemas@hellgraph-service`, with upstream **unobserved**. The contract this plane
speaks is subject to this plane.

## Validation coverage, honestly
The proposal is validated against these bytes by the same JSON-Schema subset validator
`ts/src/nlq.ts` uses (`validateAgainst`), whose implemented keyword set is asserted over this
schema at import — an unimplemented keyword fails loudly rather than silently validating less
than the contract says.

`format` is part of that bar, and it is checked by **value**, not by name: the validator implements
`uri` and `date-time` (`FORMAT_CHECKS` in `nlq.ts`), and a schema declaring any other one — `email`,
`uuid` — fails loudly at import instead of clearing the bar and then being validated for everything
except the constraint it declares. So `requestedAt`'s `format: "date-time"` is enforced by the
shared validator, for this contract and every other one.

It was not always. Until the fix, `format` was admitted as a bare keyword and enforced only for
`uri`, which meant this contract declared `date-time` and nothing checked it; `vendor-graph.ts`
carried a private regex at the `proposeRevendor` call site to cover the field. That regex is gone —
the call site now asks the one implementation (`matchesFormat`). It still fails loudly there rather
than recording a `contractViolations` entry, because `analyzeVendorFreshness` seals whatever
proposals it is handed without reading that array: a bad instant must stop the run, not ride inside
the seal.

## Regeneration
The embedded copy the engine ships (`ts/src/effect-request-data.ts`) is generated from this file
by `scripts/gen-effect-request.mjs` — the engine bundles to a single file per format
(`tsup.config.ts`), so there is no runtime asset to read; the schema ships embedded exactly as
KKO and SemanticAction do. Re-vendor by copying the file byte-identically from `sourceos-spec`,
updating this block, then:

```bash
node scripts/gen-effect-request.mjs   # rewrites ts/src/effect-request-data.ts (text + pinned sha)
npm run build                         # rebuild ts/dist
```

Commit both the `.json` and the regenerated `effect-request-data.ts`.
