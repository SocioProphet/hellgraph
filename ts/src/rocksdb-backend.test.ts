import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { RocksDBBackend } from './rocksdb-backend.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rocks-'))

test('RocksDBBackend persists atoms across a close/reopen cycle', async () => {
  const dir = tmp()

  // ── Session 1: write through a Rocks-backed space, then close (drain) ──
  const space1 = new AtomSpace('test-rocks', false) // persist=false → no default backend
  const back1 = await RocksDBBackend.open(dir, 'test-rocks')
  space1.setBackend(back1)
  const g1 = new HellGraphStore(space1)
  g1.addNode('alice', ['Person'], { role: 'eng' })
  g1.addNode('bob', ['Person'], {})
  g1.addEdge('KNOWS', 'alice', 'bob', { confidence: 0.9 })
  await back1.close()

  // ── Session 2: fresh space + fresh backend over the same dir → must restore ──
  const space2 = new AtomSpace('test-rocks', false)
  const back2 = await RocksDBBackend.open(dir, 'test-rocks')
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

  await back2.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('RocksDBBackend.storagePath points inside the store dir', async () => {
  const dir = tmp()
  const b = await RocksDBBackend.open(dir, 'sp')
  assert.match(b.storagePath(), /sp\.rocks$/)
  await b.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
