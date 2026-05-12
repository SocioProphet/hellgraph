# Canonical Pack Builder and Operator Injection

## New field-pack authoring path

`hg_fieldpack` now exposes:

- `CanonicalPackDraft`
- `CanonicalPackAuthoringRow`
- `OwnedFieldPack26`
- `OwnedFieldPack26::into_static()`

This means we can:

1. seed a 26-row canonical draft from the provisional pack
2. fill canonical names/domains/bounds/polarities/source-slot mappings
3. validate completeness
4. build an owned canonical pack
5. convert it to the runtime `FieldPack26`

## New runtime seam

`hg_runtime` now exposes:

- `FieldOperatorSemantics`
- `ProvisionalOperatorSemantics`
- `run_cycle_and_commit_with(...)`

This decouples runtime execution from the placeholder evaluator.

## Remaining gap

The actual 26-slot basis and operator formulas still need to be transcribed from the manuscript or provided directly. This phase does not invent them.
