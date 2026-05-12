# HellGraph

HellGraph is a local-first graph runtime for typed atoms, append-only valuations, proof artifacts, field-state transitions, deterministic replay, and RDF/SPARQL interoperability.

The project is intended to support SocioProphet's hybrid symbolic-vector knowledge engineering stack: symbolic graph identity and provenance, RDF/SPARQL bridge compatibility, proof-aware state transitions, and eventual vector/semantic retrieval bindings.

## Current workspace crates

- `hg_core` — shared core types and value families
- `hg_fieldpack` — provisional and canonical field-pack authoring and validation
- `hg_proof` — bounded-state proof checking and proof artifact shaping
- `hg_kernel` — atoms, valuations, journal, checkpoint, replay
- `hg_runtime` — event application and field/proof commit cycles
- `hg_read_kernel` — read-side snapshot summaries and incident-link inspection

## Status

HellGraph is alpha-stage.

Known gaps:

- the canonical 26-slot basis is not yet fully transcribed
- runtime operator semantics are still provisional
- RDF-star/SPARQL bridge is specified but not implemented
- Cypher/GQL-shaped facade is specified but not implemented
- conformance harnesses are not complete
- production persistence and security review are pending

## Architectural position

HellGraph is not a drop-in Blazegraph replacement.

Blazegraph remains useful as an RDF/SPARQL behavioral reference and compatibility oracle. HellGraph is a new kernel-oriented graph runtime with RDF/SPARQL projection as a bridge layer.

## Non-negotiable rules

- Graph structure is immutable after insertion.
- State changes occur through append-only valuations.
- Proof is never silently downgraded to confidence.
- Activation may affect ranking but never correctness.
- RDF is a projection bridge, not the native execution kernel.
- Query facades must not become semantic authority.
- Field packs and proof checkers must be versioned and replayable.

## Development

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## License

MIT. See `LICENSE`.

## Provenance

See `PROVENANCE.md`.
