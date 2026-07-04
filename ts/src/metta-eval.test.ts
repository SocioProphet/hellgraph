import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MettaRuleset, evalMetta } from './metta-eval.js'

test('grounded arithmetic reduces', () => {
  const rs = new MettaRuleset()
  assert.equal(evalMetta('(+ 2 3)', rs), '5')
  assert.equal(evalMetta('(* (+ 1 2) 4)', rs), '12')
})

test('equality rules rewrite; nested calls reduce eagerly', () => {
  const rs = MettaRuleset.from(
    '(= (double $x) (+ $x $x))',
    '(= (inc $x) (+ $x 1))',
  )
  assert.equal(evalMetta('(double 21)', rs), '42')
  assert.equal(evalMetta('(inc (double 4))', rs), '9') // (inc 8) → (+ 8 1)
})

test('symbolic (non-arithmetic) rewrite works', () => {
  const rs = MettaRuleset.from('(= (greet $x) (hello $x))')
  assert.equal(evalMetta('(greet world)', rs), '(hello world)')
})

test('an expression with no applicable rule is its own normal form', () => {
  const rs = MettaRuleset.from('(= (double $x) (+ $x $x))')
  assert.equal(evalMetta('(unknown a b)', rs), '(unknown a b)')
  assert.equal(evalMetta('foo', rs), 'foo')
})

test('non-terminating rewrite returns safely under the step budget (no hang)', () => {
  const rs = MettaRuleset.from('(= (loop) (loop))')
  // Should return within the budget rather than recurse forever.
  const out = evalMetta('(loop)', rs, 100)
  assert.equal(out, '(loop)')
})

test('recursive factorial via rules + arithmetic', () => {
  // if-style branching via two matching rules on a literal.
  const rs = MettaRuleset.from(
    '(= (fac 0) 1)',
    '(= (fac 1) 1)',
    '(= (fac 2) (* 2 (fac 1)))',
    '(= (fac 3) (* 3 (fac 2)))',
  )
  assert.equal(evalMetta('(fac 3)', rs), '6')
})
