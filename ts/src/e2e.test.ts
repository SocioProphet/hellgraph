import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nodeHandle, linkHandle, type AtomLogEntry } from './atomspace.js'
import { CanonicalObjectStore } from './object-store.js'
import { Governor, InMemoryAuditLog } from './policy.js'
import { StaticKeyProvider, isMasked, getAtPath } from './masking.js'
import { VendorCacheManager, type VendorFilesClient } from './vendor-cache.js'
import { FederatedAtomSpace } from './autobase-view.js'
import { SuperPeer } from './super-peer.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-e2e-'))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

const addNode = (name: string): AtomLogEntry => ({
  seq: 1, ts: new Date().toISOString(), op: 'add_atom',
  payload: { handle: nodeHandle('ConceptNode', name), type: 'ConceptNode', name },
})
const addLink = (type: string, from: string, to: string): AtomLogEntry => ({
  seq: 1, ts: new Date().toISOString(), op: 'add_atom',
  payload: { handle: linkHandle(type, [from, to]), type, outgoing: [from, to] },
})

class FakeVendor implements VendorFilesClient {
  readonly uploads = new Map<string, string>()
  private seq = 0
  async uploadFile(content: string): Promise<string> { const id = `f${++this.seq}`; this.uploads.set(id, content); return id }
  async deleteFile(id: string): Promise<void> { this.uploads.delete(id) }
}

// The whole thesis in one flow: a sovereign participant ingests a record (codex-sealed +
// content-governed), federates a fact, the super-peer serves the causally-merged view over
// MeTTa, and the record egresses to a vendor only with PHI masked — all verifiable.
test('end-to-end: ingest→seal→federate→query→provenance→masked egress→tamper-detect', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')

  // ── L1: canonical ingest + codex seal ──────────────────────────────────────────
  const store = new CanonicalObjectStore()
  const record = JSON.stringify({ patient: { name: 'alice', ssn: '123-45-6789' } })
  const entry = await store.ingest('rec1', record, {
    mime: 'application/json', residency: 'EU', sensitiveFields: ['$.patient.ssn'],
  })
  assert.equal((await store.verify('rec1')).class, 'INTACT', 'sealed at ingest')
  assert.match(entry.codex._sha256, /^[0-9a-f]{16}$/)

  // ── Federation: sovereign participant + super-peer index ────────────────────────
  const sp = await SuperPeer.create(tmp())
  const participant = await FederatedAtomSpace.create(tmp(), { bootstrap: sp.baseKey() })
  const s1 = sp.replicate(true) as { pipe: (x: unknown) => { pipe: (y: unknown) => void }; destroy: () => void }
  const s2 = participant.replicate(false) as { pipe: (x: unknown) => void; destroy: () => void }
  ;(s1.pipe(s2) as { pipe: (y: unknown) => void }).pipe(s1)
  await wait(200)
  await sp.admit(participant.localWriterKey())
  await wait(300)
  await participant.update()

  try {
    // Participant writes a fact into its OWN sovereign log: (Inheritance alice Patient).
    const aliceH = nodeHandle('ConceptNode', 'alice')
    const patientH = nodeHandle('ConceptNode', 'Patient')
    await participant.appendEntry(addNode('alice'))
    await participant.appendEntry(addNode('Patient'))
    await participant.appendEntry(addLink('InheritanceLink', aliceH, patientH))
    await wait(400)

    // ── Query the causally-merged view over MeTTa (via the super-peer) ────────────
    const results = (await sp.query('metta', '(match &self (InheritanceLink $x (ConceptNode Patient)) $x)')) as string[]
    assert.deepEqual(results, ['alice'], 'federated fact retrievable via DAS/MeTTa over the merged view')

    // ── Proof-cut provenance travels from canonical + the causal frame ────────────
    const cut = await sp.currentCut()
    assert.equal(cut[participant.localWriterKey()], 3, 'cut reflects the 3 sovereign ops')
    const prov = store.provenanceOf('rec1', cut)
    assert.equal(prov.codexSha, entry.codex._sha256, 'content integrity carried into provenance')
    assert.deepEqual(prov.cut, cut, 'causal frame carried')

    // ── L5 + L3: opt-in vendor egress masks PHI before it leaves the cell ─────────
    store.setState('rec1', 'Served')
    const vendor = new FakeVendor()
    const mgr = new VendorCacheManager(store, new Governor({ rules: [] }, new InMemoryAuditLog()),
      StaticKeyProvider.fromPassphrase('tenant-key'), { gemini: vendor })

    const denied = await mgr.materialize('rec1', 'gemini', { optIn: false, ttlMs: 1000 })
    assert.equal(denied.ok, false, 'no opt-in → nothing leaves the cell')

    const m = await mgr.materialize('rec1', 'gemini', { optIn: true, ttlMs: 1000 })
    assert.equal(m.ok, true)
    const uploaded = JSON.parse(vendor.uploads.get((m as { handle: { fileId: string } }).handle.fileId)!)
    assert.ok(isMasked(getAtPath(uploaded, '$.patient.ssn')), 'PHI masked before egress')
    assert.equal(getAtPath(uploaded, '$.patient.name'), 'alice', 'non-sensitive field intact')

    // ── Integrity: tamper on the canonical content is detected AND classified ─────
    const tampered = await store.verify('rec1', JSON.stringify({ patient: { name: 'alice', ssn: '000-00-0000' } }))
    assert.equal(tampered.verdict, 'NEG', 'canonical tamper detected')
  } finally {
    s1.destroy(); s2.destroy()
    await sp.close(); await participant.close()
  }
})
