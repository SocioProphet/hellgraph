/**
 * graph-analytics — deterministic graph analytics over a HellGraphStore (TS side of hg_analytics).
 *
 * PageRank (damping 0.85, dangling mass redistributed uniformly — matching the Rust hg_analytics
 * kernel), in/out degree centrality, and undirected connected components. Deterministic: same
 * graph → same result, no RNG, fixed iteration order — so it can ride the causally-merged view
 * and be exposed alongside the query surface.
 */

import type { HellGraphStore } from './store.js'

export interface PageRankOptions { damping?: number; iters?: number; tol?: number }

/** PageRank over the store's node/edge projection. Returns nodeId → score (sums to ~1). */
export function pageRank(store: HellGraphStore, opts: PageRankOptions = {}): Map<string, number> {
  const nodes = store.allNodes().map((n) => n.id)
  const n = nodes.length
  const out = new Map<string, number>()
  if (n === 0) return out
  const idx = new Map(nodes.map((id, i) => [id, i]))
  const outAdj: number[][] = Array.from({ length: n }, () => [])
  const outDeg = new Array<number>(n).fill(0)
  for (const e of store.allEdges()) {
    const u = idx.get(e.from), v = idx.get(e.to)
    if (u !== undefined && v !== undefined) { outAdj[u]!.push(v); outDeg[u]!++ }
  }
  const d = opts.damping ?? 0.85
  const maxIters = opts.iters ?? 100
  const tol = opts.tol ?? 1e-9
  let rank = new Array<number>(n).fill(1 / n)
  const base = (1 - d) / n
  for (let it = 0; it < maxIters; it++) {
    const next = new Array<number>(n).fill(base)
    let dangling = 0
    for (let u = 0; u < n; u++) if (outDeg[u] === 0) dangling += rank[u]!
    const danglingShare = (d * dangling) / n
    for (let u = 0; u < n; u++) {
      if (outDeg[u]! > 0) {
        const share = (d * rank[u]!) / outDeg[u]!
        for (const v of outAdj[u]!) next[v]! += share
      }
    }
    for (let v = 0; v < n; v++) next[v]! += danglingShare
    let diff = 0
    for (let v = 0; v < n; v++) diff += Math.abs(next[v]! - rank[v]!)
    rank = next
    if (diff < tol) break
  }
  for (let i = 0; i < n; i++) out.set(nodes[i]!, rank[i]!)
  return out
}

/** In/out degree per node. */
export function degreeCentrality(store: HellGraphStore): Map<string, { in: number; out: number }> {
  const deg = new Map<string, { in: number; out: number }>()
  for (const nn of store.allNodes()) deg.set(nn.id, { in: 0, out: 0 })
  for (const e of store.allEdges()) {
    const f = deg.get(e.from), t = deg.get(e.to)
    if (f) f.out++
    if (t) t.in++
  }
  return deg
}

/** Undirected connected components (union-find). Returns nodeId → component representative id. */
export function connectedComponents(store: HellGraphStore): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) { const nxt = parent.get(x)!; parent.set(x, r); x = nxt }
    return r
  }
  const union = (a: string, b: string): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const nn of store.allNodes()) parent.set(nn.id, nn.id)
  for (const e of store.allEdges()) if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to)
  const out = new Map<string, string>()
  for (const nn of store.allNodes()) out.set(nn.id, find(nn.id))
  return out
}

/** Top-k nodes by score, descending (ties broken by id for determinism). */
export function topK(scores: Map<string, number>, k: number): [string, number][] {
  return [...scores.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).slice(0, k)
}
