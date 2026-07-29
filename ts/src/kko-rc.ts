/**
 * KBpedia Reference Concepts — the ~55k-concept ABox beneath the KKO upper ontology.
 *
 * Where `kko.ts` wires the 168-class KKO *upper* TBox (the Peircean typology skeleton), this loads the
 * full reference-concept layer: ~55,128 `owl:Class` concepts in the `http://kbpedia.org/kko/rc/`
 * namespace, each `rdfs:subClassOf` another RC or a KKO upper class, with `skos:prefLabel`/`altLabel`.
 * Together they give the graph a real, deep type vocabulary — `rc:Cow's-MilkCheese ⊑ rc:Cheese ⊑ … ⊑
 * kko:Foods` — that estate entities can be typed against (the enrichment "Semantic Mapping" stage) and
 * that the coherence ranker reasons over.
 *
 * The RC artifact (37.6 MB N3) is NOT embedded or bundled — it is far too large. It lives in the
 * sovereign fork (`SocioProphet/kbpedia`, `versions/2.10/kbpedia_reference_concepts.zip`) and is
 * ingested into the persistent graph by a data-load step that hands the text to `loadReferenceConcepts`.
 * The engine ships only the loader; `parseReferenceConcepts` reuses the engine's own `parseTurtle`.
 */
import { parseTurtle } from './turtle'
import type { HellGraphStore } from './store'
import { HnswIndex } from './ann'
import type { EmbedFn } from './semantic'
import { KKO_NS } from './kko'

export const RC_NS = 'http://kbpedia.org/kko/rc/'
const OWL = 'http://www.w3.org/2002/07/owl#'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const SKOS = 'http://www.w3.org/2004/02/skos/core#'
const RDF_TYPE = RDF + 'type'
const OWL_CLASS = OWL + 'Class'
const SUBCLASS_OF = RDFS + 'subClassOf'
const SKOS_PREF = SKOS + 'prefLabel'
const SKOS_ALT = SKOS + 'altLabel'

/** The label carried by every reference-concept node in the property graph. */
export const RC_LABEL = 'KkoReferenceConcept'

export interface ReferenceConcept {
  iri: string
  prefLabel?: string
  altLabels: string[]
  /** Superclass IRIs — other RCs (`rc:`) and/or KKO upper classes (`kko:`). */
  subClassOf: string[]
}

export interface RcLoadStats {
  concepts: number
  subClassOfEdges: number
}

/** Parse the reference-concept classes from KBpedia RC Turtle/N3 text. */
export function parseReferenceConcepts(text: string): ReferenceConcept[] {
  const triples = parseTurtle(text)
  const byIri = new Map<string, ReferenceConcept>()

  for (const t of triples) {
    if (
      t.p.value === RDF_TYPE && t.o.kind === 'iri' && t.o.value === OWL_CLASS &&
      t.s.kind === 'iri' && t.s.value.startsWith(RC_NS) && !byIri.has(t.s.value)
    ) {
      byIri.set(t.s.value, { iri: t.s.value, altLabels: [], subClassOf: [] })
    }
  }
  for (const t of triples) {
    if (t.s.kind !== 'iri') continue
    const c = byIri.get(t.s.value)
    if (!c) continue
    if (t.p.value === SUBCLASS_OF && t.o.kind === 'iri') {
      if (!c.subClassOf.includes(t.o.value)) c.subClassOf.push(t.o.value)
    } else if (t.p.value === SKOS_PREF && t.o.kind === 'literal') {
      c.prefLabel = t.o.value
    } else if (t.p.value === SKOS_ALT && t.o.kind === 'literal' && !c.altLabels.includes(t.o.value)) {
      c.altLabels.push(t.o.value)
    }
  }
  return [...byIri.values()]
}

/**
 * Ingest the reference-concept ABox into a store: each RC becomes a `KkoReferenceConcept` node
 * (carrying its prefLabel) with an `rdfs:subClassOf` edge to each superclass (RC or KKO). Idempotent.
 */
