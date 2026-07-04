import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MettaRuleset, evalMetta } from './metta-eval.js'

const rs = new MettaRuleset()

test('comparison grounds to True/False', () => {
  assert.equal(evalMetta('(== 2 2)', rs), 'True')
  assert.equal(evalMetta('(== 2 3)', rs), 'False')
  assert.equal(evalMetta('(== foo foo)', rs), 'True') // structural equality over symbols
  assert.equal(evalMetta('(< 3 5)', rs), 'True')
  assert.equal(evalMetta('(>= 5 5)', rs), 'True')
})

test('if takes the branch selected by the condition (lazily)', () => {
  assert.equal(evalMetta('(if (< 3 5) yes no)', rs), 'yes')
  assert.equal(evalMetta('(if (== a b) x y)', rs), 'y')
})

test('recursive factorial via rules + if + comparison + arithmetic', () => {
  const fac = MettaRuleset.from('(= (fac $n) (if (== $n 0) 1 (* $n (fac (- $n 1)))))')
  assert.equal(evalMetta('(fac 0)', fac), '1')
  assert.equal(evalMetta('(fac 4)', fac), '24') // 4·3·2·1 — the untaken base case never diverges
  assert.equal(evalMetta('(fac 6)', fac), '720')
})

test('recursive sum-to-n terminates via the if base case', () => {
  const sum = MettaRuleset.from('(= (sum $n) (if (== $n 0) 0 (+ $n (sum (- $n 1)))))')
  assert.equal(evalMetta('(sum 5)', sum), '15') // 5+4+3+2+1
})
