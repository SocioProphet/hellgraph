# Phase 6 Audit and Runtime Seams

## What was still wrong before this phase

The Phase 5 narrative said the workspace had real per-crate manifests. It did not.

The runtime also still hard-coded two provisional assumptions in one place:

1. the active field pack was always `FieldPack-0001-Provisional`
2. the active operator semantics were always the placeholder mean-absolute-delta evaluator

That meant the narrowest remaining semantic bottleneck was not storage. It was pack/operator substitution.

## What this phase fixes

- adds actual `Cargo.toml` manifests for all five crates
- turns canonical-pack authoring from a memo into checked code
- makes runtime execution generic over both pack and operator semantics
- preserves the old convenience path for the provisional pack

## Why this matters

The system can now reject incomplete canonical-pack mappings *before* they leak into runtime use, and the runtime no longer has to be rewritten when the real operator calculus lands.
