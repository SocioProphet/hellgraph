import { AtomSpace, nodeHandle, linkHandle, type Handle, type TruthValue, type Value } from './atomspace'

/**
 * CSKG ingest — load ConceptNet + ATOMIC + canonical CSKG/KGTK edges into the
 * AtomSpace, conforming to the `cskg.vnext` profile (Atlas-aligned).
 *
 * CSKG remains the canonical graph truth. The profile's public-source baseline
 * is the KGTK edge schema:
 *   primary:   id, node1, relation, node2
 *   lifted:    node1;label, node2;label, relation;label, relation;dimension
 *   qualifier: source, sentence
 *
 * Representation (Atomese standard):
 *   EvaluationLink (PredicateNode <relation>) (ListLink (ConceptNode node1) (ConceptNode node2))
 * where the ConceptNode NAME is the CSKG node id (e.g. `/c/en/rain`, `wn:dog.n.01`,
 * `Q7302867`) — identity is the id, not the surface lemma — so `ResolveSameAs`
 * (mw:SameAs consolidation) has real ids to resolve. The human label, the edge
 * id, dimension, source and sentence are carried as atom Values, making each
 * edge addressable by CSKG `id` for `GetEdge`/`DeleteEdge`.
 *
 * Relations pass through a VERSIONED normalization map so queries stay stable as
 * upstream formats drift. Ingest is idempotent (content-addressed atoms).
 */

// ─── Versioned relation-normalization map ───────────────────────────────────────

export const CSKG_RELATION_MAP_VERSION = 'cskg-relnorm/v1'

export const CSKG_RELATION_MAP: Record<string, string> = {
  '/r/IsA': 'IsA', '/r/RelatedTo': 'RelatedTo', '/r/PartOf': 'PartOf', '/r/HasA': 'HasA',
  '/r/UsedFor': 'UsedFor', '/r/CapableOf': 'CapableOf', '/r/AtLocation': 'AtLocation',
  '/r/Causes': 'Causes', '/r/HasProperty': 'HasProperty', '/r/MotivatedByGoal': 'MotivatedByGoal',
  '/r/Desires': 'Desires', '/r/CreatedBy': 'CreatedBy', '/r/Synonym': 'Synonym',
  '/r/Antonym': 'Antonym', '/r/DerivedFrom': 'DerivedFrom', '/r/HasContext': 'HasContext',
  '/r/FormOf': 'FormOf', '/r/HasSubevent': 'HasSubevent', '/r/HasPrerequisite': 'HasPrerequisite',
  '/r/MannerOf': 'MannerOf', '/r/SimilarTo': 'SimilarTo', '/r/DistinctFrom': 'DistinctFrom',
  'mw:SameAs': 'SameAs', '/r/SameAs': 'SameAs',
  'xIntent': 'xIntent', 'xNeed': 'xNeed', 'xAttr': 'xAttr', 'xEffect': 'xEffect',
  'xWant': 'xWant', 'xReact': 'xReact', 'oEffect': 'oEffect', 'oWant': 'oWant', 'oReact': 'oReact',
}

export function normalizeRelation(raw: string): string {
  const hit = CSKG_RELATION_MAP[raw]
  if (hit) return hit
  return raw.startsWith('/r/') ? raw.slice(3) : raw
}

/** Derive a human label from a CSKG node id: `/c/en/wake_up/v` → `wake_up`. */
export function labelFromNodeId(id: string): string {
  if (!id.startsWith('/c/')) return id.replace(/^[a-z]+:/, '').trim()  // strip wn:/at:/fn: prefixes
  const parts = id.split('/').filter(Boolean)                          // ['c','en','wake_up','v']
  return (parts[2] ?? id).trim()
}

/** Back-compat alias (older callers used this name). */
export const cleanConceptNetTerm = labelFromNodeId

export function weightToTruthValue(weight: number): TruthValue {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  return { strength: 1, confidence: Math.max(0, Math.min(1, w / (w + 1))) }
}

// ─── Canonical CSKG edge record (KGTK schema) ───────────────────────────────────

export interface CSKGEdgeRecord {
  id: string                    // KGTK `id` — the addressable edge identity
  node1: string                 // node id (identity)
  relation: string              // raw or canonical; normalized on ingest
  node2: string
  node1Label?: string           // node1;label
  node2Label?: string           // node2;label
  relationLabel?: string        // relation;label
  relationDimension?: string    // relation;dimension
  source?: string               // CN | AT | WN | WD | RG | VG | FN …
  sentence?: string
  weight?: number
}

