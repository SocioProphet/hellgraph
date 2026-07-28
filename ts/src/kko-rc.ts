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
    store.addNode(rc.iri, [RC_LABEL], rc.prefLabel !== undefined ? { prefLabel: rc.prefLabel } : {})
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
