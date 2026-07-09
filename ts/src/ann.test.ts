import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HnswIndex } from './ann.js'

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function seededVecs(n: number, d: number, seed: number): { id: string; vec: number[] }[] {
  const r = prng(seed)
  return Array.from({ length: n }, (_, i) => ({ id: 'v' + i, vec: Array.from({ length: d }, () => r() - 0.5) }))
}
const cos = (a: number[], b: number[]): number => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na && nb ? d / Math.sqrt(na * nb) : 0
}
const bruteTop = (vecs: { id: string; vec: number[] }[], q: number[]): string =>
  vecs.map((v) => ({ id: v.id, s: cos(v.vec, q) })).sort((x, y) => y.s - x.s || (x.id < y.id ? -1 : 1))[0]!.id

test('HNSW: high recall@1 vs brute-force over 120 vectors', () => {
  const vecs = seededVecs(120, 24, 12345)
  const idx = new HnswIndex({ seed: 42, M: 16, efConstruction: 100, efSearch: 50 })
  for (const v of vecs) idx.add(v.id, v.vec)
  assert.equal(idx.size, 120)

  let hit = 0
  for (const v of vecs) {
    // exact-match query: the true nearest is the vector itself (cosine 1). HNSW must find it.
    if (idx.search(v.vec, 1)[0]!.id === bruteTop(vecs, v.vec)) hit++
  }
  const recall = hit / vecs.length
  assert.ok(recall >= 0.95, `recall@1 was ${recall.toFixed(3)}, expected >= 0.95`)
})

test('HNSW: recall@5 contains the brute-force nearest for perturbed queries', () => {
  const vecs = seededVecs(120, 24, 777)
  const idx = new HnswIndex({ seed: 7 })
  for (const v of vecs) idx.add(v.id, v.vec)
  const r = prng(999)
  let hit = 0
  const trials = 40
  for (let t = 0; t < trials; t++) {
    const base = vecs[Math.floor(r() * vecs.length)]!
    const q = base.vec.map((x) => x + (r() - 0.5) * 0.05) // small perturbation
    const truth = bruteTop(vecs, q)
    if (idx.search(q, 5).some((h) => h.id === truth)) hit++
  }
  assert.ok(hit / trials >= 0.9, `recall@5 ${(hit / trials).toFixed(3)} >= 0.9`)
})

test('HNSW: metadata-filtered search returns only accepted ids, recall preserved', () => {
  const vecs = seededVecs(100, 16, 555)
  const idx = new HnswIndex({ seed: 3, efSearch: 40 })
  for (const v of vecs) idx.add(v.id, v.vec)
  const even = new Set(vecs.filter((_, i) => i % 2 === 0).map((v) => v.id))
  const filter = (id: string): boolean => even.has(id)
  const evenVecs = vecs.filter((v) => even.has(v.id))

  let hit = 0
  const trials = 30
  for (let t = 0; t < trials; t++) {
    const q = vecs[t * 2 + 1]!.vec // an ODD vector's coords (not itself in the filtered set)
    const res = idx.search(q, 3, filter)
    assert.ok(res.every((r) => even.has(r.id)), 'ONLY accepted ids are returned')
    if (res[0]?.id === bruteTop(evenVecs, q)) hit++
  }
  assert.ok(hit / trials >= 0.8, `filtered recall@1 ${(hit / trials).toFixed(2)} >= 0.8`)
})

test('HNSW: exact match + edge cases', () => {
  const idx = new HnswIndex()
  assert.deepEqual(idx.search([1, 0, 0]), [], 'empty index → []')
  idx.add('a', [1, 0, 0]); idx.add('b', [0, 1, 0]); idx.add('c', [0, 0, 1])
  const top = idx.search([1, 0, 0], 1)[0]!
  assert.equal(top.id, 'a', 'identical vector tops')
  assert.ok(Math.abs(top.score - 1) < 1e-9, 'score = cosine = 1')
  assert.equal(idx.search([0.9, 0.1, 0], 1)[0]!.id, 'a', 'nearest by cosine')
  // updating a vector in place is honoured
  idx.add('a', [0, 0, 1])
  assert.equal(idx.size, 3, 're-add updates, not duplicates')
})
