/**
 * hybrid — the unified retrieval entrypoint that composes every leg into one call: lexical (BM25) ⊕
 * dense (HNSW/vector) ⊕ graph (personalized PageRank), fused with Reciprocal Rank Fusion and
 * optionally MMR-reranked. This is what turns the primitives (bm25/ann/graph-analytics/retrieval)
 * into a product — a single hybrid retriever like GraphRAG/HippoRAG/LlamaIndex expose. Each leg is
 * optional: pass only the parts you have. Pure/deterministic given deterministic parts.
 */
import type { HellGraphStore } from './store.js'
import type { BM25Index } from './bm25.js'
import type { HnswIndex } from './ann.js'
import { personalizedPageRank } from './graph-analytics.js'
import { reciprocalRankFusion, mmrRerank, type Scored } from './retrieval.js'

export interface HybridParts {
  /** Lexical index (bm25.BM25Index). */
  bm25?: BM25Index
  /** Dense vector index (ann.HnswIndex). */
  dense?: HnswIndex
  /** Graph store for personalized-PageRank associative retrieval. */
  store?: HellGraphStore
}

export interface HybridQuery {
  /** Query text → BM25 leg. */
  text?: string
  /** Query vector → dense leg (metadata `filter` optional, passed to HnswIndex.search). */
  vector?: number[]
  filter?: (id: string) => boolean
  /** Entity/seed node ids → graph (PPR) leg. */
  seeds?: string[]
  topK?: number
  /** RRF constant (default 60). */
  rrfK?: number
  /** Optional MMR rerank: relevance-vs-diversity over id vectors. */
  mmr?: { lambda: number; vectorOf: (id: string) => number[] }
}

/** Run the enabled legs, fuse with RRF, optionally MMR-rerank; returns fused top-K. */
export function hybridRetrieve(parts: HybridParts, query: HybridQuery): Scored[] {
  const topK = Math.max(1, query.topK ?? 10)
  const perLeg = topK * 3 // over-retrieve per leg so fusion has depth
  const rankings: string[][] = []

  if (parts.bm25 && query.text) rankings.push(parts.bm25.search(query.text, perLeg).map((r) => r.id))
  if (parts.dense && query.vector) rankings.push(parts.dense.search(query.vector, perLeg, query.filter).map((r) => r.id))
  if (parts.store && query.seeds && query.seeds.length > 0) {
    rankings.push(
      [...personalizedPageRank(parts.store, query.seeds)]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, perLeg)
        .map(([id]) => id),
    )
  }

  const fused = reciprocalRankFusion(rankings, query.rrfK)
  if (!query.mmr) return fused.slice(0, topK)

  // MMR rerank: relevance = fused rank position; diversity via caller-supplied vectors.
  const cands = fused.map((r, i) => ({ id: r.id, relevance: 1 / (i + 1), vector: query.mmr!.vectorOf(r.id) }))
  const order = mmrRerank(cands, { lambda: query.mmr.lambda, k: topK })
  return order.map((id, i) => ({ id, score: 1 / (i + 1) }))
}
