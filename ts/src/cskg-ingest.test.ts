import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import {
  CSKG_RELATION_MAP_VERSION,
  computeEdgeHandle,
  edgeRecordFromAtom,
  findEdgeById,
  ingestAtomic,
  ingestCskg,
  ingestConceptNetTsv,
  ingestEdgeRecord,
  ingestKgtk,
  labelFromNodeId,
  normalizeRelation,
  parseConceptNetLine,
  parseKgtkEdges,
  weightToTruthValue,
  type CSKGEdgeRecord,
} from './cskg-ingest'
import { runCypher } from './cypher'

test('relation normalization is versioned and canonical', () => {
  assert.equal(normalizeRelation('/r/IsA'), 'IsA')
  assert.equal(normalizeRelation('mw:SameAs'), 'SameAs')
  assert.equal(normalizeRelation('xIntent'), 'xIntent')
  assert.equal(normalizeRelation('/r/UnknownRel'), 'UnknownRel')
  assert.equal(CSKG_RELATION_MAP_VERSION, 'cskg-relnorm/v1')
})

test('label derivation strips node-id prefixes/pos', () => {
  assert.equal(labelFromNodeId('/c/en/rain'), 'rain')
  assert.equal(labelFromNodeId('/c/en/wake_up/v'), 'wake_up')
  assert.equal(labelFromNodeId('wn:dog.n.01'), 'dog.n.01')
})

test('weight raises confidence, strength stays asserted', () => {
  assert.deepEqual(weightToTruthValue(1), { strength: 1, confidence: 0.5 })
  assert.ok(weightToTruthValue(9).confidence > weightToTruthValue(1).confidence)
})

// ─── Canonical CSKG edge record (KGTK schema) ───────────────────────────────────

const REC: CSKGEdgeRecord = {
  id: '/c/en/rain-/r/IsA-/c/en/weather_event-0000',
  node1: '/c/en/rain', relation: '/r/IsA', node2: '/c/en/weather_event',
  node1Labels: ['rain'], node2Labels: ['weather event'],
  relationLabels: ['is a'], relationDimensions: ['taxonomic'],
  sources: ['CN'], sentences: ['rain is a kind of weather event'], weight: 3,
}

test('ingestEdgeRecord preserves node ids as identity + labels/metadata as values', () => {
  const as = new AtomSpace('cskg-rec', false)
  const h = ingestEdgeRecord(as, REC)
  assert.ok(as.getNode('ConceptNode', '/c/en/rain'))   // node id is identity, not the lemma
  const back = edgeRecordFromAtom(as, h)
  assert.ok(back)
  assert.equal(back!.id, REC.id)
  assert.equal(back!.node1, '/c/en/rain')
  assert.equal(back!.relation, 'IsA')                  // normalized
  assert.deepEqual(back!.node1Labels, ['rain'])
  assert.deepEqual(back!.relationDimensions, ['taxonomic'])
  assert.deepEqual(back!.sources, ['CN'])
  assert.deepEqual(back!.sentences, ['rain is a kind of weather event'])
})

test('multi-valued cells are canonicalized (dedup + UTF-8 byte sort)', () => {
  const as = new AtomSpace('cskg-canon', false)
  const h = ingestEdgeRecord(as, {
    id: 'e', node1: '/c/en/x', relation: '/r/IsA', node2: '/c/en/y',
    sources: ['WN', 'CN', 'CN', 'AT'],   // dup + unsorted
  })
  assert.deepEqual(edgeRecordFromAtom(as, h)!.sources, ['AT', 'CN', 'WN'])
})

test('edges are addressable by CSKG id (GetEdge support)', () => {
  const as = new AtomSpace('cskg-getedge', false)
  ingestEdgeRecord(as, REC)
  const byId = findEdgeById(as, REC.id)
  assert.ok(byId)
  assert.equal(byId, computeEdgeHandle('/c/en/rain', '/r/IsA', '/c/en/weather_event'))
  assert.equal(findEdgeById(as, 'no-such-id'), undefined)
})

test('synthesized id when the source omits one', () => {
  const as = new AtomSpace('cskg-synthid', false)
  const h = ingestEdgeRecord(as, { id: '', node1: '/c/en/dog', relation: '/r/IsA', node2: '/c/en/animal' })
  assert.equal(edgeRecordFromAtom(as, h)!.id, '/c/en/dog-IsA-/c/en/animal-0000')
})

test('ingest is idempotent (content-addressed)', () => {
  const as = new AtomSpace('cskg-idem', false)
  ingestEdgeRecord(as, REC)
  const after1 = as.count()
  ingestEdgeRecord(as, REC)
  assert.equal(as.count(), after1)
})

// ─── KGTK TSV parser (real CSKG dump format) ────────────────────────────────────

test('parseKgtkEdges is header-driven over the canonical columns', () => {
  const tsv = [
    'id\tnode1\trelation\tnode2\tnode1;label\tnode2;label\trelation;label\trelation;dimension\tsource\tsentence',
    'e1\t/c/en/rain\t/r/RelatedTo\t/c/en/wet\train\twet\trelated to\tlexical\tCN\train is wet',
  ].join('\n')
  const recs = parseKgtkEdges(tsv)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].id, 'e1')
  assert.deepEqual(recs[0].relationDimensions, ['lexical'])
  assert.deepEqual(recs[0].node2Labels, ['wet'])
  const as = new AtomSpace('cskg-kgtk', false)
  const r = ingestKgtk(as, tsv)
  assert.equal(r.edges, 1)
  assert.equal(r.bySource['CN'], 1)
})

// ─── Convenience adapters ────────────────────────────────────────────────────────

test('ConceptNet TSV line parses rel/start/end/weight', () => {
  const line = '/a/[/r/RelatedTo/,/c/en/rain/,/c/en/wet/]\t/r/RelatedTo\t/c/en/rain\t/c/en/wet\t{"weight": 3.5}'
  const e = parseConceptNetLine(line)
  assert.ok(e)
  assert.equal(e!.weight, 3.5)
})

test('ATOMIC ingest skips "none" tails and tags source AT', () => {
  const as = new AtomSpace('cskg-atomic', false)
  const r = ingestAtomic(as, [
    { head: 'PersonX bakes bread', relation: 'xIntent', tail: 'to eat', weight: 1 },
    { head: 'PersonX bakes bread', relation: 'xEffect', tail: 'none' },
  ])
  assert.equal(r.edges, 1)
  assert.equal(r.bySource['AT'], 1)
})

test('round-trip: ingest CSKG then query it via the Cypher facade (by node id)', () => {
  const as = new AtomSpace('cskg-roundtrip', false)
  ingestCskg(as, [
    { rel: '/r/RelatedTo', start: '/c/en/rain', end: '/c/en/wet', weight: 4 },
    { rel: '/r/RelatedTo', start: '/c/en/wet', end: '/c/en/moist', weight: 3 },
  ])
  const oneHop = runCypher(as, 'MATCH (a)-[:RelatedTo]->(b) WHERE a.form = "/c/en/rain" RETURN b LIMIT 25')
  assert.deepEqual(oneHop.rows, [{ b: '/c/en/wet' }])
  const twoHop = runCypher(as, 'MATCH (a)-[:RelatedTo*1..2]->(b) WHERE a.form = "/c/en/rain" RETURN b LIMIT 25')
  assert.deepEqual(twoHop.rows.map((x) => x.b).sort(), ['/c/en/moist', '/c/en/wet'])
})
