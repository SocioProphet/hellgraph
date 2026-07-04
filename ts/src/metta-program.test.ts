import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { parseProgram, serialize } from './metta.js'
import { runMettaProgram } from './metta-eval.js'

function fixture(): AtomSpace {
  const s = new AtomSpace('test-metta-prog', false)
  const mammal = s.addNode('ConceptNode', 'Mammal')
  for (const name of ['Dog', 'Whale']) {
    const n = s.addNode('ConceptNode', name)
    s.addLink('InheritanceLink', [n.handle, mammal.handle])
  }
  return s
}

test('parseProgram reads multiple top-level forms', () => {
  const forms = parseProgram('(= (f $x) $x)  (match &self (A $y) $y)  (f 3)')
  assert.equal(forms.length, 3)
  assert.equal(serialize(forms[2]!), '(f 3)')
})

test('a program mixes rule defs, space queries, and evaluation', () => {
  const s = fixture()
  const program = `
    (= (double $x) (+ $x $x))
    (match &self (InheritanceLink $m (ConceptNode Mammal)) $m)
    (double 21)
  `
  const out = runMettaProgram(s, program)
  // match yields the two mammals (order-independent), then eval yields 42.
  assert.ok(out.includes('Dog') && out.includes('Whale'), 'space query results present')
  assert.ok(out.includes('42'), 'evaluation result present')
  assert.equal(out[out.length - 1], '42', 'eval form runs after the rule is in scope')
})

test('rules defined earlier in the program are in scope for later evals', () => {
  const s = fixture()
  const out = runMettaProgram(s, '(= (sq $x) (* $x $x)) (sq 9)')
  assert.deepEqual(out, ['81'])
})
