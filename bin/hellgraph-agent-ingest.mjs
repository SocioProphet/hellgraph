#!/usr/bin/env node
// Ingest an agent.v1 KnowledgeUpdate (from netwatch et al.) into the HellGraph
// AtomSpace. Reads JSON from a file arg or stdin. Usage:
//   hellgraph-agent-ingest system_graph.json
//   turtle-netwatch graph --json | hellgraph-agent-ingest -
import { readFileSync } from 'node:fs'
import { ingestKnowledgeUpdate } from '../ts/dist/index.mjs'

const arg = process.argv[2]
const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8')
const doc = JSON.parse(raw)
const res = ingestKnowledgeUpdate(doc)
console.log(JSON.stringify({ ingested: res }))
