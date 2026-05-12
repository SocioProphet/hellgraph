# Actual workspace and test status

Workspace root: `hellgraph_workspace_v0_3/`

Crates:

- `hg_core`
- `hg_fieldpack`
- `hg_proof`
- `hg_kernel`
- `hg_runtime`

Tested claims for this phase:

- the workspace is real and buildable
- field/proof values can be published in one transaction
- proof artifacts are stored and referenced from proof values
- append-only journal replay reconstructs visible state
- checkpoints round-trip kernel state
