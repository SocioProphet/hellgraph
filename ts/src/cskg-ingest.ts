import { AtomSpace, type TruthValue } from './atomspace'

/**
 * CSKG ingest — load ConceptNet + ATOMIC commonsense into the AtomSpace.
 *
 * Open_Agent_Archetype_Synthesis §3.4: commonsense sources are ingested into the
 * canonical store (AtomSpace), not only a property graph. Each triple becomes
 *   EvaluationLink (PredicateNode <rel>) (ListLink (ConceptNode h) (ConceptNode t))
 * with a TruthValue derived from the source edge weight — so PLN reasoning and
 * the Cypher facade (`MATCH (h)-[:IsA*1..2]->(t)`) operate over real commonsense.
 *
 * The relation vocabulary is normalized through a VERSIONED map (the Archetype
 * calls an un-versioned normalization map "a silent footgun") so queries stay
 * stable even as upstream ConceptNet/ATOMIC formats drift.
 *
 * Ingest is idempotent: atoms are content-addressed (structural hash), so
 * re-ingesting the same edge collapses to the same atoms. (Bayesian TruthValue
 * accumulation across federated writers happens via AtomSpace.importEntry / PLN
 * revision; direct re-ingest is last-write on the tv.)
 */

// ─── Versioned relation-normalization map ───────────────────────────────────────

export const CSKG_RELATION_MAP_VERSION = 'cskg-relnorm/v1'

/** raw relation token (ConceptNet /r/Foo or ATOMIC xIntent) → canonical predicate. */
export const CSKG_RELATION_MAP: Record<string, string> = {
  // ConceptNet (strip /r/, canonicalize casing)
  '/r/IsA': 'IsA', '/r/RelatedTo': 'RelatedTo', '/r/PartOf': 'PartOf', '/r/HasA': 'HasA',
  '/r/UsedFor': 'UsedFor', '/r/CapableOf': 'CapableOf', '/r/AtLocation': 'AtLocation',
  '/r/Causes': 'Causes', '/r/HasProperty': 'HasProperty', '/r/MotivatedByGoal': 'MotivatedByGoal',
  '/r/Desires': 'Desires', '/r/CreatedBy': 'CreatedBy', '/r/Synonym': 'Synonym',
  '/r/Antonym': 'Antonym', '/r/DerivedFrom': 'DerivedFrom', '/r/HasContext': 'HasContext',
  '/r/FormOf': 'FormOf', '/r/HasSubevent': 'HasSubevent', '/r/HasPrerequisite': 'HasPrerequisite',
  '/r/MannerOf': 'MannerOf', '/r/SimilarTo': 'SimilarTo', '/r/DistinctFrom': 'DistinctFrom',
  // ATOMIC (already canonical; mapped for completeness)
  'xIntent': 'xIntent', 'xNeed': 'xNeed', 'xAttr': 'xAttr', 'xEffect': 'xEffect',
  'xWant': 'xWant', 'xReact': 'xReact', 'oEffect': 'oEffect', 'oWant': 'oWant', 'oReact': 'oReact',
}

export function normalizeRelation(raw: string): string {
  const hit = CSKG_RELATION_MAP[raw]
  if (hit) return hit
  // Unknown ConceptNet relation → strip the /r/ prefix; ATOMIC-style → as-is.
  return raw.startsWith('/r/') ? raw.slice(3) : raw
}

/** ConceptNet term `/c/en/wake_up/v` → `wake_up`. Non-CN terms pass through. */
export function cleanConceptNetTerm(term: string): string {
  if (!term.startsWith('/c/')) return term.trim()
  const parts = term.split('/').filter(Boolean)   // ['c','en','wake_up','v']
  return (parts[2] ?? term).trim()
}

/** Edge weight → TruthValue. Assertions are present (strength 1); weight raises confidence. */
export function weightToTruthValue(weight: number): TruthValue {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  return { strength: 1, confidence: Math.max(0, Math.min(1, w / (w + 1))) }
}

// ─── Ingest ─────────────────────────────────────────────────────────────────────

export interface CskgEdge { rel: string; start: string; end: string; weight?: number }

export interface IngestReport {
  concepts: number
  edges: number
  relations: Set<string>
  byRelation: Record<string, number>
  relationMapVersion: string
}

function emptyReport(): IngestReport {
  return { concepts: 0, edges: 0, relations: new Set(), byRelation: {}, relationMapVersion: CSKG_RELATION_MAP_VERSION }
}

/** Ingest one already-parsed edge. Idempotent via structural hashing. */
export function ingestEdge(as: AtomSpace, e: CskgEdge, report: IngestReport): void {
  const rel = normalizeRelation(e.rel)
  const h = cleanConceptNetTerm(e.start)
  const t = cleanConceptNetTerm(e.end)
  if (!rel || !h || !t) return
  const before = as.count()
  const hn = as.addNode('ConceptNode', h).handle
  const tn = as.addNode('ConceptNode', t).handle
  const pred = as.addNode('PredicateNode', rel).handle
  const list = as.addLink('ListLink', [hn, tn]).handle
  as.addLink('EvaluationLink', [pred, list], { tv: weightToTruthValue(e.weight ?? 1) })
  report.concepts += Math.max(0, as.count() - before)   // net-new atoms (approx concepts+links)
  report.edges += 1
  report.relations.add(rel)
  report.byRelation[rel] = (report.byRelation[rel] ?? 0) + 1
}

export function ingestCskg(as: AtomSpace, edges: Iterable<CskgEdge>): IngestReport {
  const report = emptyReport()
  for (const e of edges) ingestEdge(as, e, report)
  return report
}

// ─── ConceptNet TSV parser ──────────────────────────────────────────────────────
// Line format (CN5 assertions dump), tab-separated:
//   <uri> \t <rel> \t <start> \t <end> \t <json-metadata-with-weight>

export function parseConceptNetLine(line: string): CskgEdge | null {
  const cols = line.split('\t')
  if (cols.length < 4) return null
  const [, rel, start, end, meta] = cols
  let weight = 1
  if (meta) {
    try { const w = (JSON.parse(meta) as { weight?: number }).weight; if (typeof w === 'number') weight = w } catch { /* keep default */ }
  }
  return { rel, start, end, weight }
}

export function ingestConceptNetTsv(as: AtomSpace, text: string): IngestReport {
  const report = emptyReport()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const e = parseConceptNetLine(t)
    if (e) ingestEdge(as, e, report)
  }
  return report
}

// ─── ATOMIC rows ─────────────────────────────────────────────────────────────────
// ATOMIC / ATOMIC-2020: { head, relation, tail, weight? } (already-normalized text).

export interface AtomicRow { head: string; relation: string; tail: string; weight?: number }

export function ingestAtomic(as: AtomSpace, rows: Iterable<AtomicRow>): IngestReport {
  const report = emptyReport()
  for (const r of rows) {
    if (!r.tail || r.tail.toLowerCase() === 'none') continue     // ATOMIC uses "none" for no-op tails
    ingestEdge(as, { rel: r.relation, start: r.head, end: r.tail, weight: r.weight }, report)
  }
  return report
}
