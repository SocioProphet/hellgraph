/**
 * HellGraph — Sociosphere's graph substrate.
 *
 * A dual-model graph engine: a labeled property graph (TinkerPop-style nodes and
 * typed edges with properties) that also exposes an RDF triple view, so the same
 * data is queryable via Gremlin-style traversals and via SPARQL 1.1 basic graph
 * patterns. Designed for parity with Amazon Neptune / Blazegraph on the core query
 * surface, with a durable append-only log enabling point-in-time replay (the
 * Time Service).
 */

export type PropertyValue = string | number | boolean | null

export interface GraphNode {
  /** Stable IRI/identifier, e.g. "urn:noetica:interaction:abc123" */
  id: string
  /** One or more labels/types, e.g. ["Interaction", "ProviderCall"] */
  labels: string[]
  properties: Record<string, PropertyValue>
  /** Logical creation time (ISO-8601) — assigned from the write log */
  createdAt: string
}

export interface GraphEdge {
  id: string
  /** Edge type / predicate, e.g. "PRODUCED", "ROUTED_TO", "GOVERNED_BY" */
  label: string
  from: string
  to: string
  properties: Record<string, PropertyValue>
  createdAt: string
}

/** RDF triple projection of the property graph. */
export interface Triple {
  subject: string
  predicate: string
  /** Object is either a node IRI (edge) or a literal (property). */
  object: PropertyValue
  /** True when object is an IRI referring to another node. */
  isIri: boolean
  /** Logical timestamp this triple was asserted. */
  assertedAt: string
}

// ─── Write log (durability + time travel) ──────────────────────────────────────

export type LogOpKind =
  | 'add_node'
  | 'add_edge'
  | 'set_node_property'
  | 'set_edge_property'
  | 'remove_node'
  | 'remove_edge'

export interface LogEntry {
  /** Monotonic sequence number — the logical clock. */
  seq: number
  /** Wall-clock timestamp (ISO-8601). */
  ts: string
  /** Operation kind — property-graph op (LogOpKind) or metagraph atom op. */
  op: LogOpKind | string
  payload: Record<string, unknown>
}

// ─── Query results ──────────────────────────────────────────────────────────────

/** A SPARQL solution: variable name → bound value. */
export type Binding = Record<string, PropertyValue>

export interface SparqlResult {
  /** Projected variable names, in SELECT order. */
  variables: string[]
  bindings: Binding[]
  /** Logical clock at evaluation time. */
  evaluatedAtSeq: number
}

export interface GremlinResult {
  values: PropertyValue[] | GraphNode[] | GraphEdge[] | Record<string, PropertyValue>[]
  count: number
}

export type QueryLanguage = 'sparql' | 'gremlin'

// ─── Regis-aligned node kinds ─────────────────────────────────────────────────
// Aligned to the Regis Entity Graph canonical ontology (socioprophet.org/schemas/regis).
// FEATURE_ATOM is the primary type for extracted concepts from conversation content.

export type RegisNodeKind =
  | 'FEATURE_ATOM'       // extracted concept/entity from conversation text
  | 'PERSON'             // detected person name
  | 'RECORD'             // document, file, code artifact, URL
  | 'EVENT'              // event or action described
  | 'ROLE'               // role or title mentioned
  | 'ORG'                // organization, company, project
  | 'DEVICE'             // device or system
  | 'SESSION'            // conversation session (already used)
  | 'PROOF_ARTIFACT'     // evidence artifact
  | 'POLICY_WITNESS'     // policy decision record

// Prime topics — authorized identity contexts (from Identity Is Prime reference)
export type PrimeTopic =
  | 'CITIZEN'
  | 'ENGINEER'
  | 'RESEARCHER'
  | 'SECURITY_RESEARCHER'
  | 'OPERATOR'
  | 'HEALTH'
  | 'CIVIC'

export type PrimeScope =
  | 'CITIZEN_FOG'   // local-first, sovereign device — broadest authorization
  | 'CITIZEN_CLOUD' // cloud-hosted, reduced authorization
  | 'INSTITUTION'   // enterprise/institutional context
  | 'ADTECH'        // advertising/marketing — most restricted

// ─── Epistemic edge record ────────────────────────────────────────────────────
// Aligned to regis/epistemic-edge-record.schema.json
// Used for entity linking across sessions with uncertainty quantification.

export type EpistemicClass =
  | 'extracted_relation'   // extracted from text by heuristic/model
  | 'inferred_relation'    // inferred by graph traversal
  | 'confirmed_relation'   // confirmed by user or high-confidence match
  | 'graph_extraction'     // produced by the entity extraction pipeline
  | 'semantic'             // semantic similarity match

export type PromotionState =
  | 'candidate'    // proposed, awaiting confirmation
  | 'confirmed'    // accepted
  | 'contested'    // under review
  | 'superseded'   // replaced by a better match
  | 'vetoed'       // blocked by policy

export interface EpistemicEdgeRecord {
  recordId: string
  edgeKind: string
  epistemicClass: EpistemicClass
  confidence: { confidenceType: EpistemicClass; level: number }
  promotionState: PromotionState
  evidenceRefs: string[]
  policyDecisionRefs: string[]
  createdAt: string
  nonClaims?: string[]  // things this record explicitly does NOT claim
}
