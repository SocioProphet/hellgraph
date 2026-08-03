import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { ingestKnowledgeUpdate, type KnowledgeUpdate } from './agent-graph-ingest.js'

function sampleUpdate(): KnowledgeUpdate {
  return {
    schema: 'agent.v1.KnowledgeUpdate',
    graph: 'SYSTEM',
    ts: '2026-08-02T00:00:00Z',
    patch: {
      nodes: [
        { id: 'process:curl#100', kind: 'Process', attrs: { pid: '100', name: 'curl' } },
        { id: 'host:93.184.216.34', kind: 'Host', attrs: { external: 'true' } },
        { id: 'port:443/tcp', kind: 'Port', attrs: { proto: 'tcp' } },
      ],
      edges: [
        { from: 'process:curl#100', rel: 'CONNECTS_TO', to: 'host:93.184.216.34', via: 'port:443/tcp', severity: 'WARN', ts: '2026-08-02T00:00:00Z' },
      ],
    },
    prov: { source: 'netwatch' },
  }
}

test('ingests a KnowledgeUpdate into the expected nodes and edges', () => {
  const g = new HellGraphStore(new AtomSpace('test-agent-ingest', false))
  const res = ingestKnowledgeUpdate(sampleUpdate(), g)

  assert.equal(res.graph, 'SYSTEM')
  assert.equal(res.nodes, 3)
  assert.equal(res.edges, 1)

  const ids = new Set(g.allNodes().map((n) => n.id))
  assert.ok(ids.has('process:curl#100'))
  assert.ok(ids.has('host:93.184.216.34'))
  assert.ok(ids.has('port:443/tcp'))

  const edges = g.allEdges()
  const e = edges.find((x) => x.from === 'process:curl#100' && x.to === 'host:93.184.216.34')
  assert.ok(e, 'CONNECTS_TO edge present')
  assert.equal(e!.label, 'CONNECTS_TO') // AtomSpace stores the relation as edge.label (types.ts)
})

test('is tolerant of an empty / malformed patch', () => {
  const g = new HellGraphStore(new AtomSpace('test-agent-ingest-empty', false))
  const res = ingestKnowledgeUpdate({ patch: {} }, g)
  assert.equal(res.nodes, 0)
  assert.equal(res.edges, 0)
  assert.equal(res.graph, 'SYSTEM') // default graph
  assert.equal(g.allNodes().length, 0)
})