// Atom Value keys carrying CSKG edge/node metadata.
const V = {
  id: 'cskg:id', dim: 'cskg:relation_dimension', src: 'cskg:source', sent: 'cskg:sentence',
  relLabel: 'cskg:relation_label', label: 'cskg:label',
} as const
const strVal = (s: string): Value => ({ kind: 'string', value: [s] })
const readStr = (as: AtomSpace, h: Handle, key: string): string | undefined => {
  const v = as.getAtom(h)?.values[key]
  return v && v.kind === 'string' ? v.value[0] : undefined
}

const REL_LINK = 'EvaluationLink', REL_PRED = 'PredicateNode', REL_LIST = 'ListLink', NODE = 'ConceptNode'

/** Content-addressed EvaluationLink handle for an edge (for GetEdge-by-triple). */
export function computeEdgeHandle(node1: string, relation: string, node2: string): Handle {
  const list = linkHandle(REL_LIST, [nodeHandle(NODE, node1), nodeHandle(NODE, node2)])
  return linkHandle(REL_LINK, [nodeHandle(REL_PRED, normalizeRelation(relation)), list])
}

/** Deterministic KGTK-style edge id when the source doesn't provide one. */
function synthEdgeId(node1: string, relation: string, node2: string): string {
  return `${node1}-${relation}-${node2}-0000`
}

// ─── Ingest ─────────────────────────────────────────────────────────────────────

export interface IngestReport {
  concepts: number
  edges: number
  relations: Set<string>
  byRelation: Record<string, number>
  bySource: Record<string, number>
  relationMapVersion: string
}
function emptyReport(): IngestReport {
  return { concepts: 0, edges: 0, relations: new Set(), byRelation: {}, bySource: {}, relationMapVersion: CSKG_RELATION_MAP_VERSION }
}

/** Ingest one canonical CSKG edge record. Idempotent; returns the edge handle. */
export function ingestEdgeRecord(as: AtomSpace, rec: CSKGEdgeRecord, report?: IngestReport): Handle {
  const relation = normalizeRelation(rec.relation)
  if (!relation || !rec.node1 || !rec.node2) return ''
  const before = as.count()
  const n1 = as.addNode(NODE, rec.node1).handle
  const n2 = as.addNode(NODE, rec.node2).handle
  as.setValue(n1, V.label, strVal(rec.node1Label ?? labelFromNodeId(rec.node1)))
  as.setValue(n2, V.label, strVal(rec.node2Label ?? labelFromNodeId(rec.node2)))
  const pred = as.addNode(REL_PRED, relation).handle
  if (rec.relationLabel) as.setValue(pred, V.relLabel, strVal(rec.relationLabel))
  const list = as.addLink(REL_LIST, [n1, n2]).handle
  const edge = as.addLink(REL_LINK, [pred, list], { tv: weightToTruthValue(rec.weight ?? 1) }).handle

  as.setValue(edge, V.id, strVal(rec.id || synthEdgeId(rec.node1, relation, rec.node2)))
  if (rec.relationDimension) as.setValue(edge, V.dim, strVal(rec.relationDimension))
  if (rec.source) as.setValue(edge, V.src, strVal(rec.source))
  if (rec.sentence) as.setValue(edge, V.sent, strVal(rec.sentence))

  if (report) {
    report.concepts += Math.max(0, as.count() - before)
    report.edges += 1
    report.relations.add(relation)
    report.byRelation[relation] = (report.byRelation[relation] ?? 0) + 1
    if (rec.source) report.bySource[rec.source] = (report.bySource[rec.source] ?? 0) + 1
  }
  return edge
}

export function ingestEdgeRecords(as: AtomSpace, recs: Iterable<CSKGEdgeRecord>): IngestReport {
  const report = emptyReport()
  for (const r of recs) ingestEdgeRecord(as, r, report)
  return report
}

// ─── GetEdge support: reconstruct a record / look up by id ──────────────────────

