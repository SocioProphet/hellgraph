# HellGraph Kernel IDL v0.1

## Canonical Kernel Theorem

The canonical kernel consists of:
- immutable typed atoms
- append-only versioned valuations
- explicit spaces
- explicit type schemas
- explicit temporal scopes
- explicit provenance
- explicit security labels

Everything else is an overlay or a projection.

## Primitive IDs

```rust
type SpaceId      = u64;
type AtomId       = u128;
type TypeId       = u64;
type RoleId       = u64;
type KeyId        = u64;
type TxnId        = u64;
type ArtifactId   = u128;
type IdentityId   = u128;
type SchemaPackId = ArtifactId;
```

## Spaces

```rust
struct Space {
    space_id: SpaceId,
    name: String,
    schema_pack: SchemaPackId,
    created_txn: TxnId,
    retired_txn: Option<TxnId>,
}
```

Rules:
- every atom belongs to exactly one space
- cross-space references are allowed only when explicitly declared
- space is a semantic and governance boundary, not a full security substitute

## Atom Structure

```rust
enum AtomKind {
    Node,
    Link,
}

struct AtomHeader {
    atom_id: AtomId,
    kind: AtomKind,
    type_id: TypeId,
    space_id: SpaceId,
    created_txn: TxnId,
    retired_txn: Option<TxnId>,
    canonical_hash: [u8; 32],
}
```

### NodeAtom

```rust
struct NodeAtom {
    hdr: AtomHeader,
}
```

### LinkAtom

```rust
struct RoleBinding {
    role_id: RoleId,
    target: AtomId,
    ordinal: u16,
}

enum LinkSemantics {
    DirectedBinary,
    OrderedNary,
    UnorderedNary,
    SetLike,
    MultiSetLike,
}

struct LinkAtom {
    hdr: AtomHeader,
    semantics: LinkSemantics,
    members: Vec<RoleBinding>,
}
```

Rules:
- atom structure is immutable
- changing type, role bindings, or member set creates a new atom
- retirement is logical by default; physical reclamation is a later storage concern

## Type System

```rust
struct RoleSpec {
    role_id: RoleId,
    name: String,
    min_cardinality: u16,
    max_cardinality: Option<u16>,
    ordered: bool,
    allowed_target_types: Vec<TypeId>,
}

struct BinaryProjection {
    src_role: RoleId,
    dst_role: RoleId,
}

enum RdfProjectionKind {
    Class,
    PredicateBinary,
    RdfStarCompatible,
    ReifiedAssertion,
    Opaque,
}

struct TypeSchema {
    type_id: TypeId,
    name: String,
    atom_kind: AtomKind,
    assertion_class: AssertionClass,
    parents: Vec<TypeId>,
    roles: Vec<RoleSpec>,
    allowed_keys: Vec<KeyId>,
    binary_projection: Option<BinaryProjection>,
    rdf_projection: RdfProjectionKind,
    created_txn: TxnId,
    retired_txn: Option<TxnId>,
}
```

Rules:
- role cardinality and target-type constraints are enforced on write
- type inheritance is monotone within a schema pack version
- projection behavior must be explicit

## Identity and Schema Evolution

```rust
enum IdentityLinkType {
    SameAs,
    Canonicalizes,
    Supersedes,
    ImportedFrom,
    AliasOf,
}

struct SchemaPack {
    pack_id: SchemaPackId,
    version: u32,
    name: String,
    created_txn: TxnId,
    parent_pack: Option<SchemaPackId>,
}
```

Rules:
- imported identity and native identity must not be silently collapsed
- canonicalization decisions must be explicit graph facts
- schema evolution occurs through versioned schema packs and migration plans

## Temporal Model

```rust
struct TemporalScope {
    txn_from: TxnId,
    txn_to: Option<TxnId>,
    valid_from_micros: Option<i64>,
    valid_to_micros: Option<i64>,
    observed_at_micros: Option<i64>,
}
```

Interpretation:
- `txn_*` = database visibility time
- `valid_*` = time in the modeled world
- `observed_at_micros` = when the evidence was observed/captured

## Provenance

