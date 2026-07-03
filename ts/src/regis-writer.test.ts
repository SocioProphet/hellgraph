import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nodeHandle } from './atomspace.js'
import { FederatedAtomSpace } from './autobase-view.js'
import {
  REGIS_ATOM_TYPE,
  RegisDeltaWriter,
  deltaToEntries,
  nodeToEntry,
  readOutbox,
  type RegisGraphDelta,
} from './regis-writer.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-regis-'))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

const delta = (node_id: string, kind = 'ENTITY_CLUSTER'): RegisGraphDelta => ({
  delta_id: `delta-${node_id}`,
  operations: [{ kind: 'UPSERT_NODE', node: { node_id, kind, attrs: { scope: 'CITIZEN_FOG' } } }],
})

// ─── pure mapping (always runs; no P2P deps) ────────────────────────────────────
test('nodeToEntry maps a regis node to a content-addressed ConceptNode add_atom', () => {
  const e = nodeToEntry({ node_id: 'entity-1', kind: 'PERSON', attrs: { a: 1 } })
  assert.equal(e.op, 'add_atom')
  const p = e.payload as Record<string, unknown>
  assert.equal(p.type, REGIS_ATOM_TYPE)
  assert.equal(p.name, 'entity-1')
  assert.equal(p.handle, nodeHandle(REGIS_ATOM_TYPE, 'entity-1'), 'handle is content-addressed by node_id')
  assert.equal(p.regis_kind, 'PERSON')
})

test('deltaToEntries extracts UPSERT_NODE ops and ignores others', () => {
  const d: RegisGraphDelta = {
    operations: [
      { kind: 'UPSERT_NODE', node: { node_id: 'a', kind: 'ORG' } },
      { kind: 'VETO_EDGE', edge: {} },
      { kind: 'UPSERT_NODE', node: { node_id: 'b', kind: 'ORG' } },
    ],
  }
  const entries = deltaToEntries(d)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((e) => (e.payload as { name: string }).name), ['a', 'b'])
})

test('readOutbox parses JSONL and ignores blank lines', () => {
  const dir = tmp()
  const f = path.join(dir, 'deltas.jsonl')
  fs.writeFileSync(f, JSON.stringify(delta('x')) + '\n\n' + JSON.stringify(delta('y')) + '\n')
  const deltas = readOutbox(f)
  assert.equal(deltas.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('applyDelta is idempotent on repeated node_id (content-addressed)', async () => {
  // a fake FederatedAtomSpace that just records appended entries
  const appended: unknown[] = []
  const fakeFed = { appendEntry: async (e: unknown) => { appended.push(e) } } as unknown as FederatedAtomSpace
  const w = new RegisDeltaWriter(fakeFed)
  const r1 = await w.applyDelta(delta('dup'))
  const r2 = await w.applyDelta(delta('dup'))
  assert.equal(r1.nodes, 1)
  assert.equal(r2.nodes, 0)
  assert.equal(r2.skipped, 1)
  assert.equal(appended.length, 1, 're-applying the same node_id does not re-append')
})

// ─── sovereign write loop (skips if autobase/corestore absent) ──────────────────
test('RegisDeltaWriter appends regis nodes to the sovereign log; they materialize in the view', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const dir = tmp()          // Corestore storage for the sovereign log
  const obxDir = tmp()       // outbox lives outside the corestore dir (Corestore owns `dir`)
  const outbox = path.join(obxDir, 'deltas.jsonl')
  fs.writeFileSync(outbox, JSON.stringify(delta('entity-alpha')) + '\n' + JSON.stringify(delta('entity-beta')) + '\n')

  const fed = await FederatedAtomSpace.create(dir)
  const writer = new RegisDeltaWriter(fed)
  const res = await writer.applyOutbox(outbox)
  assert.equal(res.deltas, 2)
  assert.equal(res.nodes, 2)
  await wait(200)

  // the sovereign write is present in this participant's materialized view — same contract the
  // ER plane's HellGraphBackend reads back via the super-peer.
  const space = await fed.materialize()
  assert.ok(space.getNode(REGIS_ATOM_TYPE, 'entity-alpha'), 'entity-alpha materialized from the sovereign log')
  assert.ok(space.getNode(REGIS_ATOM_TYPE, 'entity-beta'), 'entity-beta materialized from the sovereign log')

  await fed.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(obxDir, { recursive: true, force: true })
})
