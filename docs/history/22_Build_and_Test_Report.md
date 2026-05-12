# Build and Test Report

Workspace: `hellgraph_workspace_v0_4`

## Commands run

- `cargo test --workspace`

## Results

- `hg_core`: 0 unit tests, pass
- `hg_fieldpack`: 2 unit tests, pass
- `hg_kernel`: 5 unit tests, pass
- `hg_proof`: 2 unit tests, pass
- `hg_runtime`: 3 unit tests, pass
- Total unit tests passed: 12
- Total unit tests failed: 0
- Doc-tests: all passed

## Verified phase goals

- real Cargo workspace manifests: yes
- checksummed journal frames: yes
- manifest sidecar: yes
- checkpoint + compaction + reopen: yes
- richer proof artifact payloads: yes
- migration skeleton for canonical pack: yes
