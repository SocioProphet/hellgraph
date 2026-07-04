import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { runMetta, matchBindings, parseSExpr, serialize } from './metta.js'

// Build a small typed metagraph: Dog/Cat/Whale are Mammals; Whale lives in Water.
function fixture(): AtomSpace {
  const s = new AtomSpace('test-metta', false)
  const mammal = s.addNode('ConceptNode', 'Mammal')
  const water = s.addNode('ConceptNode', 'Water')
  for (const name of ['Dog', 'Cat', 'Whale']) {
    const n = s.addNode('ConceptNode', name)
    s.addLink('InheritanceLink', [n.handle, mammal.handle])
  }
  const whale = s.getNode('ConceptNode', 'Whale')!
  s.addLink('EvaluationLink', [whale.handle, water.handle])
  return s
}

test('parse/serialize round-trips MeTTa S-expressions incl. $variables', () => {
  const t = '(InheritanceLink $x (ConceptNode Mammal))'
  assert.equal(serialize(parseSExpr(t)), t)
})

test('match binds a variable across all solutions', () => {
  const s = fixture()
  const results = runMetta(s, '(match &self (InheritanceLink $x (ConceptNode Mammal)) $x)')
  assert.deepEqual(results.sort(), ['Cat', 'Dog', 'Whale'], 'all three mammals bound to $x')
})

test('a grounded (non-variable) child filters the match', () => {
  const s = fixture()
  // Only Whale inherits Mammal AND has an EvaluationLink to Water.
  const inWater = runMetta(s, '(match &self (EvaluationLink $x (ConceptNode Water)) $x)')
  assert.deepEqual(inWater, ['Whale'])
})

test('template instantiation reshapes the output per binding', () => {
  const s = fixture()
  const out = runMetta(s, '(match &self (InheritanceLink $x (ConceptNode Mammal)) (is-a $x mammal))')
  assert.ok(out.includes('(is-a Dog mammal)'))
  assert.ok(out.includes('(is-a Whale mammal)'))
})

test('matchBindings returns programmatic var→value records', () => {
  const s = fixture()
  const binds = matchBindings(s, '(InheritanceLink $x (ConceptNode Mammal))')
  assert.equal(binds.length, 3)
  assert.deepEqual(binds.map((b) => b['x']).sort(), ['Cat', 'Dog', 'Whale'])
})

test('a pattern with no matches yields no solutions', () => {
  const s = fixture()
  assert.deepEqual(runMetta(s, '(match &self (InheritanceLink $x (ConceptNode Bird)) $x)'), [])
})
