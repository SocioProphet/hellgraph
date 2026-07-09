import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { communitySummaries } from './graphrag.js'

const summarize = (i: { members: string[]; edges: { from: string; to: string; label: string }[] }): string =>
  `COMMUNITY(${i.members.join(',')})[${i.edges.length} edges]`

test('communitySummaries: one report per Louvain community, over members + internal edges', () => {
  const g = new HellGraphStore(new AtomSpace('grag', false))
  // two tight triangles (communities), linked by a single bridge edge
  for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'a1', 'a2'); g.addEdge('E', 'a2', 'a3'); g.addEdge('E', 'a3', 'a1')
  g.addEdge('E', 'b1', 'b2'); g.addEdge('E', 'b2', 'b3'); g.addEdge('E', 'b3', 'b1')
  g.addEdge('E', 'a1', 'b1') // bridge

  const reports = communitySummaries(g, { summarize })
  assert.ok(reports.length >= 2, 'at least the two triangles are separate communities')

  // every node is covered exactly once across reports
  const covered = reports.flatMap((r) => r.members).sort()
  assert.deepEqual(covered, ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'])

  // the bridge edge is NOT internal to any single community report
  const allReportEdges = reports.flatMap((r) => r.edges)
  assert.ok(!allReportEdges.some((e) => e.from === 'a1' && e.to === 'b1'), 'cross-community bridge is not an internal edge')

  // summaries are deterministic strings over the members
  assert.ok(reports.every((r) => r.summary.startsWith('COMMUNITY(')))
})

test('communitySummaries: minSize filter + textOf mapping + empty graph', () => {
  const g = new HellGraphStore(new AtomSpace('grag2', false))
  g.addNode('x', ['N'], { title: 'Xenon' })
  const reports = communitySummaries(g, {
    summarize: (i) => i.texts.join('|'),
    textOf: (id) => g.getNode(id)?.properties['title'] as string ?? id,
  })
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.summary, 'Xenon', 'textOf feeds node text into the summarizer')

  assert.deepEqual(communitySummaries(g, { summarize, minSize: 2 }), [], 'minSize filters out singletons')
  assert.deepEqual(communitySummaries(new HellGraphStore(new AtomSpace('empty', false)), { summarize }), [])
})
