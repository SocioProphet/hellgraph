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

/**
 * Betweenness centrality (Brandes' algorithm) over the directed, unweighted graph — the fraction
 * of shortest paths passing through each node. Deterministic (BFS in adjacency-insertion order).
 * O(V·E). Matches the Rust hg_analytics Brandes kernel.
 */
export function betweenness(store: HellGraphStore): Map<string, number> {
  const nodes = store.allNodes().map((n) => n.id)
  const out = new Map<string, number>(nodes.map((id) => [id, 0]))
  const adj = new Map<string, string[]>(nodes.map((id) => [id, []]))
  for (const e of store.allEdges()) if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from)!.push(e.to)

  for (const s of nodes) {
    const stack: string[] = []
    const pred = new Map<string, string[]>(nodes.map((id) => [id, []]))
    const sigma = new Map<string, number>(nodes.map((id) => [id, 0]))
    const dist = new Map<string, number>(nodes.map((id) => [id, -1]))
    sigma.set(s, 1); dist.set(s, 0)
    const queue: string[] = [s]
    while (queue.length) {
      const v = queue.shift()!
      stack.push(v)
      for (const w of adj.get(v)!) {
        if (dist.get(w)! < 0) { dist.set(w, dist.get(v)! + 1); queue.push(w) }
        if (dist.get(w) === dist.get(v)! + 1) { sigma.set(w, sigma.get(w)! + sigma.get(v)!); pred.get(w)!.push(v) }
      }
    }
    const delta = new Map<string, number>(nodes.map((id) => [id, 0]))
    while (stack.length) {
      const w = stack.pop()!
      for (const v of pred.get(w)!) delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!))
      if (w !== s) out.set(w, out.get(w)! + delta.get(w)!)
    }
  }
  return out
}

/**
 * Community detection — the Louvain local-moving phase (modularity optimization) over the
 * undirected weighting of the graph. Each node starts alone; nodes greedily move to the neighbor
 * community with the best modularity gain until stable. Deterministic (fixed node order). Returns
 * nodeId → community id. Matches the Rust hg_analytics Louvain kernel (first pass).
 */
export function louvain(store: HellGraphStore, maxPasses = 20): Map<string, string> {
  const nodes = store.allNodes().map((n) => n.id)
  const adj = new Map<string, Map<string, number>>(nodes.map((id) => [id, new Map()]))
  const bump = (a: string, b: string): void => { if (a === b) return; adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + 1) }
  for (const e of store.allEdges()) { if (!adj.has(e.from) || !adj.has(e.to)) continue; bump(e.from, e.to); bump(e.to, e.from) }
  const k = new Map<string, number>(nodes.map((id) => [id, [...adj.get(id)!.values()].reduce((a, b) => a + b, 0)]))
  let m2 = 0
  for (const id of nodes) m2 += k.get(id)! // = 2m
  const comm = new Map<string, string>(nodes.map((id) => [id, id]))
  const sumTot = new Map<string, number>(nodes.map((id) => [id, k.get(id)!]))
  if (m2 === 0) return comm

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false
    for (const i of nodes) {
      const ci = comm.get(i)!
      sumTot.set(ci, sumTot.get(ci)! - k.get(i)!) // remove i from its community
      // weight from i into each candidate community
      const kIn = new Map<string, number>()
      for (const [j, w] of adj.get(i)!) kIn.set(comm.get(j)!, (kIn.get(comm.get(j)!) ?? 0) + w)
      let best = ci, bestGain = (kIn.get(ci) ?? 0) - (sumTot.get(ci)! * k.get(i)!) / m2
      for (const [c, kin] of kIn) {
        const gain = kin - (sumTot.get(c)! * k.get(i)!) / m2
        if (gain > bestGain || (gain === bestGain && c < best)) { best = c; bestGain = gain }
      }
      comm.set(i, best)
      sumTot.set(best, sumTot.get(best)! + k.get(i)!)
      if (best !== ci) moved = true
    }
    if (!moved) break
  }
  return comm
}

