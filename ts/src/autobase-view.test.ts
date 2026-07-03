import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nodeHandle, type AtomLogEntry } from './atomspace.js'
import { FederatedAtomSpace } from './autobase-view.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-fed-'))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

// A minimal add_atom op for a ConceptNode. Cross-writer seq collisions are fine: atoms
// are content-addressed by handle and the merge order comes from Autobase, not seq.
const addConcept = (name: string): AtomLogEntry => ({
  seq: 1,
  ts: new Date().toISOString(),
  op: 'add_atom',
  payload: { handle: nodeHandle('ConceptNode', name), type: 'ConceptNode', name },
})

test('FederatedAtomSpace merges two sovereign writers into one materialized AtomSpace', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const dir1 = tmp()
  const dir2 = tmp()

  // Two sovereign participants: creator + joiner bootstrapped from the creator's base key.
  const alice = await FederatedAtomSpace.create(dir1)
  const bob = await FederatedAtomSpace.create(dir2, { bootstrap: alice.baseKey() })

  // Symmetric, signed replication — the StorageNodeClient replacement.
  const s1 = alice.replicate(true) as { pipe: (x: unknown) => { pipe: (y: unknown) => void }; destroy: () => void }
  const s2 = bob.replicate(false) as { pipe: (x: unknown) => void; destroy: () => void }
  ;(s1.pipe(s2) as { pipe: (y: unknown) => void }).pipe(s1)
  await wait(200)

  // Alice (an existing writer) admits Bob as a sovereign writer — an auditable log entry.
  assert.equal(bob.isWritable(), false, 'joiner cannot write before admission')
  await alice.admitWriter(bob.localWriterKey())
  await wait(300)
  await bob.update()
  assert.equal(bob.isWritable(), true, 'joiner is writable after admission + sync')

  // Each participant writes to its OWN log; neither owns the other's data.
  await alice.appendEntry(addConcept('alice-fact'))
  await bob.appendEntry(addConcept('bob-fact'))
  await wait(400)

  // Both materialized views converge to the union — causal merge, no central authority.
  const spaceA = await alice.materialize()
  const spaceB = await bob.materialize()

  for (const space of [spaceA, spaceB]) {
    assert.ok(space.getNode('ConceptNode', 'alice-fact'), 'alice-fact present in merged view')
    assert.ok(space.getNode('ConceptNode', 'bob-fact'), 'bob-fact present in merged view')
  }
  assert.equal(spaceA.count(), spaceB.count(), 'both participants converge to the same atom count')

  ;(s1 as { destroy: () => void }).destroy()
  ;(s2 as { destroy: () => void }).destroy()
  await alice.close()
  await bob.close()
  fs.rmSync(dir1, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
})

test('FederatedAtomSpace exposes a stable federation identity and distinct writer key', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const dir = tmp()
  const fed = await FederatedAtomSpace.create(dir)
  assert.match(fed.baseKey(), /^[0-9a-f]{64}$/, 'base key is 32-byte hex (federation identity)')
  assert.match(fed.localWriterKey(), /^[0-9a-f]{64}$/, 'writer key is 32-byte hex (participant identity)')
  assert.equal(fed.isWritable(), true, 'the creator is a writer')
  await fed.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
