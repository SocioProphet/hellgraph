/**
 * bm25 — lexical (keyword) retrieval: the third leg for TRI-hybrid retrieval (lexical + dense +
 * graph). Okapi BM25 over an in-memory inverted index — deterministic, dependency-free. Fuse its
 * ranking with vector (semantic) + graph (personalizedPageRank) ranks via reciprocalRankFusion.
 */
import type { Scored } from './retrieval.js'

const DEFAULT_K1 = 1.5
const DEFAULT_B = 0.75

/** Lowercase alphanumeric tokenizer (linear, no backtracking). */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export class BM25Index {
  private readonly df = new Map<string, number>() // term → # docs containing it
  private readonly postings = new Map<string, Map<string, number>>() // term → (docId → term-freq)
  private readonly docLen = new Map<string, number>() // docId → length in tokens
  private readonly docTf = new Map<string, Map<string, number>>() // docId → its term-freqs (for removal)
  private totalLen = 0

  constructor(private readonly k1 = DEFAULT_K1, private readonly b = DEFAULT_B) {}

  get size(): number { return this.docLen.size }

  /** Add (or, if the id exists, replace) a document. */
  add(id: string, text: string): void {
    if (this.docTf.has(id)) this.remove(id)
    const toks = tokenize(text)
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docLen.set(id, toks.length)
    this.docTf.set(id, tf)
    this.totalLen += toks.length
    for (const [t, c] of tf) {
      let p = this.postings.get(t)
      if (!p) { p = new Map(); this.postings.set(t, p) }
      p.set(id, c)
      this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
  }

  /** Remove a document; a no-op if absent. Keeps df / postings / length totals consistent. */
  remove(id: string): void {
    const tf = this.docTf.get(id)
    if (!tf) return
    this.totalLen -= this.docLen.get(id) ?? 0
    this.docLen.delete(id)
    this.docTf.delete(id)
    for (const t of tf.keys()) {
      const p = this.postings.get(t)
      if (p) { p.delete(id); if (p.size === 0) this.postings.delete(t) }
      const df = (this.df.get(t) ?? 1) - 1
      if (df <= 0) this.df.delete(t); else this.df.set(t, df)
    }
  }

  /** BM25-ranked docs for `query` (descending; id tie-break). */
  search(query: string, topK = 10): Scored[] {
    const N = this.docLen.size
    if (N === 0) return []
    const avgdl = this.totalLen / N || 1
    const scores = new Map<string, number>()
    for (const t of new Set(tokenize(query))) {
      const p = this.postings.get(t)
      if (!p) continue
      const df = this.df.get(t)!
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) // BM25+ non-negative idf
      for (const [id, tf] of p) {
        const dl = this.docLen.get(id)!
        const denom = tf + this.k1 * (1 - this.b + (this.b * dl) / avgdl)
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (this.k1 + 1)) / denom))
      }
    }
    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, Math.max(0, topK))
  }
}
