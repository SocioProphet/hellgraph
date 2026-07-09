/**
 * raptor — RAPTOR-style recursive hierarchical summarization tree (peer parity: RAPTOR).
 *
 * Leaf chunks are clustered by embedding similarity, each cluster is summarized into a parent node,
 * and the process recurses — so retrieval can pull both fine-grained leaves and high-level summaries
 * ("collapsed tree" retrieval). `embed` and `summarize` are INJECTED (the engine stays dependency-
 * free of any LLM; production passes semantic.embedText + an LLM summarizer; tests pass stubs).
 * Clustering is deterministic (greedy nearest-neighbour on a stable id order).
 */

export interface RaptorChunk { id: string; text: string }
export interface RaptorNode { id: string; text: string; level: number; vector: number[]; children: string[] }
export interface RaptorOptions {
  embed: (text: string) => number[]
  summarize: (texts: string[]) => string
  /** Target cluster size at each level (default 3). */
  branching?: number
  /** Max tree height (default 4). */
  maxLevels?: number
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < len; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

/** Deterministic greedy clustering: seed on the smallest-id unused node, pull its nearest unused
 *  neighbours up to `branching`, repeat. */
function clusterByCosine(nodes: RaptorNode[], branching: number): RaptorNode[][] {
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const used = new Set<string>()
  const clusters: RaptorNode[][] = []
  for (const seed of ordered) {
    if (used.has(seed.id)) continue
    used.add(seed.id)
    const cluster = [seed]
    const cands = ordered
      .filter((n) => !used.has(n.id))
      .map((n) => ({ n, sim: cosine(seed.vector, n.vector) }))
      .sort((a, b) => b.sim - a.sim || (a.n.id < b.n.id ? -1 : 1))
    for (const { n } of cands) {
      if (cluster.length >= branching) break
      used.add(n.id)
      cluster.push(n)
    }
    clusters.push(cluster)
  }
  return clusters
}

/** Build the full RAPTOR tree; returns ALL nodes across every level (leaves + summaries). */
export function buildRaptorTree(chunks: RaptorChunk[], opts: RaptorOptions): RaptorNode[] {
  const { embed, summarize } = opts
  const branching = Math.max(2, Math.floor(opts.branching ?? 3))
  const maxLevels = Math.max(1, Math.floor(opts.maxLevels ?? 4))
  const all: RaptorNode[] = []
  let current: RaptorNode[] = chunks.map((c) => ({ id: c.id, text: c.text, level: 0, vector: embed(c.text), children: [] }))
  all.push(...current)
  for (let level = 1; current.length > 1 && level <= maxLevels; level++) {
    const clusters = clusterByCosine(current, branching)
    if (clusters.length >= current.length) break // no reduction → stop (defensive)
    const parents = clusters.map((cluster, i) => {
      const text = summarize(cluster.map((n) => n.text))
      return { id: `L${level}#${i}`, text, level, vector: embed(text), children: cluster.map((n) => n.id) }
    })
    all.push(...parents)
    current = parents
  }
  return all
}

/** Collapsed-tree retrieval: rank ALL tree nodes (every level) by cosine to the query, top-K. */
export function raptorRetrieve(nodes: RaptorNode[], queryVector: number[], topK = 5): RaptorNode[] {
  return nodes
    .map((n) => ({ n, sim: cosine(queryVector, n.vector) }))
    .sort((a, b) => b.sim - a.sim || (a.n.id < b.n.id ? -1 : 1))
    .slice(0, Math.max(0, topK))
    .map((x) => x.n)
}
