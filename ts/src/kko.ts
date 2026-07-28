/**
 * KKO — the KBpedia Knowledge Ontology, wired into the AtomSpace.
 *
 * Loads the KKO upper ontology (Peircean-grounded typology TBox — 168 classes / 167
 * rdfs:subClassOf axioms; see `ontology/kko/PROVENANCE.md`) into a HellGraph AtomSpace in TWO
 * complementary ways, so KKO is both a *classification substrate* and *queryable graph data*:
 *
 *   1. The **type-inheritance lattice** (`AtomSpace.types`): every KKO class is `declare()`d under
 *      its superclass(es), so `as.types.isA(child, parent)` / `ancestors(child)` answer KKO
 *      subsumption in O(depth). This is the substrate the enrichment / mapping stages type against
 *      ("is this attribute's class ⊑ kko:Predications?").
 *   2. The **property-graph ABox**: every KKO class becomes a `KkoClass`-labelled node and every
 *      subClassOf an `rdfs:subClassOf` edge (the same EvaluationLink shape the façade projects), so
 *      the hierarchy is directly queryable by SPARQL / Cypher and analyzable by the graph kernels
 *      (PageRank, link-prediction) — on the same substrate as the rest of the graph.
 *
 * The ontology ships **embedded** (`kko-data.ts`, generated from the vendored `.n3` by
 * `scripts/gen-kko.mjs`), so `loadKkoIntoAtomSpace(as)` needs zero file I/O at runtime.
 * `parseKko(text)` remains available to ingest a newer or custom KKO / RDFS class TBox.
 */
import { parseTurtle } from './turtle'
import type { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { KKO_CLASSES, KKO_VERSION } from './kko-data'

export const KKO_NS = 'http://kbpedia.org/ontologies/kko#'
const OWL = 'http://www.w3.org/2002/07/owl#'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const SKOS = 'http://www.w3.org/2004/02/skos/core#'
const RDF_TYPE = RDF + 'type'
const OWL_CLASS = OWL + 'Class'
const OWL_THING = OWL + 'Thing'
const OWL_VERSION_IRI = OWL + 'versionIRI'
const SUBCLASS_OF = RDFS + 'subClassOf'
const RDFS_LABEL = RDFS + 'label'
const SKOS_PREF = SKOS + 'prefLabel'

export interface KkoClass {
  /** Full class IRI, e.g. `http://kbpedia.org/ontologies/kko#Monads`. */
  iri: string
  /** Human label (rdfs:label ∨ skos:prefLabel), if declared. */
  label?: string
  /** Direct superclass IRIs (rdfs:subClassOf). */
  subClassOf: string[]
}

export interface KkoOntology {
  version: string
  classes: KkoClass[]
  byIri: Map<string, KkoClass>
}

export interface KkoLoadStats {
  classes: number
  subClassOfEdges: number
  version: string
}

/** Short display form: `…/kko#Monads` → `kko:Monads`; non-KKO IRIs are returned unchanged. */
export function kkoShort(iri: string): string {
  return iri.startsWith(KKO_NS) ? 'kko:' + iri.slice(KKO_NS.length) : iri
}

/**
 * Parse a KKO / RDFS class TBox from Turtle/N3 text. Extracts `owl:Class` subjects in the `kko:`
 * namespace, their `rdfs:subClassOf` superclasses, and a label (`rdfs:label` ∨ `skos:prefLabel`).
 * Reuses the engine's own `parseTurtle` (handles @prefix, predicate/object lists, `"""` strings).
 */
export function parseKko(text: string): KkoOntology {
  const triples = parseTurtle(text)
  const byIri = new Map<string, KkoClass>()
  let version = ''

  // Pass 1: identify KKO classes + the ontology version.
  for (const t of triples) {
    if (t.p.value === OWL_VERSION_IRI && t.o.kind === 'iri') version = t.o.value
    if (
      t.p.value === RDF_TYPE && t.o.kind === 'iri' && t.o.value === OWL_CLASS &&
      t.s.kind === 'iri' && t.s.value.startsWith(KKO_NS) && !byIri.has(t.s.value)
    ) {
      byIri.set(t.s.value, { iri: t.s.value, subClassOf: [] })
    }
  }
  // Pass 2: attach subClassOf edges + labels to known KKO classes. rdfs:label is authoritative;
  // skos:prefLabel is only a fallback (so a class's short label wins over a prefLabel that some
  // KKO entries overload with a long definition).
  for (const t of triples) {
    if (t.s.kind !== 'iri') continue
    const c = byIri.get(t.s.value)
    if (!c) continue
    if (t.p.value === SUBCLASS_OF && t.o.kind === 'iri') {
      if (!c.subClassOf.includes(t.o.value)) c.subClassOf.push(t.o.value)
    } else if (t.p.value === RDFS_LABEL && t.o.kind === 'literal') {
      c.label = t.o.value
    } else if (t.p.value === SKOS_PREF && t.o.kind === 'literal' && c.label === undefined) {
      c.label = t.o.value
    }
  }
  return { version, classes: [...byIri.values()], byIri }
}

/** The embedded KKO ontology (generated from the vendored `.n3`). */
export function kkoOntology(): KkoOntology {
  const byIri = new Map<string, KkoClass>()
  for (const c of KKO_CLASSES) byIri.set(c.iri, c)
  return { version: KKO_VERSION, classes: KKO_CLASSES, byIri }
}

/**
 * Load KKO into an AtomSpace. For each class: (1) `declare` it in the type-inheritance lattice under
 * its superclass(es) (root classes anchored under `owl:Thing`); (2) intern it as a `ConceptNode`
 * with an `InheritanceLink` per real superclass, and keep its label + short form as Values.
 * Idempotent — atoms are content-addressed, so re-loading is a no-op. Returns load stats.
 */
export function loadKkoIntoAtomSpace(as: AtomSpace, onto: KkoOntology = kkoOntology()): KkoLoadStats {
  const store = new HellGraphStore(as)
  let subClassOfEdges = 0
  for (const c of onto.classes) {
    // (1) type-inheritance lattice — fast KKO subsumption via as.types.isA / ancestors.
    as.types.declare(c.iri, c.subClassOf.length ? c.subClassOf : [OWL_THING])
    // (2) property-graph ABox — a `KkoClass`-labelled node per class + an `rdfs:subClassOf` edge per
    //     superclass, in the same EvaluationLink shape the façade projects, so the hierarchy is
    //     queryable by SPARQL/Cypher and analyzable by PageRank / link-prediction.
    store.addNode(c.iri, ['KkoClass'], c.label !== undefined ? { short: kkoShort(c.iri), label: c.label } : { short: kkoShort(c.iri) })
    for (const parentIri of c.subClassOf) {
      store.addEdge('rdfs:subClassOf', c.iri, parentIri)
      subClassOfEdges++
    }
  }
  return { classes: onto.classes.length, subClassOfEdges, version: onto.version }
}

/** Convenience: parse `text` and load it into `as` in one call. */
export function loadKko(as: AtomSpace, text: string): KkoLoadStats {
  return loadKkoIntoAtomSpace(as, parseKko(text))
}
