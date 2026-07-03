/**
 * RegisDeltaWriter — the sovereign participant-writer that closes the regis→hellgraph loop.
 *
 * The regis ER plane (prophet-platform/apps/regis-acr-api) is opt-in and local-first: when
 * `HELLGRAPH_SUPERPEER_URL` is set, its HellGraphBackend READS the federated view via the
 * super-peer's `POST /query` and STAGES writes as `graph_delta` records in an outbox
 * (`HELLGRAPH_DELTA_OUTBOX`) — because the super-peer is read+govern only and, by design,
 * "cannot forge or rewrite". This writer is the other end of that contract: a hellgraph
 * SOVEREIGN participant that tails the outbox and appends the regis nodes to its OWN Hypercore
 * log via `FederatedAtomSpace.appendEntry`. Autobase then merges it into every participant's
 * materialized view — no central authority, every atom traceable to this writer's signature.
 *
 * Mapping (regis node → hellgraph atom): node_id → ConceptNode name (content-addressed, so
 * ingestion is idempotent), kind + attrs carried on the entry payload. The materialized view is
 * then queryable as `getNode('ConceptNode', node_id)` — the same contract the ER plane's
 * HellGraphBackend reads back.
 */
import * as fs from 'node:fs'
import { nodeHandle, type AtomLogEntry } from './atomspace.js'
import type { FederatedAtomSpace } from './autobase-view.js'

/** A regis node as emitted by regis-acr-api (node.schema.json / graph_delta.schema.json). */
export interface RegisNode {
  node_id: string
  kind: string
  attrs?: Record<string, unknown>
  valid_time?: unknown
  system_time?: unknown
  provenance?: unknown
}

export interface RegisOperation {
  kind: string
  node?: RegisNode
  edge?: unknown
}

export interface RegisGraphDelta {
  delta_id?: string
  schema_version?: string
  source_repo?: string
  operations?: RegisOperation[]
}

/** The atom type regis entity nodes materialize as (proven queryable via getNode/gremlin). */
export const REGIS_ATOM_TYPE = 'ConceptNode'

/** Map one regis node to a sovereign add_atom log entry. node_id is the ConceptNode name, so the
 *  handle is content-addressed and re-appending the same node collapses to one atom (idempotent). */
export function nodeToEntry(node: RegisNode): AtomLogEntry {
  return {
    seq: 1, // per-writer local seq is stamped by appendEntry; content-address is the identity
    ts: new Date().toISOString(),
    op: 'add_atom',
    payload: {
      handle: nodeHandle(REGIS_ATOM_TYPE, node.node_id),
      type: REGIS_ATOM_TYPE,
      name: node.node_id,
      // carried for downstream projection; the guaranteed contract is (type,name) materialization.
      regis_kind: node.kind,
      regis_attrs: node.attrs ?? {},
    },
  }
}

/** Extract sovereign log entries from a graph_delta (UPSERT_NODE ops only in this slice). */
export function deltaToEntries(delta: RegisGraphDelta): AtomLogEntry[] {
  const out: AtomLogEntry[] = []
  for (const op of delta.operations ?? []) {
    if (op.kind === 'UPSERT_NODE' && op.node && typeof op.node.node_id === 'string') {
      out.push(nodeToEntry(op.node))
    }
  }
  return out
}

/** Parse an outbox file (one JSON graph_delta per line; blank lines ignored). */
export function readOutbox(path: string): RegisGraphDelta[] {
  const raw = fs.readFileSync(path, 'utf-8')
  const out: RegisGraphDelta[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t) out.push(JSON.parse(t) as RegisGraphDelta)
  }
  return out
}

export interface ApplyResult {
  deltas: number
  nodes: number
  skipped: number // already-applied (idempotent) handles
}

/**
 * Sovereign writer over a FederatedAtomSpace. Appends regis nodes to THIS participant's log;
 * the causal-merge layer replicates them to the federation. Idempotent within a session via a
 * seen-handle set (atoms are content-addressed, so re-append is harmless regardless).
 */
export class RegisDeltaWriter {
  private readonly seen = new Set<string>()

  constructor(private readonly fed: FederatedAtomSpace) {}

  /** Append all UPSERT_NODE atoms in one delta to the sovereign log. */
  async applyDelta(delta: RegisGraphDelta): Promise<ApplyResult> {
    let nodes = 0
    let skipped = 0
    for (const entry of deltaToEntries(delta)) {
      const handle = String((entry.payload as { handle: string }).handle)
      if (this.seen.has(handle)) {
        skipped++
        continue
      }
      await this.fed.appendEntry(entry)
      this.seen.add(handle)
      nodes++
    }
    return { deltas: 1, nodes, skipped }
  }

  /** Tail an outbox file (JSONL of graph_delta) and append every node to the sovereign log. */
  async applyOutbox(path: string): Promise<ApplyResult> {
    let deltas = 0
    let nodes = 0
    let skipped = 0
    for (const delta of readOutbox(path)) {
      const r = await this.applyDelta(delta)
      deltas += 1
      nodes += r.nodes
      skipped += r.skipped
    }
    return { deltas, nodes, skipped }
  }
}
