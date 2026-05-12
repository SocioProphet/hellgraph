# HellGraph Rust Workspace Map (Executable Scaffold)

## Purpose

Translate the frozen specs into a Rust workspace that another systems team can extend
without changing semantic contracts accidentally.

## Workspace Layout

```text
hellgraph_workspace_v0_1/
  Cargo.toml
  README.md
  crates/
    hg_core/
    hg_fieldpack/
    hg_proof/
    hg_runtime/
```

## Crate Responsibilities

### `hg_core`
Owns:
- ID aliases
- epistemic modes
- security labels
- truth/proof/field state types
- core enums shared by the workspace

### `hg_fieldpack`
Owns:
- `FieldPack26`
- dimension metadata
- basis fingerprinting
- pack validation
- provisional `FieldPack-0001`

### `hg_proof`
Owns:
- bounded-state checker
- proof artifact shape
- violated-dimension report
- verdict logic

### `hg_runtime`
Owns:
- deterministic event application
- state transition execution
- runtime integration of field + proof crates
- executable smoke tests

## Intentional Omissions

This scaffold does **not** yet implement:
- storage engine
- snapshots/MVCC
- Cypher parser
- RDF bridge
- SHACL
- artifact signing
- canonical cryptographic hashes

That is intentional. The goal is to land the semantics and the first proof loop first.

## Immediate Build Order

1. make `hg_core` compile cleanly
2. make `hg_fieldpack` validate the provisional pack
3. make `hg_proof` emit all three verdict classes
4. make `hg_runtime` execute one deterministic transition and checker pass
5. then connect the runtime to the future kernel/storage layer

## Why this matters

This keeps implementation honest:
- field semantics compile
- proof semantics compile
- replacement seams for the user's canonical calculus remain explicit
