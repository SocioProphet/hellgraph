import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import {
  CSKG_RELATION_MAP_VERSION,
  cleanConceptNetTerm,
  ingestAtomic,
  ingestCskg,
  ingestConceptNetTsv,
  normalizeRelation,
  parseConceptNetLine,
  weightToTruthValue,
} from './cskg-ingest'
import { runCypher } from './cypher'

test('relation normalization is versioned and canonical', () => {
  assert.equal(normalizeRelation('/r/IsA'), 'IsA')
  assert.equal(normalizeRelation('/r/UsedFor'), 'UsedFor')
  assert.equal(normalizeRelation('xIntent'), 'xIntent')
  assert.equal(normalizeRelation('/r/UnknownRel'), 'UnknownRel')   // strip /r/ passthrough
  assert.equal(CSKG_RELATION_MAP_VERSION, 'cskg-relnorm/v1')
})

test('ConceptNet term cleaning strips /c/lang/…/pos', () => {
  assert.equal(cleanConceptNetTerm('/c/en/rain'), 'rain')
  assert.equal(cleanConceptNetTerm('/c/en/wake_up/v'), 'wake_up')
  assert.equal(cleanConceptNetTerm('rain'), 'rain')
})

test('weight raises confidence, strength stays asserted', () => {
  assert.deepEqual(weightToTruthValue(1), { strength: 1, confidence: 0.5 })
  assert.ok(weightToTruthValue(9).confidence > weightToTruthValue(1).confidence)
})

test('ingest builds ConceptNode/EvaluationLink with TruthValue', () => {
  const as = new AtomSpace('cskg-1', false)
  const r = ingestCskg(as, [
    { rel: '/r/IsA', start: '/c/en/rain', end: '/c/en/weather_event', weight: 2.0 },
    { rel: '/r/RelatedTo', start: '/c/en/rain', end: '/c/en/wet', weight: 4.0 },
  ])
  assert.equal(r.edges, 2)
  assert.deepEqual([...r.relations].sort(), ['IsA', 'RelatedTo'])
  assert.ok(as.getNode('ConceptNode', 'rain'))
  const evals = as.getByType('EvaluationLink')
  assert.equal(evals.length, 2)
  assert.ok(evals.every((e) => e.tv && e.tv.strength === 1 && e.tv.confidence > 0))
})

test('ingest is idempotent (content-addressed)', () => {
  const as = new AtomSpace('cskg-idem', false)
  const edges = [{ rel: '/r/IsA', start: '/c/en/rain', end: '/c/en/weather_event', weight: 2 }]
  ingestCskg(as, edges)
  const after1 = as.count()
  ingestCskg(as, edges)
  assert.equal(as.count(), after1)   // no new atoms on re-ingest
})

test('ConceptNet TSV line parses rel/start/end/weight', () => {
  const line = '/a/[/r/RelatedTo/,/c/en/rain/,/c/en/wet/]\t/r/RelatedTo\t/c/en/rain\t/c/en/wet\t{"weight": 3.5}'
  const e = parseConceptNetLine(line)
  assert.ok(e)
  assert.equal(e!.rel, '/r/RelatedTo')
  assert.equal(e!.weight, 3.5)
})

test('ingestConceptNetTsv loads a small dump', () => {
  const dump = [
    '/a/x\t/r/IsA\t/c/en/dog\t/c/en/animal\t{"weight": 5}',
    '/a/y\t/r/IsA\t/c/en/cat\t/c/en/animal\t{"weight": 4}',
    '',
  ].join('\n')
  const as = new AtomSpace('cskg-tsv', false)
  const r = ingestConceptNetTsv(as, dump)
  assert.equal(r.edges, 2)
  assert.equal(r.byRelation['IsA'], 2)
})

test('ATOMIC ingest skips "none" tails', () => {
  const as = new AtomSpace('cskg-atomic', false)
  const r = ingestAtomic(as, [
    { head: 'PersonX bakes bread', relation: 'xIntent', tail: 'to eat', weight: 1 },
    { head: 'PersonX bakes bread', relation: 'xEffect', tail: 'none' },
  ])
  assert.equal(r.edges, 1)
  assert.deepEqual([...r.relations], ['xIntent'])
})

test('round-trip: ingest CSKG then query it via the Cypher facade', () => {
  const as = new AtomSpace('cskg-roundtrip', false)
  ingestCskg(as, [
    { rel: '/r/RelatedTo', start: '/c/en/rain', end: '/c/en/wet', weight: 4 },
    { rel: '/r/RelatedTo', start: '/c/en/wet', end: '/c/en/moist', weight: 3 },
  ])
  const oneHop = runCypher(as, 'MATCH (a)-[:RelatedTo]->(b) WHERE a.form = "rain" RETURN b LIMIT 25')
  assert.deepEqual(oneHop.rows, [{ b: 'wet' }])
  const twoHop = runCypher(as, 'MATCH (a)-[:RelatedTo*1..2]->(b) WHERE a.form = "rain" RETURN b LIMIT 25')
  assert.deepEqual(twoHop.rows.map((x) => x.b).sort(), ['moist', 'wet'])
})
