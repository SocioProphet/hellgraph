/**
 * agent-graph-ingest — ingest an `agent.v1` KnowledgeUpdate delta into the
 * HellGraph AtomSpace, so a node agent's observations (e.g. TurtleTerm
 * `turtle-netwatch`) become queryable graph memory rather than a delta written
 * to a sink nothing consumes.
 *
 * The KnowledgeUpdate shape is the one emitted by netwatch
 * (SourceOS-Linux/TurtleTerm assets/sourceos/schemas/agent/knowledge_update.avsc):
 *   { graph: 'SYSTEM'|'USER', ts, patch: { nodes:[{id,kind,attrs}],
 *     edges:[{from,rel,to,via,severity,ts}] }, prov }
 *
 * Each node -> g.addNode(id, [kind, `${graph}Graph`], {...attrs, graph}); each
 * edge -> g.addEdge(rel, from, to, {via, severity, ts, graph}). Mirrors the
 * write path in acr.ts (the supported façade encoding). Ingestion is memory,
 * not a security mutation — it does not gate or refuse.
 */
import { getHellGraph } from './store.js'

type Store = ReturnType<typeof getHellGraph>

export interface KnowledgeUpdateNode {
  id: string
  kind: string
  attrs?: Record<string, unknown>
}

export interface KnowledgeUpdateEdge {
  from: string
  rel: string
  to: string
  via?: string
  severity?: string
  ts?: string
}

export interface KnowledgeUpdate {
  schema?: string
  graph?: string // 'SYSTEM' | 'USER'
  ts?: string
  patch: { nodes?: KnowledgeUpdateNode[]; edges?: KnowledgeUpdateEdge[] }
  prov?: Record<string, unknown>
}

export interface IngestResult {
  graph: string
  nodes: number
  edges: number
}

/** Ingest one KnowledgeUpdate. Defaults to the process-wide HellGraph singleton
 * (persistent SYSTEM graph); pass a store for tests or a scoped graph. */
export function ingestKnowledgeUpdate(doc: KnowledgeUpdate, g: Store = getHellGraph()): IngestResult {
  const graph = doc.graph ?? 'SYSTEM'
  const patch = doc.patch ?? {}
  const nodes = patch.nodes ?? []
  const edges = patch.edges ?? []

  for (const n of nodes) {
    if (!n || !n.id || !n.kind) continue
    g.addNode(n.id, [n.kind, `${graph}Graph`], { ...(n.attrs ?? {}), graph })
  }
  for (const e of edges) {
    if (!e || !e.from || !e.to || !e.rel) continue
    g.addEdge(e.rel, e.from, e.to, {
      via: e.via ?? null,
      severity: e.severity ?? 'INFO',
      ts: e.ts ?? doc.ts ?? null,
      graph,
    })
  }
  return { graph, nodes: nodes.length, edges: edges.length }
}
