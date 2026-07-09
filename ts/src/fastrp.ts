/**
 * fastrp — FastRP structural node embeddings (Neo4j GDS parity). Embeds each node by its position
 * in the graph (not its text): sparse random projection + iterated neighbour averaging, combined
 * across hop distances. Structurally-similar nodes get similar vectors → feed them to the HNSW
 * index (ann.ts) for node-similarity / link-prediction, or as ML features. Deterministic (seeded).
 * Reference: Chen et al., "Fast and Accurate Network Embeddings via Very Sparse Random Projection".
 */
import type { HellGraphStore } from './store.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FastRpOptions {
  /** Embedding dimension (default 128). */
  dim?: number
  /** Per-hop weights; index 0 is the raw projection (self), 1.. are propagation hops.
   *  Default [0, 1, 1, 1] → sum of 1/2/3-hop structure. Its length sets the number of iterations. */
  weights?: number[]
  /** RNG seed for the (deterministic) sparse random projection. */
  seed?: number
}

/** Structural embedding per node id. */
export function fastRP(store: HellGraphStore, opts: FastRpOptions = {}): Map<string, number[]> {
  const dim = Math.max(1, Math.floor(opts.dim ?? 128))
  const weights = opts.weights && opts.weights.length > 0 ? opts.weights : [0, 1, 1, 1]
  const rng = mulberry32((opts.seed ?? 0x1234abcd) >>> 0)

  const nodes = store.allNodes().map((n) => n.id)
  const n = nodes.length
  const out = new Map<string, number[]>()
  if (n === 0) return out
  const idx = new Map(nodes.map((id, i) => [id, i]))

  // Undirected adjacency (structural similarity is symmetric).
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const e of store.allEdges()) {
    const u = idx.get(e.from), v = idx.get(e.to)
    if (u !== undefined && v !== undefined && u !== v) { adj[u]!.push(v); adj[v]!.push(u) }
  }

  // Very-sparse random projection: entries ±√s with prob 1/(2s) each, else 0 (s = 3).
  const s = 3, scale = Math.sqrt(s)
  const proj: number[][] = Array.from({ length: n }, () => {
    const row = new Array<number>(dim).fill(0)
    for (let d = 0; d < dim; d++) { const r = rng(); if (r < 0.5 / s) row[d] = scale; else if (r < 1 / s) row[d] = -scale }
    return row
  })

  const emb: number[][] = Array.from({ length: n }, () => new Array<number>(dim).fill(0))
  let cur = proj.map((r) => r.slice())
  const accumulate = (w: number): void => {
    if (w === 0) return
    for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) emb[i]![d]! += w * cur[i]![d]!
  }
  accumulate(weights[0] ?? 0)

  for (let step = 1; step < weights.length; step++) {
    const next: number[][] = Array.from({ length: n }, () => new Array<number>(dim).fill(0))
    for (let i = 0; i < n; i++) {
      const deg = adj[i]!.length
      if (deg === 0) continue
      const row = next[i]!
      for (const j of adj[i]!) { const src = cur[j]!; for (let d = 0; d < dim; d++) row[d]! += src[d]! }
      for (let d = 0; d < dim; d++) row[d]! /= deg
      let s2 = 0
      for (let d = 0; d < dim; d++) s2 += row[d]! * row[d]!
      const nn = Math.sqrt(s2)
      if (nn > 0) for (let d = 0; d < dim; d++) row[d]! /= nn
    }
    cur = next
    accumulate(weights[step] ?? 0)
  }

  for (let i = 0; i < n; i++) out.set(nodes[i]!, emb[i]!)
  return out
}
