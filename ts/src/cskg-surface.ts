import { createHash } from 'node:crypto'
import { AtomSpace, nodeHandle, type Handle } from './atomspace'
import {
  edgeRecordFromAtom, findEdgeById, computeEdgeHandle, ingestEdgeRecord, ingestEdgeRecords,
  normalizeRelation, type CSKGEdgeRecord, type IngestReport,
} from './cskg-ingest'

/**
 * CSKG root-surface operations — the `cskg.vnext` route family over the AtomSpace.
 *
 * Conforms to cskg_vnext_root_surface_expansion.md / cskg_vnext_profile.md. The
 * four added routes compose primitives HellGraph already has:
 *   GetEdge(h19)        exact-id read (pure)            → edgeRecordFromAtom
 *   DeleteEdge(h20)     tombstone/logical-delete        → erase-iso + semantic.commit.v1
 *   ResolveSameAs(h23)  mw:SameAs identity resolution   → SameAs-edge traversal
 *   CommitSnapshot(h24) barrier-gated freeze/provenance → replay-anchor + attestation
 *
 * Shared-control semantics use the upstream typed-delta model: durable closure is
 * `semantic.commit.v1` (never a bespoke "beacon"), and authoritative invalidation
 * / verified-evidence promotion attaches `policy_attestation_v1`. Atlas
 * observations are evidentiary-only and never appear here. Go/Rust wire parity is
 * intentionally deferred (per BRANCH_PLAN: not into stable go/rust lanes yet).
 */

export const ROUTE_HANDLES = { GetEdge: 19, DeleteEdge: 20, ResolveSameAs: 23, CommitSnapshot: 24 } as const

const TOMBSTONE = 'cskg:tombstoned'
const TOMBSTONE_AT = 'cskg:tombstoned_at'

// ─── Typed deltas (upstream families) ───────────────────────────────────────────

export interface PolicyAttestationV1 {
  kind: 'policy.attestation.v1'
  attestationHash: string
  signer?: string
  signature?: string
  at: string
}

export interface SemanticCommitV1 {
  kind: 'semantic.commit.v1'
  commitKind: 'tombstone' | 'invalidate' | 'receipt' | 'replay_anchor'
  subjectId: string          // edge id or snapshot id
  receiptHash: string        // binds pre-state → commit (the erase-iso / freeze certificate)
  at: string
  policyAttestation?: PolicyAttestationV1
}

// ─── Requests / results ──────────────────────────────────────────────────────

export interface CSKGEdgeLookupRequest { id?: string; node1?: string; relation?: string; node2?: string }
export interface CSKGDeleteRequest extends CSKGEdgeLookupRequest { commitKind?: 'tombstone' | 'invalidate'; authoritative?: boolean }
export interface CSKGSameAsRequest { nodeId: string; maxHops?: number }
export interface CSKGNodeSetResult { canonical: string; aliases: string[]; evidence: { edgeId: string; via: string; sources?: string[] }[] }
export interface CSKGSnapshotManifest { snapshotId: string; scope?: string; datasetVersion?: string; authoritative?: boolean }

