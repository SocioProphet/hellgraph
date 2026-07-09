/**
 * graphrag — community-summary reports (Microsoft GraphRAG's signature move). Detect communities
 * (Louvain), then summarize each into a "community report" over its members + internal edges. The
 * reports are high-level, graph-structured context you can retrieve alongside leaf chunks — the
 * global-question complement to fine-grained retrieval (RAPTOR does this over text clusters; this
 * does it over graph communities).
 *
 * `summarize` is INJECTED (engine stays LLM-dependency-free; prod passes an LLM). Deterministic:
 * Louvain here is deterministic and members/edges are emitted in a stable order.
 */
import type { HellGraphStore } from './store.js'
import { louvain } from './graph-analytics.js'

export interface CommunityEdge { from: string; to: string; label: string }
export interface CommunityReport {
  community: string
  members: string[]
  edges: CommunityEdge[]
  summary: string
}
export interface CommunitySummaryOptions {
  /** Produce a report string for one community from its members, their texts, and internal edges. */
  summarize: (input: { members: string[]; texts: string[]; edges: CommunityEdge[] }) => string
  /** Map a node id to its text (default: the id itself). */
  textOf?: (nodeId: string) => string
  /** Skip communities smaller than this (default 1 → keep all). */
  minSize?: number
}

/** One community report per detected community, in ascending community-id order. */
export function communitySummaries(store: HellGraphStore, opts: CommunitySummaryOptions): CommunityReport[] {
  const comm = louvain(store)
  const groups = new Map<string, string[]>()
  for (const [id, c] of comm) {
    const g = groups.get(c) ?? []
    g.push(id)
    groups.set(c, g)
  }
  const allEdges = store.allEdges()
  const minSize = Math.max(1, opts.minSize ?? 1)
  const reports: CommunityReport[] = []
  for (const [c, rawMembers] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (rawMembers.length < minSize) continue
    const members = rawMembers.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const memberSet = new Set(members)
    const edges = allEdges
      .filter((e) => memberSet.has(e.from) && memberSet.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, label: e.label }))
      .sort((a, b) => (a.from + a.to + a.label < b.from + b.to + b.label ? -1 : 1))
    const texts = members.map((id) => (opts.textOf ? opts.textOf(id) : id))
    reports.push({ community: c, members, edges, summary: opts.summarize({ members, texts, edges }) })
  }
  return reports
}