export function loadReferenceConcepts(store: HellGraphStore, text: string): RcLoadStats {
  const concepts = parseReferenceConcepts(text)
  let subClassOfEdges = 0
  for (const rc of concepts) {
    const props: Record<string, string> = {}
    if (rc.prefLabel !== undefined) props['prefLabel'] = rc.prefLabel
    if (rc.altLabels.length) props['altLabels'] = rc.altLabels.join('\n') // newline-joined; split on read
    store.addNode(rc.iri, [RC_LABEL], props)
    for (const parentIri of rc.subClassOf) {
      store.addEdge('rdfs:subClassOf', rc.iri, parentIri)
      subClassOfEdges++
    }
  }
  return { concepts: concepts.length, subClassOfEdges }
}

/**
 * The KKO upper classes a concept rolls up to — walk `rdfs:subClassOf` from `iri` (through
 * intermediate RCs) and collect every KKO-namespace class reached. This is how a deep RC type
 * (`rc:Cow's-MilkCheese`) resolves to its KKO upper type(s) for coherence/subsumption reasoning.
 */
export function kkoTypesOf(store: HellGraphStore, iri: string): string[] {
  const kko = new Set<string>()
  const seen = new Set<string>()
  const stack = [iri]
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const parent of store.out(cur, 'rdfs:subClassOf')) {
      if (parent.id.startsWith(KKO_NS)) kko.add(parent.id)
      else stack.push(parent.id) // another RC — keep climbing toward the upper ontology
    }
  }
  return [...kko].sort()
}

// ─── Entity → KKO typing (the "Semantic Mapping" stage) ─────────────────────────────────────────

/** Normalize a label for matching: case-fold, strip accents/punctuation, collapse whitespace. */
function normalizeLabel(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** A normalized label → reference-concept IRIs index, over both `prefLabel` and `altLabel`s. Build once,
 *  reuse across many mappings. Indexing altLabels raises recall (e.g. "physician" → the RC whose
 *  prefLabel is "doctor" but which lists "physician" as an alt). */
export function buildRcLabelIndex(store: HellGraphStore): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const add = (label: string, id: string): void => {
    const norm = normalizeLabel(label)
    if (!norm) return
    const arr = index.get(norm)
    if (arr) { if (!arr.includes(id)) arr.push(id) }
    else index.set(norm, [id])
  }
  for (const node of store.nodesByLabel(RC_LABEL)) {
    const pref = node.properties['prefLabel']
    if (typeof pref === 'string') add(pref, node.id)
    const alt = node.properties['altLabels']
    if (typeof alt === 'string') for (const a of alt.split('\n')) add(a, node.id)
  }
  return index
}

export interface KkoMapping {
  entity: string
  /** Matched reference-concept IRI, or null if no RC label matched. */
  matched: string | null
  prefLabel: string | null
  /** KKO upper class(es) the matched RC rolls up to (via `kkoTypesOf`). */
  kkoTypes: string[]
  /** How many RCs matched the normalized label (>1 ⇒ ambiguous, first is returned). */
  candidates: number
}

/**
 * Map an estate entity's label to its KKO type by matching a reference concept, then rolling that RC up
 * to its KKO upper class(es). Exact normalized pref/altLabel match; for semantic (synonym/embedding)
 * matching of misses, see `buildRcEmbeddingIndex` + `mapEntityToKkoSemantic`. Pass a prebuilt `index`
 * (from `buildRcLabelIndex`) when mapping many entities.
 */
export function mapEntityToKko(store: HellGraphStore, entity: string, index?: Map<string, string[]>): KkoMapping {
  const idx = index ?? buildRcLabelIndex(store)
  const matches = idx.get(normalizeLabel(entity)) ?? []
  if (matches.length === 0) return { entity, matched: null, prefLabel: null, kkoTypes: [], candidates: 0 }
  const rc = matches[0]
  const node = store.getNode(rc)
  const prefLabel = node && typeof node.properties['prefLabel'] === 'string' ? (node.properties['prefLabel'] as string) : null
  return { entity, matched: rc, prefLabel, kkoTypes: kkoTypesOf(store, rc), candidates: matches.length }
}

// ─── Materialized typing: entity→RC as graph fact, not per-call string matching ─────────────────

/** Edge label binding an entity node to its reference concept: entity --kko:typedAs--> rc. */
export const TYPED_AS = 'kko:typedAs'

export interface MaterializeStats { scanned: number; typed: number; edges: number }

