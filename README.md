# HellGraph

HellGraph is a local-first graph runtime scaffold for field-calculus-driven evidence, proof, and persistence.

Current workspace crates:
- `hg_core` — shared core types and value families
- `hg_fieldpack` — provisional and canonical field-pack authoring/validation
- `hg_proof` — bounded-state proof checking and proof artifact shaping
- `hg_kernel` — atoms, valuations, journal, checkpoint, replay
- `hg_runtime` — event application and field/proof commit cycles
- `hg_read_kernel` — read-side snapshot summaries and incident-link inspection

Important status:
- the canonical 26-slot basis is **not yet transcribed**
- the runtime operator semantics are still **placeholder semantics**
- the query facade and RDF-star bridge are **not yet implemented**

This repo is ready to push privately, then iterate.
