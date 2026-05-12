# HellGraph Cypher Facade v0.1

## Purpose

Provide a human- and agent-friendly operational query surface over the native hypergraph kernel.

The facade is:
- Cypher/GQL-shaped
- not a promise of total historical Cypher parity
- lowered into native hypergraph pattern IR
- compatible with a curated openCypher/GQL-aligned subset
- extended with one native hyperedge clause

## Design Rules

1. Facade syntax never defines canonical semantics.
2. All queries execute against a declared or inherited snapshot and epistemic mode.
3. The facade compiles to native pattern IR.
4. Planner hints affect access path only, never result correctness.
5. Hyperedges are first-class; they are not forced into binary projections for native execution.

## Supported v0.1 Clause Set

- `USE SPACE`
- `MATCH`
- `OPTIONAL MATCH`
- `WHERE`
- `WITH`
- `RETURN`
- `ORDER BY`
- `LIMIT`
- `UNWIND`
- `CREATE`
- `MERGE` (restricted to identity-safe types)
- `SET`
- `DELETE`
- `DETACH DELETE`
- `EXPLAIN`
- `PROFILE`

## Native Extension

### MATCH LINK

Purpose:
- match native n-ary / hyperedge atoms directly
- bind link atom plus named role bindings

Syntax:

```cypher
USE SPACE secops

MATCH LINK d:Decrypt(caller=p, key=k, artifact=a, service=s)
WHERE d.`proof.current`.verdict = 'Violated'
RETURN p, k, a, s
```

Semantics:
- `d:Decrypt(...)` matches a LinkAtom of type `Decrypt`
- named role bindings constrain role membership
- omitted roles remain unconstrained
- role target types are validated using the native type schema

## Binary Pattern Compatibility

Binary projection syntax remains available for eligible link types:

```cypher
MATCH (p:Principal)-[r:OWNS]->(a:Artifact)
WHERE r.`tv.default`.confidence > 0.9
RETURN p, a
```

This is valid only when the underlying `TypeSchema` provides a binary projection.

## Property Access

Facade property access is a projection over valuations:

- `n.name` => latest visible `prop.name`
- `r.`tv.default`.confidence` => derived view from TruthValue
- `x.`proof.current`.verdict` => current ProofValue verdict
- `x.`field.current`.epsilon_eff` => FieldValue metric
- `labels(n)` => type lineage projection
- `type(r)` => type name of a LinkAtom

## Update Semantics

### CREATE
Creates new immutable atoms and initial valuations.

### MERGE
Restricted in v0.1 to identity-safe patterns that can be anchored by:
- canonical identity keys
- schema-declared uniqueness policy
- or imported IRI identity

### SET
Appends new valuations.
Does not mutate atom structure.

### DELETE / DETACH DELETE
Default semantics:
- logical retirement / tombstoning
- not immediate physical deletion

Physical GC is a storage policy concern, not a facade concern.

## Path Semantics v0.1

Supported path semantics:
- fixed-length patterns
- constrained variable-length traversal with explicit bounds
- no unrestricted recursion
- no implicit path-truth aggregation without declared policy

### Path Result Model

```rust
struct PathBinding {
    nodes: Vec<AtomId>,
    links: Vec<AtomId>,
}
```

Path bindings may optionally expose:
- path length
- path truth aggregate (only if explicitly requested and operator policy exists)
- path proof status (blocking if any required step is violated)

## Query Hints

Supported hint categories:
- exact/type/property index hints
- role-target posting hints
- text index hints
- vector index hints

Hints never change result set correctness.

## Planner IR

Compilation target:

```rust
enum PatternAtom {
    NodePattern { alias: String, type_filter: Vec<TypeId> },
    LinkPattern { alias: String, type_filter: Vec<TypeId>, roles: Vec<(RoleId, String)> },
    BinaryPattern { src: String, rel: String, dst: String, rel_type_filter: Vec<TypeId> },
}

enum PlanOp {
    ScanType,
    SeekProperty,
    SeekRoleTarget,
    ExpandBinary,
    ExpandLinkRoles,
    Filter,
    Project,
    Join,
    LeftJoin,
    Aggregate,
    Sort,
    Limit,
    Unwind,
}
```

## Index Families

### Structural / exact
- `type_index`
- `type_property_index`
- `role_target_postings`
- `space_context_index`
- `time_visibility_index`

### Semantic
- `text_index`
- `vector_index`

## Truth / Proof / Field Interaction

### Query semantics
- truth values may be filtered or projected
- proof values may be filtered or projected
- field values may be filtered or projected

### Decision semantics
When a query result feeds a decision:
- proof verdict precedence must be honored
- truth confidence cannot override `Violated`
- activation may reorder results, not alter correctness

## Conformance Harness

The facade must ship with:
1. curated openCypher/GQL-aligned subset cases
2. native `MATCH LINK` cases
3. retirement/update semantics cases
4. path semantics cases
5. planner-hint non-semantic-change cases

## Acceptance Criteria

The facade is conformant when:
- supported clauses lower into native IR deterministically
- `MATCH LINK` operates directly on hyperedges
- binary projection queries work only on explicitly eligible types
- `SET` appends valuations rather than mutating atoms
- `DELETE`/`DETACH DELETE` perform logical retirement by default
- path semantics are bounded and documented