/**
 * Write entity→RC typing INTO the graph: for every node carrying `label`, resolve its `name` property
 * (else id) against the RC label index and add a `kko:typedAs` edge to the matched reference concept.
 * Idempotent (content-addressed edges). Typing becomes queryable/auditable graph fact — coherence and
 * downstream reasoning read edges instead of re-matching strings on every call.
 */
export function materializeKkoTypes(store: HellGraphStore, label: string, index?: Map<string, string[]>): MaterializeStats {
  const idx = index ?? buildRcLabelIndex(store)
  let scanned = 0, typed = 0, edges = 0
  for (const node of store.nodesByLabel(label)) {
    scanned++
    const key = typeof node.properties['name'] === 'string' ? (node.properties['name'] as string) : node.id
    const m = mapEntityToKko(store, key, idx)
    if (!m.matched) continue
    typed++
    store.addEdge(TYPED_AS, node.id, m.matched)
    edges++
  }
  return { scanned, typed, edges }
}

/** An entity's KKO upper types via its materialized `kko:typedAs` edge(s) — [] when untyped. */
export function entityKkoTypes(store: HellGraphStore, id: string): string[] {
  const out = new Set<string>()
  for (const rc of store.out(id, TYPED_AS)) for (const t of kkoTypesOf(store, rc.id)) out.add(t)
  return [...out].sort()
}

// ─── Semantic (embedding) mapping — recall beyond exact labels ──────────────────────────────────
// Uses the engine's standard embedding contract (semantic.ts EmbedFn: EMBEDDINGS_URL / Ollama).

export interface RcEmbeddingIndex {
  hnsw: HnswIndex
  /** RC IRIs actually embedded (labels with non-empty vectors). */
  embedded: number
}

export interface SemanticKkoMapping extends KkoMapping {
  /** 'exact' when the label index hit; 'semantic' when the embedding index resolved it; 'none' otherwise. */
  via: 'exact' | 'semantic' | 'none'
  /** Cosine similarity of the semantic match (present when via='semantic'). */
  similarity?: number
}

/**
 * Embed every reference concept's `prefLabel` into an HNSW index (id = RC IRI). This is the one-time
 * data-prep step for semantic mapping — O(#RCs) embed calls, so batch/cache upstream as needed. Labels
 * whose embedding fails (empty vector) are skipped, never faked.
 */
export async function buildRcEmbeddingIndex(store: HellGraphStore, embed: EmbedFn): Promise<RcEmbeddingIndex> {
  const hnsw = new HnswIndex()
  let embedded = 0
  for (const node of store.nodesByLabel(RC_LABEL)) {
    const pref = node.properties['prefLabel']
    if (typeof pref !== 'string' || !pref) continue
    const v = await embed(pref)
    if (v.length === 0) continue
    hnsw.add(node.id, v)
    embedded++
  }
  return { hnsw, embedded }
}

/**
 * Semantic entity→KKO mapping: exact label match first (free, precise); on a miss, embed the entity and
 * take the nearest RC prefLabel above `minSimilarity` from the prebuilt embedding index. Falls back to a
 * clean 'none' mapping — never a fabricated match.
 */
export async function mapEntityToKkoSemantic(
  store: HellGraphStore,
  entity: string,
  embedIndex: RcEmbeddingIndex,
  embed: EmbedFn,
  opts: { minSimilarity?: number; labelIndex?: Map<string, string[]> } = {},
): Promise<SemanticKkoMapping> {
  const exact = mapEntityToKko(store, entity, opts.labelIndex)
  if (exact.matched) return { ...exact, via: 'exact' }
  const minSimilarity = opts.minSimilarity ?? 0.6
  const qv = await embed(entity)
  if (qv.length > 0 && embedIndex.embedded > 0) {
    const [best] = embedIndex.hnsw.search(qv, 1)
    if (best && best.score >= minSimilarity) {
      const node = store.getNode(best.id)
      const prefLabel = node && typeof node.properties['prefLabel'] === 'string' ? (node.properties['prefLabel'] as string) : null
      return {
        entity, matched: best.id, prefLabel, kkoTypes: kkoTypesOf(store, best.id),
        candidates: 1, via: 'semantic', similarity: best.score,
      }
    }
  }
  return { ...exact, via: 'none' }
}
