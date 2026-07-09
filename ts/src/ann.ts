/**
 * ann — approximate nearest-neighbour vector index (HNSW). Peer parity with FAISS/HNSWlib/
 * Pinecone/Weaviate/Qdrant: turns semantic search from an O(n) brute-force scan into
 * near-logarithmic graph search. Cosine metric (vectors unit-normalized internally).
 *
 * Deterministic: the level-assignment RNG is seeded, so the same insertion order builds the same
 * graph — matching this engine's replayable-analytics ethos. Self-contained (no native dep).
 * Reference: Malkov & Yashunin, "Efficient and robust ANN search using HNSW" (2016).
 */
import type { Scored } from './retrieval.js'

/** Seeded PRNG (mulberry32) — deterministic level assignment. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Cand { id: string; d: number }
interface HnswNode { id: string; vec: number[]; level: number; neighbors: string[][] }

export interface HnswOptions {
  /** Max neighbours per node per layer (layer 0 uses 2·M). Default 16. */
  M?: number
  /** Candidate-list size during insertion. Default 64. */
  efConstruction?: number
  /** Candidate-list size during search (recall↑ with ef). Default 32. */
  efSearch?: number
  /** RNG seed for deterministic level assignment. */
  seed?: number
}

/** Insert into an ascending-by-distance array (id tie-break); small ef → linear insert is fine. */
function insertSorted(arr: Cand[], item: Cand): void {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const c = arr[mid]!
    if (c.d < item.d || (c.d === item.d && c.id < item.id)) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, item)
}

export class HnswIndex {
  private readonly nodes = new Map<string, HnswNode>()
  private entry: string | null = null
  private maxLevel = 0
  private readonly M: number
  private readonly Mmax0: number
  private readonly efC: number
  private readonly efS: number
  private readonly mL: number
  private readonly rng: () => number

  constructor(opts: HnswOptions = {}) {
    this.M = Math.max(2, Math.floor(opts.M ?? 16))
    this.Mmax0 = this.M * 2
    this.efC = Math.max(this.M, Math.floor(opts.efConstruction ?? 64))
    this.efS = Math.max(1, Math.floor(opts.efSearch ?? 32))
    this.mL = 1 / Math.log(this.M)
    this.rng = mulberry32((opts.seed ?? 0x9e3779b9) >>> 0)
  }

  get size(): number { return this.nodes.size }

  private static norm(v: number[]): number[] {
    let s = 0
    for (const x of v) s += x * x
    const n = Math.sqrt(s)
    return n > 0 ? v.map((x) => x / n) : v.slice()
  }

  /** Cosine distance on unit vectors = 1 − dot. */
  private dist(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length)
    let dot = 0
    for (let i = 0; i < len; i++) dot += a[i]! * b[i]!
    return 1 - dot
  }

  private searchLayer(q: number[], entryPoints: string[], ef: number, layer: number): Cand[] {
    const visited = new Set<string>(entryPoints)
    const candidates: Cand[] = []
    const results: Cand[] = []
    for (const id of entryPoints) {
      const c = { id, d: this.dist(q, this.nodes.get(id)!.vec) }
      insertSorted(candidates, c)
      insertSorted(results, c)
    }
    while (candidates.length > 0) {
      const c = candidates.shift()! // nearest unexpanded
      const furthest = results[results.length - 1]
      if (results.length >= ef && furthest && c.d > furthest.d) break
      const nbrs = this.nodes.get(c.id)!.neighbors[layer] ?? []
      for (const nid of nbrs) {
        if (visited.has(nid)) continue
        visited.add(nid)
        const d = this.dist(q, this.nodes.get(nid)!.vec)
        const worst = results[results.length - 1]
        if (results.length < ef || (worst && d < worst.d)) {
          const item = { id: nid, d }
          insertSorted(candidates, item)
          insertSorted(results, item)
          if (results.length > ef) results.pop()
        }
      }
    }
    return results
  }

  /** Add a vector under `id`. If the id exists, its vector is updated in place (the graph is not
   *  rebuilt — cheap; HNSW node deletion is intentionally not supported). */
  add(id: string, vector: number[]): void {
    const vec = HnswIndex.norm(vector)
    const existing = this.nodes.get(id)
    if (existing) { existing.vec = vec; return }

    const level = Math.floor(-Math.log(this.rng() || 1e-12) * this.mL)
    const node: HnswNode = { id, vec, level, neighbors: Array.from({ length: level + 1 }, () => []) }
    this.nodes.set(id, node)

    if (this.entry === null) { this.entry = id; this.maxLevel = level; return }

    let ep = [this.entry]
    for (let lc = this.maxLevel; lc > level; lc--) {
      const w = this.searchLayer(vec, ep, 1, lc)
      if (w[0]) ep = [w[0].id]
    }
    for (let lc = Math.min(this.maxLevel, level); lc >= 0; lc--) {
      const w = this.searchLayer(vec, ep, this.efC, lc)
      const neighbors = w.slice(0, this.M).map((x) => x.id)
      node.neighbors[lc] = neighbors
      const Mmax = lc === 0 ? this.Mmax0 : this.M
      for (const nid of neighbors) {
        const nn = this.nodes.get(nid)!
        const nl = nn.neighbors[lc] ?? (nn.neighbors[lc] = [])
        nl.push(id)
        if (nl.length > Mmax) {
          nn.neighbors[lc] = nl
            .map((x) => ({ id: x, d: this.dist(nn.vec, this.nodes.get(x)!.vec) }))
            .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
            .slice(0, Mmax)
            .map((x) => x.id)
        }
      }
      ep = w.map((x) => x.id)
    }
    if (level > this.maxLevel) { this.maxLevel = level; this.entry = id }
  }

  /** Approximate top-K nearest by cosine similarity (score = cosine, descending). */
  search(query: number[], topK = 10): Scored[] {
    if (this.entry === null) return []
    const q = HnswIndex.norm(query)
    let ep = [this.entry]
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const w = this.searchLayer(q, ep, 1, lc)
      if (w[0]) ep = [w[0].id]
    }
    const w = this.searchLayer(q, ep, Math.max(this.efS, topK), 0)
    return w.slice(0, Math.max(0, topK)).map((x) => ({ id: x.id, score: 1 - x.d }))
  }
}
