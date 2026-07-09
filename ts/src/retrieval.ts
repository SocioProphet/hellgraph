/**
 * retrieval — hybrid-retrieval fusion primitives (the layer modern RAG/GraphRAG/vector-DB peers
 * have and we lacked). Compose with semantic.semanticSearch (vector rank) and graph-analytics.
 * personalizedPageRank (graph rank) to get graph+vector hybrid retrieval:
 *
 *   const vec   = semanticSearch(q).map(r => r.id)                    // dense rank
 *   const graph = [...personalizedPageRank(store, queryEntities)]     // associative rank
 *                   .sort((a,b)=>b[1]-a[1]).map(([id])=>id)
 *   const fused = reciprocalRankFusion([vec, graph]).map(r => r.id)   // rank-fusion
 *   const final = mmrRerank(fused.map(id => ({ id, relevance, vector }))) // diversity rerank
 *
 * All pure + deterministic; defensively guarded (empty lists, zero/short vectors, NaN weights).
 */

export interface Scored { id: string; score: number }

/**
 * Reciprocal Rank Fusion — combine several ranked id lists into one, robust to incomparable score
 * scales (only ranks matter). score(id) = Σ 1 / (k + rank). Standard k = 60. Ties broken by id for
 * determinism. Duplicate ids within a single list count once (best/earliest rank).
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): Scored[] {
  const kk = Number.isFinite(k) && k > 0 ? k : 60
  const scores = new Map<string, number>()
  for (const list of rankings) {
    const seen = new Set<string>()
    list.forEach((id, i) => {
      if (seen.has(id)) return
      seen.add(id)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (kk + i + 1))
    })
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < len; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

export interface MmrCandidate { id: string; relevance: number; vector: number[] }

/**
 * Maximal Marginal Relevance rerank — trade query-relevance against diversity to cut redundant
 * near-duplicate results. `lambda` ∈ [0,1]: 1 = pure relevance, 0 = pure diversity (default 0.5).
 * Greedy selection; similarity is cosine over the candidate vectors. Returns the reranked id order
 * (up to `k`). Deterministic (id tie-break).
 */
export function mmrRerank(candidates: MmrCandidate[], opts: { lambda?: number; k?: number } = {}): string[] {
  const lambda = Math.min(1, Math.max(0, opts.lambda ?? 0.5))
  const pool = candidates.slice()
  const k = Math.min(opts.k ?? pool.length, pool.length)
  const selected: MmrCandidate[] = []
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!
      const rel = Number.isFinite(c.relevance) ? c.relevance : 0
      const maxSim = selected.length > 0 ? Math.max(...selected.map((s) => cosine(c.vector, s.vector))) : 0
      const score = lambda * rel - (1 - lambda) * maxSim
      if (score > bestScore || (score === bestScore && c.id < pool[bestIdx]!.id)) { bestScore = score; bestIdx = i }
    }
    selected.push(pool.splice(bestIdx, 1)[0]!)
  }
  return selected.map((c) => c.id)
}