export interface SurfaceOptions {
  /** Inject a signer to produce a signed policy_attestation.v1 (else hash-only). */
  attest?: (bytes: string) => { signer: string; signature: string }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString()
const sha256 = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex')
const byteCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
const stable = (o: unknown): string => JSON.stringify(o, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v)

const isTombstoned = (as: AtomSpace, h: Handle): boolean => {
  const v = as.getAtom(h)?.values[TOMBSTONE]
  return !!(v && v.kind === 'string' && v.value[0] === 'true')
}

function resolveHandle(as: AtomSpace, req: CSKGEdgeLookupRequest): Handle | undefined {
  if (req.id) return findEdgeById(as, req.id)
  if (req.node1 && req.relation && req.node2) {
    const h = computeEdgeHandle(req.node1, req.relation, req.node2)
    return as.getAtom(h) ? h : undefined
  }
  return undefined
}

function attestation(bytes: string, opts?: SurfaceOptions): PolicyAttestationV1 {
  const att: PolicyAttestationV1 = { kind: 'policy.attestation.v1', attestationHash: sha256(bytes), at: now() }
  if (opts?.attest) { const { signer, signature } = opts.attest(bytes); att.signer = signer; att.signature = signature }
  return att
}

// ─── PutEdge / GetEdge ─────────────────────────────────────────────────────────

/** PutEdge — insert/upsert one canonical CSKG edge record. */
export function putEdge(as: AtomSpace, rec: CSKGEdgeRecord): { edgeId: string; handle: Handle } {
  const handle = ingestEdgeRecord(as, rec)
  return { edgeId: edgeRecordFromAtom(as, handle)?.id ?? rec.id, handle }
}

/** GetEdge — exact-id read. Pure; no shared delta. Tombstoned edges read as gone. */
export function getEdge(as: AtomSpace, req: CSKGEdgeLookupRequest): CSKGEdgeRecord | null {
  const h = resolveHandle(as, req)
  if (!h || isTombstoned(as, h)) return null
  return edgeRecordFromAtom(as, h)
}

// ─── DeleteEdge (erase-iso → semantic.commit.v1) ────────────────────────────────

/**
 * DeleteEdge — logical delete (tombstone). The durable shared closure is
 * `semantic.commit.v1` (commit_kind=tombstone|invalidate), with `policy_attestation_v1`
 * when the invalidation is authoritative. The receiptHash is the erase-iso
 * certificate binding the pre-edge state to the tombstone.
 */
export function deleteEdge(as: AtomSpace, req: CSKGDeleteRequest, opts?: SurfaceOptions):
  { result: { edgeId: string; tombstoned: boolean; found: boolean }; commit?: SemanticCommitV1 } {
  const h = resolveHandle(as, req)
  if (!h || isTombstoned(as, h)) return { result: { edgeId: req.id ?? '', tombstoned: false, found: false } }

  const pre = edgeRecordFromAtom(as, h)!
  const preDigest = sha256(stable(pre))
  as.setValue(h, TOMBSTONE, { kind: 'string', value: ['true'] })
  as.setValue(h, TOMBSTONE_AT, { kind: 'string', value: [now()] })

  const commitKind = req.commitKind ?? 'tombstone'
  const commit: SemanticCommitV1 = {
    kind: 'semantic.commit.v1', commitKind, subjectId: pre.id,
    receiptHash: sha256(`${pre.id}|${preDigest}|${commitKind}`), at: now(),
  }
  if (req.authoritative) commit.policyAttestation = attestation(`${pre.id}|${commit.receiptHash}`, opts)
  return { result: { edgeId: pre.id, tombstoned: true, found: true }, commit }
}

// ─── ResolveSameAs (mw:SameAs consolidation) ────────────────────────────────────

/**
 * ResolveSameAs — read/decision identity route. Traverses `SameAs` edges from the
 * seed node (both directions, bounded), returns the canonical node id
 * (byte-smallest in the equivalence set) plus aliases and edge evidence. No shared
 * delta by default; a later authoritative merge would publish `semantic.commit.v1`.
 */
export function resolveSameAs(as: AtomSpace, req: CSKGSameAsRequest): CSKGNodeSetResult {
  const maxHops = req.maxHops ?? 3
  const seen = new Set<string>([req.nodeId])
  const evidence: CSKGNodeSetResult['evidence'] = []
  let frontier = [req.nodeId]

  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = []
    for (const nodeId of frontier) {
      const nH = nodeHandle('ConceptNode', nodeId)
      for (const list of as.getIncoming(nH, 'ListLink')) {
        for (const ev of as.getIncoming(list.handle, 'EvaluationLink')) {
          if (isTombstoned(as, ev.handle)) continue
          const rec = edgeRecordFromAtom(as, ev.handle)
          if (!rec || rec.relation !== 'SameAs') continue
          const other = rec.node1 === nodeId ? rec.node2 : rec.node1
          evidence.push({ edgeId: rec.id, via: nodeId, sources: rec.sources })
          if (!seen.has(other)) { seen.add(other); next.push(other) }
        }
      }
    }
    frontier = next
  }

  const members = [...seen].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  return { canonical: members[0], aliases: members.filter((m) => m !== members[0]), evidence }
}

// ─── CommitSnapshot (barrier-gated freeze → replay-anchor) ──────────────────────

/**
 * CommitSnapshot — barrier-gated freeze/provenance route. Produces a deterministic
 * manifest digest over the live (non-tombstoned) edge ids and closes with
 * `semantic.commit.v1` (commit_kind=replay_anchor) + `policy_attestation_v1`
 * (required — a snapshot changes shared evidence posture). Snapshot completion is
 * NOT a route_policy_delta; posture change is a separate event.
 */
export function commitSnapshot(as: AtomSpace, manifest: CSKGSnapshotManifest, opts?: SurfaceOptions):
  { result: { snapshotId: string; edgeCount: number; manifestDigest: string; cut: number }; commit: SemanticCommitV1 } {
  const edgeIds: string[] = []
  for (const e of as.getByType('EvaluationLink')) {
    if (isTombstoned(as, e.handle)) continue
    const rec = edgeRecordFromAtom(as, e.handle)
    if (rec?.id) edgeIds.push(rec.id)
  }
  edgeIds.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))

  const cut = as.logicalClock
  const manifestDigest = sha256(stable({ snapshotId: manifest.snapshotId, datasetVersion: manifest.datasetVersion ?? '', edgeIds }))
  const receiptHash = sha256(`${manifest.snapshotId}|${manifestDigest}|${cut}`)
  const commit: SemanticCommitV1 = {
    kind: 'semantic.commit.v1', commitKind: 'replay_anchor', subjectId: manifest.snapshotId,
    receiptHash, at: now(),
    policyAttestation: attestation(`${manifest.snapshotId}|${manifestDigest}|${cut}`, opts),
  }
  return { result: { snapshotId: manifest.snapshotId, edgeCount: edgeIds.length, manifestDigest, cut }, commit }
}

