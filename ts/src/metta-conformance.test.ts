import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtomSpace, nodeHandle } from './atomspace.js'
import { runMetta } from './metta.js'
import { MettaRuleset, evalMetta, runMettaProgram } from './metta-eval.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(fs.readFileSync(path.join(here, 'metta-vectors.json'), 'utf-8')) as {
  eval: { label: string; rules: string[]; expr: string; expect: string }[]
  match: { label: string; nodes: string[]; links: [string, string, string][]; query: string; expectSorted: string[] }[]
  program: { label: string; nodes: string[]; links: [string, string, string][]; program: string; expectSorted: string[] }[]
}

function buildSpace(nodes: string[], links: [string, string, string][]): AtomSpace {
  const s = new AtomSpace('conformance', false)
  for (const name of nodes) s.addNode('ConceptNode', name)
  for (const [type, from, to] of links) {
    s.addLink(type, [nodeHandle('ConceptNode', from), nodeHandle('ConceptNode', to)])
  }
  return s
}

test('MeTTa eval conformance — reproduces the frozen vectors', () => {
  for (const v of vectors.eval) {
    assert.equal(evalMetta(v.expr, MettaRuleset.from(...v.rules)), v.expect, v.label)
  }
})

test('MeTTa match conformance — reproduces the frozen vectors', () => {
  for (const v of vectors.match) {
    const got = (runMetta(buildSpace(v.nodes, v.links), v.query) as string[]).slice().sort()
    assert.deepEqual(got, [...v.expectSorted].sort(), v.label)
  }
})

test('MeTTa program conformance — reproduces the frozen vectors', () => {
  for (const v of vectors.program) {
    const got = runMettaProgram(buildSpace(v.nodes, v.links), v.program).slice().sort()
    assert.deepEqual(got, [...v.expectSorted].sort(), v.label)
  }
})
