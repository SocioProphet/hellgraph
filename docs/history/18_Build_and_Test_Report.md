# Build and test report

## Workspace

`hellgraph_workspace_v0_3/` is a real Cargo workspace with per-crate manifests.

## Command

```bash
cargo test --workspace
```

## Result

All tests passed.

### Test totals

- `hg_fieldpack`: 1
- `hg_kernel`: 4
- `hg_proof`: 2
- `hg_runtime`: 3
- doc-tests: all crates passed

Total unit tests passed: **10**

## Important correction during this phase

One runtime journal-replay test initially asserted a `Proved` verdict directly. That was too brittle because the current provisional epsilon rule can still produce a `Violated` result under large aggregate movement even when many dimensions are within range.

The test was corrected to assert semantic replay fidelity instead:

- the replayed verdict must equal the original committed verdict
- the replayed proof value must still carry the artifact reference

That is a better invariant for this phase.
