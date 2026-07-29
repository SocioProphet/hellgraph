import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifold, geodesicDistance, geodesicNearest, type ManifoldItem } from './semantic-geodesic'

const deg = (d: number): number => (d * Math.PI) / 180
const onCircle = (d: number): number[] => [Math.cos(deg(d)), Math.sin(deg(d))]
const chord = (a: number, b: number): number => 1 - Math.cos(deg(a - b))   // cosine distance of two circle points

// ─── The signature manifold fixture ───────────────────────────────────────────────
// 67 unit vectors along a near-closed circular arc: 0°, 5°, …, 330° (a 30° gap remains).
// Endpoints A = p00 (0°) and B = p66 (330°) are CLOSE in cosine — the chord across the gap is
// 1 − cos 30° ≈ 0.134 — but FAR along the manifold: every on-arc path is ~66 hops of 5°.
// With k = 3, each point's nearest neighbours are its arc-adjacent points (≤ 15° away,
// sim ≥ 0.966 > 0.866), so the chord shortcut NEVER becomes a kNN edge.
function arcFixture(): { m: ReturnType<typeof buildManifold>; A: string; B: string; M: string } {
  const items: ManifoldItem[] = []
  for (let i = 0; i <= 66; i++) items.push({ id: `p${String(i).padStart(2, '0')}`, vector: onCircle(5 * i) })
  return { m: buildManifold(items, 3), A: 'p00', B: 'p66', M: 'p33' }
}

test('signature case: endpoints close in cosine but far on the manifold — geodesic exceeds the chord', () => {
  const { m, A, B } = arcFixture()
  const geo = geodesicDistance(m, A, B)!
  const direct = chord(0, 330)                       // ≈ 0.134 — cosine says "adjacent"
  assert.ok(geo !== null)
  assert.ok(direct < 0.14, `chord ${direct} is small: cosine calls A,B near`)
  assert.ok(geo > 1.5 * direct, `geodesic ${geo} must dwarf the chord ${direct} — the shortcut is not on the manifold`)
  // The optimal on-manifold path is the 66-hop chain of 5° steps: 66 × (1 − cos 5°) ≈ 0.251.
  const expected = 66 * (1 - Math.cos(deg(5)))
  assert.ok(Math.abs(geo - expected) < 1e-9, `geodesic ${geo} ≈ arc sum ${expected}`)
})

test('signature case: geodesic ranks the on-manifold midpoint OVER the chord shortcut (cosine flips it)', () => {
  const { m, A, B, M } = arcFixture()
  const geoB = geodesicDistance(m, A, B)!
  const geoM = geodesicDistance(m, A, M)!
  // Cosine ordering: B (0.134) looks far NEARER than the mid-arc M (1.966).
  assert.ok(chord(0, 330) < chord(0, 165), 'cosine ranks B before M')
  // Manifold ordering: M is half the arc away, B the whole arc — geodesic ranks M before B.
  assert.ok(geoM < geoB, `geodesic ranks M (${geoM}) before B (${geoB})`)
})

test('geodesicNearest ordering differs from raw cosine on the arc fixture', () => {
  const { m, A, B, M } = arcFixture()
  const hits = geodesicNearest(m, onCircle(0), 67)   // query = A's own vector, keep every candidate
  assert.equal(hits[0]!.id, A, 'the query point itself ranks first at geodesic 0')
  assert.equal(hits[0]!.geodesic, 0)
  const at = (id: string) => hits.findIndex((h) => h.id === id)
  const hit = (id: string) => hits[at(id)]!
  assert.ok(hit(B).cosine < hit(M).cosine, 'raw cosine calls B nearer than M')
  assert.ok(at(M) < at(B), 'geodesic ranking puts M before B — the ordering flip')
})

test('adjacent points: geodesic equals their single-hop cosine distance', () => {
  const { m } = arcFixture()
  const geo = geodesicDistance(m, 'p00', 'p01')!
  assert.ok(Math.abs(geo - (1 - Math.cos(deg(5)))) < 1e-12)
})

test('same id → 0; unknown id → null', () => {
  const { m, A } = arcFixture()
  assert.equal(geodesicDistance(m, A, A), 0)
  assert.equal(geodesicDistance(m, A, 'nope'), null)
  assert.equal(geodesicDistance(m, 'nope', A), null)
})

test('disconnected components → null; geodesicNearest omits the unreachable island', () => {
  const items: ManifoldItem[] = [
    { id: 'a0', vector: onCircle(0) }, { id: 'a1', vector: onCircle(5) }, { id: 'a2', vector: onCircle(10) },
    { id: 'b0', vector: onCircle(180) }, { id: 'b1', vector: onCircle(185) }, { id: 'b2', vector: onCircle(190) },
  ]
  const m = buildManifold(items, 2)   // k=2 keeps each cluster internal — two components
  assert.equal(geodesicDistance(m, 'a0', 'b0'), null)
  assert.ok(geodesicDistance(m, 'a0', 'a2') !== null)
  const hits = geodesicNearest(m, onCircle(2), 10)
  assert.deepEqual(hits.map((h) => h.id).sort(), ['a0', 'a1', 'a2'], 'only the reachable cluster is ranked')
})

test('manifold adjacency is symmetric with matching weights', () => {
  const { m } = arcFixture()
  for (const [from, edges] of m.adj) {
    for (const e of edges) {
      const back = m.adj.get(e.to)!.find((x) => x.to === from)
      assert.ok(back, `edge ${from}→${e.to} has a reverse edge`)
      assert.equal(back.w, e.w, 'symmetrized weights match')
    }
  }
})

test('complete graph (k ≥ n−1): Dijkstra takes the cheaper 2-hop path over the direct chord', () => {
  const items: ManifoldItem[] = [0, 60, 120].map((d, i) => ({ id: `q${i}`, vector: onCircle(d) }))
  const m = buildManifold(items, 8)   // k larger than n−1 → all pairs linked, chord included
  // Direct edge q0–q2 costs 1 − cos 120° = 1.5; the 2-hop path via q1 costs 2 × (1 − cos 60°) = 1.0.
  // Cosine-distance weights are quadratic in angle, so many small hops undercut one big chord.
  assert.ok(Math.abs(geodesicDistance(m, 'q0', 'q2')! - 2 * (1 - Math.cos(deg(60)))) < 1e-12)
})
