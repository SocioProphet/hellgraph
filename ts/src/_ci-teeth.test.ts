// TEMPORARY — proves the new CI `npm test` step actually fails the build.
// Removed in the following commit; if you are reading this on a branch, it should not be here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('DELIBERATE FAILURE: proving ts-ci runs the suite', () => {
  assert.equal(1, 2, 'if CI is green with this present, the test step is not wired')
})
