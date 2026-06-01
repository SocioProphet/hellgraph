# Provenance

HellGraph is a SocioProphet graph-runtime project.

## Current status

HellGraph is an alpha-stage Rust workspace for a local-first graph kernel, typed atoms, append-only valuations, proof artifacts, field-state transitions, deterministic replay, and RDF/SPARQL interoperability.

It is not currently a drop-in replacement for Blazegraph, RDF4J, Neo4j, GraphDB, Stardog, Neptune, or QLever.

## Relationship to Blazegraph

Blazegraph is treated as a behavioral reference and RDF/SPARQL compatibility oracle for relevant workloads.

HellGraph is not represented as a direct Java fork of Blazegraph unless and until a future audit proves otherwise. Contributions intended for Blazegraph upstream should be isolated as compatibility tests, benchmark reports, documentation, or narrowly scoped Java patches against Blazegraph itself.

## Clean-room posture

This repository should preserve a clean boundary between:

- HellGraph-native Rust kernel code
- RDF/SPARQL projection and import/export code
- Blazegraph compatibility tests
- third-party code imported under explicit license terms

No third-party source code should be copied into this repository without a corresponding license review and NOTICE entry.

## Release posture

Until the RDF bridge, query facade, conformance harness, and license review are complete, releases should be marked alpha.