/** Reconstruct a CSKGEdgeRecord from an EvaluationLink atom (for GetEdge). */
export function edgeRecordFromAtom(as: AtomSpace, edge: Handle): CSKGEdgeRecord | null {
  const link = as.getAtom(edge)
  if (!link?.outgoing || link.type !== REL_LINK) return null
  const [predH, listH] = link.outgoing
  const list = as.getAtom(listH)
  if (!list?.outgoing) return null
  const [n1, n2] = list.outgoing
  const node1 = as.getAtom(n1)?.name ?? '', node2 = as.getAtom(n2)?.name ?? ''
  return {
    id: readStr(as, edge, V.id) ?? '',
    node1, relation: as.getAtom(predH)?.name ?? '', node2,
    node1Label: readStr(as, n1, V.label),
    node2Label: readStr(as, n2, V.label),
    relationLabel: readStr(as, predH, V.relLabel),
    relationDimension: readStr(as, edge, V.dim),
    source: readStr(as, edge, V.src),
    sentence: readStr(as, edge, V.sent),
    weight: link.tv?.confidence,
  }
}

/** Look up an edge by its exact CSKG `id` (durable value scan). */
export function findEdgeById(as: AtomSpace, id: string): Handle | undefined {
  for (const e of as.getByType(REL_LINK)) if (readStr(as, e.handle, V.id) === id) return e.handle
  return undefined
}

// ─── KGTK TSV parser (header-driven, the real CSKG dump format) ─────────────────

const KGTK_COLS = ['id', 'node1', 'relation', 'node2', 'node1;label', 'node2;label', 'relation;label', 'relation;dimension', 'source', 'sentence'] as const

export function parseKgtkEdges(text: string): CSKGEdgeRecord[] {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return []
  const header = lines[0].split('\t').map((h) => h.trim())
  const idx = (col: string) => header.indexOf(col)
  const recs: CSKGEdgeRecord[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t')
    const get = (col: string) => { const j = idx(col); return j >= 0 ? c[j]?.trim() : undefined }
    const node1 = get('node1'), relation = get('relation'), node2 = get('node2')
    if (!node1 || !relation || !node2) continue
    recs.push({
      id: get('id') || '', node1, relation, node2,
      node1Label: get('node1;label'), node2Label: get('node2;label'),
      relationLabel: get('relation;label'), relationDimension: get('relation;dimension'),
      source: get('source'), sentence: get('sentence'),
    })
  }
  return recs
}

export function ingestKgtk(as: AtomSpace, text: string): IngestReport {
  return ingestEdgeRecords(as, parseKgtkEdges(text))
}

// ─── Convenience adapters (ConceptNet / ATOMIC → canonical records) ─────────────

export interface CskgEdge { rel: string; start: string; end: string; weight?: number }

/** Legacy simple-edge ingest — maps to canonical records (start/end kept as node ids). */
export function ingestCskg(as: AtomSpace, edges: Iterable<CskgEdge>): IngestReport {
  const recs: CSKGEdgeRecord[] = []
  for (const e of edges) recs.push({ id: '', node1: e.start, relation: e.rel, node2: e.end, source: 'CN', weight: e.weight })
  return ingestEdgeRecords(as, recs)
}

// ConceptNet assertions TSV: <uri>\t<rel>\t<start>\t<end>\t<json-metadata-with-weight>
export function parseConceptNetLine(line: string): CskgEdge | null {
  const cols = line.split('\t')
  if (cols.length < 4) return null
  const [, rel, start, end, meta] = cols
  let weight = 1
  if (meta) { try { const w = (JSON.parse(meta) as { weight?: number }).weight; if (typeof w === 'number') weight = w } catch { /* keep */ } }
  return { rel, start, end, weight }
}

export function ingestConceptNetTsv(as: AtomSpace, text: string): IngestReport {
  const recs: CSKGEdgeRecord[] = []
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t) continue
    const e = parseConceptNetLine(t)
    if (e) recs.push({ id: '', node1: e.start, relation: e.rel, node2: e.end, source: 'CN', weight: e.weight })
  }
  return ingestEdgeRecords(as, recs)
}

export interface AtomicRow { head: string; relation: string; tail: string; weight?: number }

export function ingestAtomic(as: AtomSpace, rows: Iterable<AtomicRow>): IngestReport {
  const recs: CSKGEdgeRecord[] = []
  for (const r of rows) {
    if (!r.tail || r.tail.toLowerCase() === 'none') continue
    recs.push({ id: '', node1: r.head, relation: r.relation, node2: r.tail, source: 'AT', weight: r.weight })
  }
  return ingestEdgeRecords(as, recs)
}