// ─── PutAux / GetAux (edge-linked sparse facts) ─────────────────────────────────

export interface CSKGAuxRecord { edgeId: string; key: string; value: string; mediaType?: string; contentHash?: string }

/** PutAux — attach a sparse auxiliary fact by edge id (e.g. a weight, a note). */
export function putAux(as: AtomSpace, aux: CSKGAuxRecord):
  { edgeId: string; key: string; contentHash: string; found: boolean } {
  const h = findEdgeById(as, aux.edgeId)
  if (!h) return { edgeId: aux.edgeId, key: aux.key, contentHash: '', found: false }
  const contentHash = aux.contentHash ?? sha256(aux.value)
  as.setValue(h, `cskg:aux:${aux.key}`, { kind: 'string', value: [JSON.stringify({ value: aux.value, mediaType: aux.mediaType, contentHash })] })
  return { edgeId: aux.edgeId, key: aux.key, contentHash, found: true }
}

/** All auxiliary facts attached to an edge. */
export function getAux(as: AtomSpace, edgeId: string): CSKGAuxRecord[] {
  const h = findEdgeById(as, edgeId)
  const atom = h ? as.getAtom(h) : undefined
  if (!atom) return []
  const out: CSKGAuxRecord[] = []
  for (const [k, v] of Object.entries(atom.values)) {
    if (k.startsWith('cskg:aux:') && v.kind === 'string') {
      const p = JSON.parse(v.value[0]) as { value: string; mediaType?: string; contentHash?: string }
      out.push({ edgeId, key: k.slice('cskg:aux:'.length), value: p.value, mediaType: p.mediaType, contentHash: p.contentHash })
    }
  }
  return out.sort((a, b) => byteCmp(a.key, b.key))
}

// ─── ScanEdges / GetSubgraphStream (QuerySpec-driven, deterministic order) ───────

export interface CSKGQuerySpec {
  seedIds?: string[]          // restrict to edges touching these node ids
  relationFilter?: string[]   // canonical or raw relations
  dimensionFilter?: string[]
  sourceFilter?: string[]
  limit?: number
  cursor?: string             // resume strictly after this edge id (byte order)
}

/** ScanEdges — filtered edge scan with deterministic (edge-id byte) ordering. */
export function scanEdges(as: AtomSpace, spec: CSKGQuerySpec = {}): CSKGEdgeRecord[] {
  const rel = spec.relationFilter?.map(normalizeRelation)
  const seeds = spec.seedIds ? new Set(spec.seedIds) : undefined
  let recs: CSKGEdgeRecord[] = []
  for (const e of as.getByType('EvaluationLink')) {
    if (isTombstoned(as, e.handle)) continue
    const r = edgeRecordFromAtom(as, e.handle)
    if (!r) continue
    if (seeds && !(seeds.has(r.node1) || seeds.has(r.node2))) continue
    if (rel && !rel.includes(r.relation)) continue
    if (spec.dimensionFilter && !(r.relationDimensions ?? []).some((d) => spec.dimensionFilter!.includes(d))) continue
    if (spec.sourceFilter && !(r.sources ?? []).some((s) => spec.sourceFilter!.includes(s))) continue
    recs.push(r)
  }
  recs.sort((a, b) => byteCmp(a.id, b.id))
  if (spec.cursor) recs = recs.filter((r) => byteCmp(r.id, spec.cursor!) > 0)
  return spec.limit != null ? recs.slice(0, spec.limit) : recs
}

/** GetSubgraphStream — bounded neighborhood expansion from seed node ids. */
export function getSubgraphStream(as: AtomSpace, spec: CSKGQuerySpec = {}, hops = 1): CSKGEdgeRecord[] {
  const visited = new Set(spec.seedIds ?? [])
  const collected = new Map<string, CSKGEdgeRecord>()
  let frontier = [...visited]
  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const next: string[] = []
    for (const r of scanEdges(as, { ...spec, seedIds: frontier, limit: undefined, cursor: undefined })) {
      collected.set(r.id, r)
      for (const n of [r.node1, r.node2]) if (!visited.has(n)) { visited.add(n); next.push(n) }
    }
    frontier = next
  }
  const out = [...collected.values()].sort((a, b) => byteCmp(a.id, b.id))
  return spec.limit != null ? out.slice(0, spec.limit) : out
}

// ─── BulkPutEdges (high-throughput ingest, inherited semantics) ─────────────────

export function bulkPutEdges(as: AtomSpace, recs: Iterable<CSKGEdgeRecord>): IngestReport {
  return ingestEdgeRecords(as, recs)
}
