import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cutMeet, compactionFloor, compact, boundCut, bindProof, cutFromOrder, type OpId } from './causal-proof.js'

const op = (writer: string, seq: number): OpId => ({ writer, seq })

test('cutMeet is the componentwise minimum common frontier', () => {
  assert.deepEqual(cutMeet([{ a: 3, b: 1 }, { a: 1, b: 5 }]), { a: 1, b: 1 })
  // a writer absent from one reader → unobserved-in-common → 0
  assert.deepEqual(cutMeet([{ a: 3 }, { b: 2 }]), { a: 0, b: 0 })
  assert.deepEqual(cutMeet([]), {})
})

test('compactionFloor = settled across readers, capped below any pinned proof dependency', () => {
  const readers = [{ a: 3, b: 2 }, { a: 2, b: 5 }] // settled meet = {a:2, b:2}
  assert.deepEqual(compactionFloor(readers), { a: 2, b: 2 })
  // a proof pinned to (a,2) forbids compacting a at/above 2 → floor a drops to 1
  const proof = bindProof({ statement: 's', verdict: true, derivedAgainst: { a: 2 }, dependencyOps: [op('a', 2)] })
  assert.deepEqual(compactionFloor(readers, [proof]), { a: 1, b: 2 })
})

test('compact partitions the linearization into settled (snapshot) vs live (retained)', () => {
  const order = [op('a', 1), op('a', 2), op('a', 3), op('b', 1), op('b', 2)]
  const { settled, live } = compact(order, { a: 2, b: 1 })
  assert.deepEqual(settled.map((o) => `${o.writer}:${o.seq}`), ['a:1', 'a:2', 'b:1'])
  assert.deepEqual(live.map((o) => `${o.writer}:${o.seq}`), ['a:3', 'b:2'])
})

test('boundCut drops fully-settled writers so the vector stays bounded', () => {
  // c is a departed writer fully below the floor; b sits exactly at the floor → both drop.
  const cut = { a: 5, b: 2, c: 4 }
  const floor = { a: 2, b: 2, c: 4 }
  assert.deepEqual(boundCut(cut, floor), { a: 5 }, 'only writers with live delta survive')
})

test('end-to-end: settled prefix compacts, a pinned proof keeps its ops live', () => {
  const order = [op('a', 1), op('a', 2), op('a', 3), op('b', 1)]
  const readers = [cutFromOrder(order)] // one reader at the head
  // a proof pins (a,2): its op must remain re-checkable, so it is NOT compacted away.
  const proof = bindProof({ statement: 's', verdict: true, derivedAgainst: { a: 3, b: 1 }, dependencyOps: [op('a', 2)] })
  const floor = compactionFloor(readers, [proof])
  const { settled, live } = compact(order, floor)
  assert.ok(settled.every((o) => !(o.writer === 'a' && o.seq >= 2)), 'pinned op (a,2) and above are retained')
  assert.ok(live.some((o) => o.writer === 'a' && o.seq === 2), 'the pinned op is live')
})
