# @socioprophet/hellgraph (TypeScript engine)

TypeScript OpenCog-compatible **AtomSpace metagraph engine**, extracted from the
Noetica runtime so it can be shared across projects (Noetica, prophet-platform, …).
It lives alongside the Rust `hellgraph` crate in this polyglot repo.

## What's inside
- **AtomSpace** — content-addressed (SHA1) atoms, TruthValues (PLN), AttentionValues (ECAN), pluggable backend
- **HellGraph store** — graph projection over the AtomSpace (nodes/edges/labels/properties)
- **PLN** — forward-chaining (deduction, revision, abduction)
- **ECAN** — economic attention allocation (STI/LTI/VLTI, spread, decay)
- **Pattern matcher**, **SPARQL**, **Gremlin**
- **SHACL** validation, **Turtle** parse/serialize, **Atomese** projection
- **Consolidation**, **ingestion**, **Prometheus** symbolic-regression hooks, **sidecar** bridge
- **StorageNode client** — OpenCog rocks-storage-node-style federation

## Build
```bash
npm install        # installs toolchain and builds (prepare → tsc)
npm run build      # tsc -p ts/tsconfig.json → ts/dist
npm run typecheck
```

## Consume (git dependency — no registry required)
```jsonc
// consumer package.json
"dependencies": {
  "@socioprophet/hellgraph": "git+ssh://git@github.com/SocioProphet/hellgraph.git#main"
}
```
npm clones the repo, runs `prepare` (builds `ts/dist`), and resolves `main` →
`ts/dist/index.js`. Pin to a tag for reproducibility once tagged.

```ts
import { AtomSpace, getHellGraph, forwardChain, validateGraph } from '@socioprophet/hellgraph'
```
