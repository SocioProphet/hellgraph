/**
 * Guided exploration — the "consume" side of the KG platform (diagram 1's Guided Data Exploration).
 *
 * `exploreFrom(store, seeds)` answers "given where I am, what should I look at next?" by fusing two
 * graph-grounded signals over the seed set and sealing the result:
 *
 *   • personalized-pagerank — multi-hop relevance: a restart-biased random walk from the seeds
 *     (HippoRAG-style), so nodes the seeds reach — directly or through the graph — rank up.
 *   • seed-adjacency — 1-hop affinity: how many seeds a candidate is directly connected to.
 *
 * The two orderings are fused with Reciprocal-Rank Fusion (the platform's standard fusion), the seeds
 * themselves are excluded, and every result carries a `hash` over the ranked suggestions + the graph
 * snapshot they were computed against — an exploration step is a proof, not a hunch. Read-only.
 */
import { createHash } from 'node:crypto'
import type { HellGraphStore } from './store'
import { personalizedPageRank } from './graph-analytics'
import { reciprocalRankFusion } from './retrieval'

export interface ExplorationSuggestion {
  id: string
  labels: string[]
  /** Fused RRF score. */
  score: number
  /** 1-based rank in the fused ordering. */
  rank: number
}

export interface Exploration {
  seeds: string[]
  method: string
  snapshot: { nodes: number; edges: number }
  suggestions: ExplorationSuggestion[]
  /** sha256 over the ranked suggestions + snapshot (proof-carrying). */
  hash: string
}

export interface ExploreOptions {
  topK?: number
}

const METHOD = 'rrf(personalized-pagerank,seed-adjacency)'

function sealed(rec: Omit<Exploration, 'hash'>): Exploration {
  return { ...rec, hash: 'sha256:' + createHash('sha256').update(JSON.stringify(rec)).digest('hex') }
}

/** Rank the nodes most worth exploring next from `seeds`, as a proof-carrying exploration. */
export function exploreFrom(store: HellGraphStore, seeds: string[], opts: ExploreOptions = {}): Exploration {
  const topK = opts.topK ?? 10
  const snapshot = { nodes: store.allNodes().length, edges: store.edgeCount() }
  const seedSet = new Set(seeds)

  const ppr = personalizedPageRank(store, seeds)
  // Candidates: nodes with positive restart-relevance that aren't seeds themselves.
  const cands = [...ppr.entries()].filter(([id, s]) => !seedSet.has(id) && s > 0).map(([id]) => id)
  if (cands.length === 0) return sealed({ seeds, method: METHOD, snapshot, suggestions: [] })

  // Seed-adjacency: how many seeds each candidate is directly connected to (either direction).
  const seedAdj = new Map<string, number>()
  for (const c of cands) {
    let n = 0
    for (const nb of store.out(c)) if (seedSet.has(nb.id)) n++
    for (const nb of store.in(c)) if (seedSet.has(nb.id)) n++
    seedAdj.set(c, n)
  }

  const orderByPpr = [...cands].sort((a, b) => (ppr.get(b)! - ppr.get(a)!) || a.localeCompare(b))
  const orderByAdj = [...cands].sort((a, b) => (seedAdj.get(b)! - seedAdj.get(a)!) || a.localeCompare(b))
  const fused = reciprocalRankFusion([orderByPpr, orderByAdj])

  const suggestions: ExplorationSuggestion[] = fused.slice(0, topK).map((f, i) => {
    const node = store.getNode(f.id)
    return { id: f.id, labels: node?.labels ?? [], score: f.score, rank: i + 1 }
  })
  return sealed({ seeds, method: METHOD, snapshot, suggestions })
}
