import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nodeHandle, type AtomLogEntry } from './atomspace.js'
import { FederatedAtomSpace } from './autobase-view.js'
import { SuperPeer } from './super-peer.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sp-'))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

const addConcept = (name: string): AtomLogEntry => ({
  seq: 1, ts: new Date().toISOString(), op: 'add_atom',
  payload: { handle: nodeHandle('ConceptNode', name), type: 'ConceptNode', name },
})

// End-to-end: a super-peer indexes a sovereign participant's log and serves it over HTTP,
// without any DHT — direct replication stands in for Hyperswarm transport.
test('SuperPeer indexes a sovereign participant and serves it over HTTP', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const spDir = tmp()
  const partDir = tmp()

  // Super-peer creates the federation; participant joins from its base key.
  const sp = await SuperPeer.create(spDir)
  const participant = await FederatedAtomSpace.create(partDir, { bootstrap: sp.baseKey() })

  const s1 = sp.replicate(true) as { pipe: (x: unknown) => { pipe: (y: unknown) => void }; destroy: () => void }
  const s2 = participant.replicate(false) as { pipe: (x: unknown) => void; destroy: () => void }
  ;(s1.pipe(s2) as { pipe: (y: unknown) => void }).pipe(s1)

  const port = await sp.listen(0)
  const base = `http://127.0.0.1:${port}`

  try {
    await wait(200)

    // Admit the participant via the governance endpoint (signed addWriter control op).
    const admitRes = await fetch(`${base}/admit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writerKey: participant.localWriterKey() }),
    })
    assert.equal(admitRes.status, 200)
    await wait(300)
    await participant.update()
    assert.equal(participant.isWritable(), true, 'participant admitted via HTTP')

    // Participant writes to its OWN sovereign log.
    await participant.appendEntry(addConcept('reactor-core'))
    await participant.appendEntry(addConcept('coolant-loop'))
    await wait(400)

    // Health reflects the indexed view + the causal cut over the participant writer.
    const health = await (await fetch(`${base}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.baseKey, sp.baseKey())
    assert.ok(health.nodes >= 2, 'super-peer indexed the participant nodes')
    assert.equal(health.cut[participant.localWriterKey()], 2, 'cut shows 2 ops from the participant')

    // Query the materialized view over HTTP (Gremlin vertex count over the merged graph).
    const qRes = await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'gremlin', query: 'g.V().count()' }),
    })
    const q = await qRes.json()
    assert.equal(qRes.status, 200)
    assert.ok(JSON.stringify(q.results).includes('2'), 'query sees both participant atoms')

    // A malformed query is rejected, not crashed.
    const bad = await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'nope', query: 1 }),
    })
    assert.equal(bad.status, 400)
  } finally {
    ;(s1 as { destroy: () => void }).destroy()
    ;(s2 as { destroy: () => void }).destroy()
    await sp.close()
    await participant.close()
    fs.rmSync(spDir, { recursive: true, force: true })
    fs.rmSync(partDir, { recursive: true, force: true })
  }
})
