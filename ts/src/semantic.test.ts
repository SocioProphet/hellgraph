import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  cosineSim, encodeVec, decodeVec, chunkText,
  putChunk, semanticSearch, importBrainShard, vectorChunkCount,
} from './semantic.js'

test('cosineSim: identical → 1, orthogonal → 0, anti-parallel → -1', () => {
  assert.ok(Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9)
  assert.ok(cosineSim([1, 0], [-1, 0]) < -0.99)
  assert.equal(cosineSim([0, 0], [1, 1]), 0) // zero vector → 0, no NaN
})

test('encodeVec/decodeVec round-trips at float32 precision', () => {
  const v = [0.1, -2.5, 3.14159, 0, 1000.25]
  const back = decodeVec(encodeVec(v))
  assert.equal(back.length, v.length)
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs((back[i] ?? 0) - (v[i] ?? 0)) < 1e-3)
})

test('chunkText splits long text into overlapping windows', () => {
  const chunks = chunkText('x'.repeat(4000), 1500, 200)
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((c) => c.length <= 1500))
})

test('putChunk + semanticSearch returns the nearest chunk (injected embedder, no Ollama)', async () => {
  // deterministic fake embedder — the EmbedFn injection makes search unit-testable
  const embed = async (t: string) => (t.includes('cat') ? [1, 0, 0] : t.includes('dog') ? [0, 1, 0] : [0, 0, 1])
  const doc = `urn:test:doc:${Date.now()}`
  putChunk({ docId: doc, idx: 0, text: 'a story about a cat', vec: await embed('cat'), filename: 'pets' })
  putChunk({ docId: doc, idx: 1, text: 'a story about a dog', vec: await embed('dog'), filename: 'pets' })
  const hits = await semanticSearch('cat', 1, embed)
  assert.ok(hits.length >= 1)
  assert.ok(hits[0]!.text.includes('cat'))
})

test('semanticSearch scope pins retrieval to a filename substring', async () => {
  const embed = async () => [1, 0, 0]
  const doc = `urn:test:scope:${Date.now()}`
  putChunk({ docId: doc, idx: 0, text: 'in-scope content', vec: [1, 0, 0], filename: 'report-alpha' })
  putChunk({ docId: doc, idx: 1, text: 'out-of-scope content', vec: [1, 0, 0], filename: 'report-beta' })
  const hits = await semanticSearch('anything', 5, embed, { scope: 'alpha' })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((h) => h.filename.includes('alpha')))
})

test('importBrainShard loads precomputed vectors and is idempotent', () => {
  const before = vectorChunkCount()
  const slug = `s-${Date.now()}-${Math.random().toString(36).slice(2)}` // unique → hermetic across runs (the store persists)
  const row = (i: number) => JSON.stringify({ slug, field: 'physics', material: 'lecture', file: 'doc', ci: i, text: `chunk ${i}`, vec: encodeVec([i, i + 1, i + 2]) })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-brain-'))
  const f = path.join(dir, 'shard.jsonl')
  fs.writeFileSync(f, [row(0), row(1), row(2)].join('\n') + '\n')

  const r1 = importBrainShard(f)
  assert.equal(r1.chunks, 3)
  assert.equal(vectorChunkCount(), before + 3)

  const r2 = importBrainShard(f) // re-import → every chunk already present
  assert.equal(r2.chunks, 0)
  assert.equal(r2.skipped, 3)
})
