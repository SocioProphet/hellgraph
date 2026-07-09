import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FederatedAtomSpace } from './autobase-view.js'
import { nodeHandle, type AtomLogEntry } from './atomspace.js'
import { startSuperPeerFromEnv } from './superpeer-service.js'
import { HmacTokenVerifier } from './auth.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'hg-cdc-'))
const addConcept = (name: string): AtomLogEntry => ({
  seq: 1,
  ts: new Date().toISOString(),
  op: 'add_atom',
  payload: { handle: nodeHandle('ConceptNode', name), type: 'ConceptNode', name },
})

// ─── CDC change-feed over the causal log (cursor/poll model) ───────────────────────────────
test('changesSince: pull-based CDC returns new ops + an advancing cursor', async (t) => {
  let fed: FederatedAtomSpace
  try { fed = await FederatedAtomSpace.create(tmp()) } catch { return t.skip('autobase/corestore not installed') }
  try {
    const empty = await fed.changesSince(0)
    assert.equal(empty.ops.length, 0, 'no changes yet')

    await fed.appendEntry(addConcept('cdc-a'))
    await fed.appendEntry(addConcept('cdc-b'))

    const r = await fed.changesSince(0)
    assert.equal(r.ops.length, 2, 'both new ops surface from cursor 0')
    assert.ok(r.length >= 2, 'cursor advanced')
    assert.equal(r.ops[0]!.op, 'add_atom')
    assert.ok(r.ops[0]!._fedProv?.writer, 'each change carries writer/seq provenance')

    const caughtUp = await fed.changesSince(r.length)
    assert.equal(caughtUp.ops.length, 0, 'nothing new past the cursor (no re-delivery)')

    await fed.appendEntry(addConcept('cdc-c'))
    const delta = await fed.changesSince(r.length)
    assert.equal(delta.ops.length, 1, 'only the incremental change since the cursor')
  } finally {
    await fed.close()
  }
})

test('super-peer GET /changes: auth-gated CDC endpoint with cursor + cut', async (t) => {
  const secret = 'cdc-superpeer-secret-0123456789'
  let sp: Awaited<ReturnType<typeof startSuperPeerFromEnv>>
  try {
    sp = await startSuperPeerFromEnv({
      HELLGRAPH_AUTH_SECRET: secret,
      HELLGRAPH_HTTP_PORT: '0',
      HELLGRAPH_JOIN_SWARM: '0',
      HELLGRAPH_STORAGE_DIR: tmp(),
    })
  } catch { return t.skip('autobase/corestore not installed') }
  const base = `http://127.0.0.1:${sp.port}`
  try {
    const token = HmacTokenVerifier.fromSecret(secret).mint({ id: 'ops', scopes: ['read', 'query', 'admit'] })
    assert.equal((await fetch(`${base}/changes?since=0`)).status, 401, '/changes requires auth')
    const res = await fetch(`${base}/changes?since=0`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { changes: unknown[]; cursor: number; cut: unknown }
    assert.ok(Array.isArray(body.changes), 'returns a changes array')
    assert.equal(typeof body.cursor, 'number', 'returns a next cursor')
    assert.ok('cut' in body, 'returns the causal frame')
  } finally {
    await sp.superPeer.close()
  }
})
