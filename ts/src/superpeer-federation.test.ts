import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FederatedAtomSpace } from './autobase-view.js'
import { SuperPeer } from './super-peer.js'
import { RegisDeltaWriter, type RegisGraphDelta } from './regis-writer.js'
import { startSuperPeerFromEnv } from './superpeer-service.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-twin-'))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

const delta = (node_id: string): RegisGraphDelta => ({
  delta_id: `delta-${node_id}`,
  operations: [{ kind: 'UPSERT_NODE', node: { node_id, kind: 'ENTITY_CLUSTER' } }],
})

// The unification proof: a node written at the EDGE materializes in the cloud TWIN's super-peer
// /query view via causal-merge federation — no RocksDB blob sync involved. The twin is a
// bootstrapped read-replica that is NEVER admitted as a writer, so it cannot forge/rewrite and
// there is no split-brain: the edge stays sole authority.
test('edge writes materialize in the twin super-peer via federation (no blob sync)', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const edgeDir = tmp()
  const twinDir = tmp()

  // Edge = the sovereign authority (federation creator). Twin = super-peer replica bootstrapped
  // from the edge's federation base key.
  const edge = await FederatedAtomSpace.create(edgeDir)
  const twin = await SuperPeer.create(twinDir, { bootstrap: edge.baseKey() })

  // Direct, signed replication (stands in for Hyperswarm in the test).
  const s1 = edge.replicate(true) as { pipe: (x: unknown) => { pipe: (y: unknown) => void }; destroy: () => void }
  const s2 = twin.replicate(false) as { pipe: (x: unknown) => void; destroy: () => void }
  ;(s1.pipe(s2) as { pipe: (y: unknown) => void }).pipe(s1)
  await wait(200)

  // Edge appends regis nodes to its OWN sovereign log (the write path from hellgraph #11).
  const writer = new RegisDeltaWriter(edge)
  await writer.applyDelta(delta('edge-entity-1'))
  await writer.applyDelta(delta('edge-entity-2'))
  await wait(500)

  // The twin sees them live — materialized from the replicated log, not from an S3 blob.
  const health = await twin.health()
  assert.ok(health.nodes >= 2, `twin materialized edge nodes via federation (nodes=${health.nodes})`)
  const res = (await twin.query('gremlin', 'g.V()')) as { count: number }
  assert.ok(res.count >= 2, `twin /query returns the edge-written nodes (count=${res.count})`)

  // The causal cut reflects the edge as a writer; the twin is NOT a writer in it.
  const cut = await twin.currentCut()
  assert.ok(cut[edge.localWriterKey()] >= 2, 'edge appears in the cut with its ops')
  assert.equal(cut[twin.writerKey()], undefined, 'twin is a read-replica — never a writer in the cut')

  s1.destroy()
  s2.destroy()
  await edge.close()
  await twin.close()
  fs.rmSync(edgeDir, { recursive: true, force: true })
  fs.rmSync(twinDir, { recursive: true, force: true })
})

test('startSuperPeerFromEnv boots a creator super-peer and serves HTTP', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const dir = tmp()
  const { superPeer, port, baseKey } = await startSuperPeerFromEnv({
    HELLGRAPH_STORAGE_DIR: dir,
    HELLGRAPH_HTTP_PORT: '0', // ephemeral
    HELLGRAPH_JOIN_SWARM: '0', // no DHT in tests
  })
  assert.match(baseKey, /^[0-9a-f]{64}$/, 'creator exposes a federation base key')
  assert.ok(port > 0, 'HTTP endpoint bound')
  const res = await fetch(`http://127.0.0.1:${port}/health`)
  const body = (await res.json()) as { ok: boolean }
  assert.equal(body.ok, true)
  await superPeer.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
