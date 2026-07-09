import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { parseCsv, loadNodesCsv, loadEdgesCsv } from './bulk.js'

test('parseCsv: quotes, embedded commas + newlines, "" escapes', () => {
  const csv = 'id,name,note\n1,"Doe, John","line1\nline2"\n2,Jane,"say ""hi"""\n'
  const { headers, rows } = parseCsv(csv)
  assert.deepEqual(headers, ['id', 'name', 'note'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.name, 'Doe, John', 'quoted comma preserved')
  assert.equal(rows[0]!.note, 'line1\nline2', 'quoted newline preserved')
  assert.equal(rows[1]!.note, 'say "hi"', 'escaped quotes')
})

test('loadNodesCsv: ids, labels (static + column), typed properties', () => {
  const g = new HellGraphStore(new AtomSpace('bulk', false))
  const csv = 'id,kind,age,active\nu1,User,30,true\nu2,Admin,25,false\n'
  const n = loadNodesCsv(g, csv, { id: 'id', labels: ['Person'], labelColumn: 'kind' })
  assert.equal(n, 2)
  const u1 = g.getNode('u1')!
  assert.ok(u1.labels.includes('Person') && u1.labels.includes('User'), 'static + column labels')
  assert.equal(u1.properties['age'], 30, 'numeric coercion')
  assert.equal(u1.properties['active'], true, 'boolean coercion')
  assert.equal(g.getNode('u2')!.properties['active'], false)
})

test('loadEdgesCsv: from/to + label column + edge properties', () => {
  const g = new HellGraphStore(new AtomSpace('bulk2', false))
  loadNodesCsv(g, 'id\na\nb\nc\n', { id: 'id', labels: ['N'] })
  const m = loadEdgesCsv(g, 'src,dst,rel,weight\na,b,KNOWS,0.9\nb,c,LIKES,0.5\n', { from: 'src', to: 'dst', labelColumn: 'rel' })
  assert.equal(m, 2)
  const edges = g.allEdges()
  const knows = edges.find((e) => e.from === 'a' && e.to === 'b')!
  assert.equal(knows.label, 'KNOWS')
  assert.equal(knows.properties['weight'], 0.9)
})

test('bulk: empty / malformed rows are skipped', () => {
  const g = new HellGraphStore(new AtomSpace('bulk3', false))
  assert.equal(loadNodesCsv(g, 'id,x\n\n,skipme\nok,1\n', { id: 'id' }), 1, 'row without an id is skipped')
  assert.equal(g.getNode('ok')!.properties['x'], 1)
})
