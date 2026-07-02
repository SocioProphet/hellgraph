import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { HypercoreBackend } from './hypercore-backend.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hyper-'))

// hypercore is an optional dependency. If it isn't installed, open() throws and the
// engine falls back to another backend — so skip rather than fail in that environment.
async function hypercoreAvailable(): Promise<boolean> {
  try { await import('hypercore'); return true } catch { return false }
}

test('HypercoreBackend persists atoms across a close/reopen cycle', async (t) => {
  if (!(await hypercoreAvailable())) return t.skip('hypercore binding not installed')
  const dir = tmp()

  // ── Session 1: write through a Hypercore-backed space, then close (drain) ──
  const space1 = new AtomSpace('test-hyper', false) // persist=false → no default backend
  const back1 = await HypercoreBackend.open(dir, 'test-hyper')
  space1.setBackend(back1)
  const g1 = new HellGraphStore(space1)
  g1.addNode('alice', ['Person'], { role: 'eng' })
  g1.addNode('bob', ['Person'], {})
  g1.addEdge('KNOWS', 'alice', 'bob', { confidence: 0.9 })
  const key1 = back1.publicKey()
  assert.ok(key1 && key1.length === 64, 'participant public key is a 32-byte hex identity')
  assert.equal(back1.isWritable(), true, 'the local core is the writer')
  await back1.close()

  // ── Session 2: fresh space + fresh backend over the same dir → must restore ──
  const space2 = new AtomSpace('test-hyper', false)
  const back2 = await HypercoreBackend.open(dir, 'test-hyper')
  space2.setBackend(back2)
  const g2 = new HellGraphStore(space2)

  const alice = g2.getNode('alice')
  assert.ok(alice, 'alice restored')
  assert.equal(alice!.properties['role'], 'eng')
  assert.ok(g2.getNode('bob'), 'bob restored')
  const edges = g2.allEdges().filter((e) => e.label === 'KNOWS')
  assert.equal(edges.length, 1, 'KNOWS edge restored')
  assert.equal(edges[0]!.from, 'alice')
  assert.equal(edges[0]!.to, 'bob')

  // Identity is stable across reopen (persisted keypair) — the sovereignty invariant.
  assert.equal(back2.publicKey(), key1, 'participant identity is stable across restarts')

  await back2.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('HypercoreBackend.storagePath points inside the store dir', async (t) => {
  if (!(await hypercoreAvailable())) return t.skip('hypercore binding not installed')
  const dir = tmp()
  const b = await HypercoreBackend.open(dir, 'sp')
  assert.match(b.storagePath(), /sp\.hypercore$/)
  await b.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
