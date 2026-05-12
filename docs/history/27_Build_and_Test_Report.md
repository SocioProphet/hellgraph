# Build and Test Report

Command run:

```bash
cargo test --workspace
```

## Unit test totals

- `hg_core`: 0
- `hg_fieldpack`: 4
- `hg_kernel`: 5
- `hg_proof`: 2
- `hg_runtime`: 4

Total unit tests passed: **15**

## Doc-tests

All doc-tests passed.

## Notable coverage improvements in this phase

- canonical-pack draft rejects incomplete mappings
- fully populated canonical draft can build an owned pack and convert to runtime static form
- runtime can execute with an injected authored pack and injected operator semantics
- real per-crate manifests exist and the workspace builds as an actual Cargo topology