// ─── Pathfinding (parity gap vs mainstream graph DBs: shortest path / Dijkstra) ──────
export interface PathOptions {
  /** Traverse edges in both directions (default: directed, following from→to). */
  undirected?: boolean
}
export interface WeightedPathOptions extends PathOptions {
  /** Edge property holding a non-negative numeric weight (default "weight"); missing/non-numeric → 1. */
  weightProp?: string
}

function buildAdjacency(store: HellGraphStore, undirected: boolean): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  const add = (a: string, b: string): void => { const l = adj.get(a) ?? []; l.push(b); adj.set(a, l) }
  for (const e of store.allEdges()) { add(e.from, e.to); if (undirected) add(e.to, e.from) }
  for (const l of adj.values()) l.sort() // deterministic neighbour order
  return adj
}

function reconstruct(prev: Map<string, string>, source: string, target: string): string[] {
  const path = [target]
  let cur = target
  while (cur !== source) { const p = prev.get(cur)!; path.push(p); cur = p }
  return path.reverse()
}

/** Unweighted shortest path (BFS) from `source` to `target`. Returns the inclusive node-id path,
 *  or null if either endpoint is absent or the target is unreachable. Deterministic: neighbours
 *  are expanded in ascending node-id order. */
export function shortestPath(store: HellGraphStore, source: string, target: string, opts: PathOptions = {}): string[] | null {
  if (!store.getNode(source) || !store.getNode(target)) return null
  if (source === target) return [source]
  const adj = buildAdjacency(store, opts.undirected ?? false)
  const prev = new Map<string, string>()
  const seen = new Set<string>([source])
  const queue = [source]
  while (queue.length) {
    const u = queue.shift()!
    for (const v of adj.get(u) ?? []) {
      if (seen.has(v)) continue
      seen.add(v); prev.set(v, u)
      if (v === target) return reconstruct(prev, source, target)
      queue.push(v)
    }
  }
  return null
}

/** Weighted shortest path (Dijkstra, non-negative weights). Returns `{ path, cost }` or null.
 *  O(V²) min-extraction (deterministic, id-tie-break) — consistent with this module's Brandes/
 *  Louvain scale. Throws on a negative edge weight (Dijkstra's invariant). */
export function shortestPathWeighted(store: HellGraphStore, source: string, target: string, opts: WeightedPathOptions = {}): { path: string[]; cost: number } | null {
  if (!store.getNode(source) || !store.getNode(target)) return null
  const wprop = opts.weightProp ?? 'weight'
  const undirected = opts.undirected ?? false
  const adj = new Map<string, { to: string; w: number }[]>()
  const add = (a: string, b: string, w: number): void => { const l = adj.get(a) ?? []; l.push({ to: b, w }); adj.set(a, l) }
  for (const e of store.allEdges()) {
    const raw = Number(e.properties[wprop])
    if (raw < 0) throw new Error(`shortestPathWeighted: negative edge weight ${raw} on ${e.from}->${e.to} (Dijkstra requires ≥ 0)`)
    const w = Number.isFinite(raw) && raw >= 0 ? raw : 1
    add(e.from, e.to, w); if (undirected) add(e.to, e.from, w)
  }
  const dist = new Map<string, number>([[source, 0]])
  const prev = new Map<string, string>()
  const done = new Set<string>()
  for (;;) {
    let u: string | undefined
    let best = Infinity
    for (const [node, dd] of dist) {
      if (done.has(node)) continue
      if (dd < best || (dd === best && (u === undefined || node < u))) { best = dd; u = node }
    }
    if (u === undefined) return null
    if (u === target) return { path: reconstruct(prev, source, target), cost: best }
    done.add(u)
    for (const { to, w } of adj.get(u) ?? []) {
      if (done.has(to)) continue
      const nd = best + w
      const cur = dist.get(to)
      if (cur === undefined || nd < cur) { dist.set(to, nd); prev.set(to, u) }
    }
  }
}