```rust
struct ProvenanceRef {
    artifact_id: ArtifactId,
    source_atom: Option<AtomId>,
    signer_atom: Option<AtomId>,
    note: Option<String>,
}
```

Rules:
- provenance is required for TruthValue, ProofValue, FieldValue, and all imported atoms
- synthetic and simulated artifacts must be marked as such in associated metadata

## Security Model

```rust
enum SecurityLabel {
    Public,
    Internal,
    Confidential,
    Restricted,
    LocalOnly,
}
```

Rules:
- security can be attached at atom level, valuation level, and artifact level
- export decisions must consider all three

## Value System

```rust
enum ScalarValue {
    Bool(bool),
    I64(i64),
    F64(f64),
    Decimal(String),
    Text(String),
    Bytes(Vec<u8>),
    Iri(String),
    DateTimeMicros(i64),
    DurationMicros(i64),
}

enum ValuePayload {
    Scalar(ScalarValue),
    List(Vec<ValuePayload>),
    Map(Vec<(KeyId, ValuePayload)>),
    Truth(TruthValue),
    Proof(ProofValue),
    Field(FieldValue),
    Activation(ActivationValue),
    Embedding(EmbeddingRef),
    Provenance(ProvenanceRef),
}
```

### Valuation

```rust
struct Valuation {
    subject_atom: AtomId,
    key_id: KeyId,
    payload: ValuePayload,
    scope: TemporalScope,
    provenance: ProvenanceRef,
    security: SecurityLabel,
    epistemic_mode: EpistemicMode,
}
```

Rules:
- valuations are append-only
- latest-visible lookup is resolved under snapshot visibility and temporal filtering
- no in-place mutation of valuation history
- values are immutable once written

## Value Families

### TruthValue

```rust
enum TruthMode {
    Empirical,
    Derived,
    Imported,
    PolicyPrior,
    Simulated,
    Counterfactual,
}

struct TruthValue {
    alpha: f64,
    beta: f64,
    prior_mass: f64,
    contradiction: f32,
    mode: TruthMode,
}
```

Derived views:
- `strength = alpha / (alpha + beta)` when denominator > 0 else 0.5
- `confidence = (alpha + beta) / (alpha + beta + prior_mass)`

### ProofValue

```rust
enum ProofVerdict {
    Proved,
    Violated,
    Inconclusive,
}

struct ProofValue {
    verdict: ProofVerdict,
    checker_type: TypeId,
    assumptions_hash: [u8; 32],
    witness_artifact: Option<ArtifactId>,
    counterexample_artifact: Option<ArtifactId>,
    margin: Option<f64>,
}
```

### FieldValue

```rust
struct DimValue {
    domain_tag: TypeId,
    repr: ValuePayload,
}

struct FieldValue {
    field_pack: ArtifactId,
    basis_version: u32,
    dims: Vec<DimValue>,
    epsilon_eff: f64,
    bound_atom: AtomId,
}
```

### ActivationValue

```rust
struct ActivationValue {
    salience: f32,
    recency_score: f32,
    cache_heat: f32,
    decay_half_life_secs: Option<f32>,
}
```

## Reserved Key Families

- `prop.*`
- `tv.default`
- `proof.current`
- `field.current`
- `prov.bundle`
- `time.interval`
- `security.label`
- `embed.*`
- `score.activation`
- `policy.*`
- `reasoning.mode`

## Snapshot Semantics

A snapshot is defined by:
- transaction visibility cutoff
- optional valid-time filter
- optional observed-time filter
- security context
- epistemic mode

A query result is correct only with respect to a snapshot and mode.

## Storage Contracts

The kernel requires implementations of:

```rust
trait AtomStore;
trait ValuationStore;
trait SnapshotStore;
trait SpaceCatalog;
trait SchemaRegistry;
trait ArtifactStore;
trait IdentityIndex;
```

No physical storage engine is mandated by this IDL.

## Acceptance Criteria

The kernel is conformant when:
- atom immutability is enforced
- valuations are append-only
- snapshot visibility is deterministic
- role/cardinality checks are enforced
- value families remain distinguishable in storage and APIs
- identity/schema evolution is versioned and auditable
