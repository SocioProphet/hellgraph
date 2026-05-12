# HellGraph RDF Bridge v0.1

## Purpose

Provide standards-aligned RDF/SPARQL interoperability without making RDF the native execution kernel.

The RDF bridge is:
- a projection/import/export layer
- standards-oriented
- explicit about information loss
- layered with validation and redaction
- suitable for Blazegraph migration and external interoperability

## Bridge Modes

```rust
enum RdfMode {
    Triples,
    Quads,
    RdfStar,
    Reified,
    BinaryRdf,
}
```

## Mode Semantics

### Triples
Use for:
- simple asserted binary relationships
- class membership
- literal properties

Lossless only for RDF-native binary subset.

### Quads
Use for:
- dataset contexts
- named graph partitions
- source/context boundaries

Lossless only for RDF-native binary subset plus dataset context mapping.

### RdfStar
Use for:
- quoted statements
- annotations on statements
- provenance and qualifiers on statements
- some truth/proof metadata over statements

Lossless for quoted-binary-statement use cases that fit RDF-star terms.

### Reified
Use for:
- n-ary assertions
- complex qualifiers
- explicit assertion resources
- field/proof sidecars that cannot be represented directly

Lossless for broader assertion patterns but more verbose.

### BinaryRdf
Use for:
- efficient internal transport and replication of RDF projections
- lower parsing overhead
- lower memory pressure than text syntaxes

## Projection Rules

### Direct RDF-native projection
A native atom may project directly when:
- it is a node with a stable IRI identity
- or it is a binary-eligible link type with explicit predicate mapping

### RDF-star projection
A native assertion may project as quoted-triple-based RDF-star when:
- the underlying semantics are binary
- metadata is about that binary assertion
- no unsupported n-ary structure is required

### Reified projection
A native assertion must project as reified form when:
- it is n-ary
- it carries complex qualifiers
- it needs explicit assertion identity
- or a sidecar is required for field/proof attachment

### Opaque projection
A native atom is opaque to RDF when:
- no declared RDF projection exists
- semantics are executable-only
- or native algebraic payloads cannot be safely serialized as RDF without a sidecar

## Round-Trip Contracts

### Lossless subset
Guaranteed lossless round-trip:
- IRI-identified nodes
- binary assertion links with explicit predicate mappings
- literal properties
- named graph contexts in quad mode
- quoted binary assertions in supported RDF-star mode

### Conditionally lossless subset
Conditionally lossless with reification/sidecars:
- n-ary links
- provenance-heavy links
- truth-bearing assertions
- proof-bearing assertions
- field sidecars

### Non-lossless subset
Not guaranteed lossless:
- executable atoms
- arbitrary native algebraic payloads
- planner/explain artifacts
- activation-only semantics
- some schema-pack-native constructs unless explicitly mapped

## Import Policy

```rust
struct ImportPolicy {
    context_to_space: bool,
    preserve_iris: bool,
    mint_native_ids: bool,
    default_mode: EpistemicMode,
}
```

Default:
- RDF import uses `OpenWorld`
- imported statements retain provenance
- context/named graph may map to space or sub-context depending on import plan

## Export Policy

```rust
struct ExportPolicy {
    mode: RdfMode,
    include_truth: bool,
    include_provenance: bool,
    include_field_sidecar: bool,
    include_security_filtered_only: bool,
    shape_set: Option<ArtifactId>,
}
```

## Layered Repository Model

Copy the spirit of Repository/SAIL layering:

```text
BaseStore
  -> InferenceLayer
  -> ShaclLayer
  -> RedactionLayer
  -> RepositoryEndpoint
```

### BaseStore
- native projection materialization
- import/export staging

### InferenceLayer
- optional RDF-native entailment/materialization overlays

### ShaclLayer
- shape validation during import/export/commit boundaries

### RedactionLayer
- valuation-level and artifact-level security filtering

### RepositoryEndpoint
- SPARQL surface
- RDF serialization surface

## Validation

SHACL-style validation is required at:
- import commit
- export promotion
- bridge materialization when configured

Validation failure blocks commit/export of invalid projection states.

## BinaryRDF Profile

BinaryRDF should be supported for:
- projection replication
- checkpoint/export bundles
- internal bridge transport

Requirements:
- deterministic stream ordering when configured
- manifest with schema and mode metadata
- MIME compatibility mapping
- replay tests

## Security Model

Export must respect:
- atom-level labels
- valuation-level labels
- artifact-level labels

A proof verdict may export while a witness artifact remains local-only.

## Blazegraph Migration Path

Migration from Blazegraph proceeds through:
1. RDF dataset export from Blazegraph
2. import policy declaration
3. namespace/context mapping
4. identity/canonicalization review
5. SHACL validation
6. parity testing on supported SPARQL subset

## Acceptance Criteria

The bridge is conformant when:
- each projected atom type has explicit RDF projection rules
- lossless and lossy cases are documented
- SHACL validation can block invalid import/export commits
- RDF-star mode is supported for quoted binary assertions
- BinaryRDF transport works for internal replication/export
- SPARQL endpoint correctness is tied to the projected RDF subset, not assumed for arbitrary native atoms
