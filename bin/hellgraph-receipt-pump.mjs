#!/usr/bin/env node
// hellgraph-receipt-pump — the auto-fire trigger's HellGraph half.
//
// Governance controls (the ADR swap gate + its local adr_watch) emit SEALED RECEIPTS per decision
// (sourceos.adr_watch.advisory.v1, and CI gate receipts). This pump tails that receipt stream and
// ingests each into the HellGraph AtomSpace as an agent.v1 KnowledgeUpdate — so root cause is a
// traversal over the graph, automatically, not a hand-invoked script.
//
// It runs as ONE long-lived process (the AtomSpace is a process singleton), which is exactly the
// always-on HellGraph service on the distro (see the source-os systemd unit). `--once` drains the
// current backlog; default `--watch` polls. Processed receipts are tracked by their sealed digest in
// a state file so nothing is ingested twice.
//
// Usage:
//   hellgraph-receipt-pump <receipts-dir> [--watch] [--interval-ms 2000] [--state <file>]
//   hellgraph-receipt-pump --selftest
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ingestKnowledgeUpdate } from '../ts/dist/index.mjs'

// A governance receipt -> agent.v1 KnowledgeUpdate. The ADR, the added files, and this receipt become
// nodes; each violation becomes an `violates` edge (added-file -> ADR).
export function receiptToKnowledgeUpdate(receipt) {
  const ts = receipt.decided_at || new Date().toISOString()
  const nodes = []
  const edges = []
  const adrIds = receipt.adrs || (receipt.adr ? [receipt.adr] : [])
  for (const adr of adrIds) nodes.push({ id: `adr:${adr}`, kind: 'ADR', attrs: {} })
  for (const path of receipt.added || []) {
    nodes.push({ id: `artifact:${path}`, kind: 'Artifact', attrs: { added: 'true' } })
  }
  if (receipt.receipt_digest) {
    nodes.push({
      id: `receipt:${receipt.receipt_digest}`, kind: 'GateReceipt',
      attrs: { surface: receipt.surface, disposition: receipt.disposition },
    })
  }
  for (const v of receipt.violations || []) {
    edges.push({ from: `artifact:${v.path}`, rel: 'violates', to: `adr:${v.adr}`, severity: 'block', ts })
  }
  return {
    schema: 'agent.v1.KnowledgeUpdate', graph: 'SYSTEM', ts,
    patch: { nodes, edges },
    prov: { producer: 'hellgraph-receipt-pump', surface: receipt.surface, digest: receipt.receipt_digest },
  }
}

function loadState(stateFile) {
  try { return new Set(JSON.parse(readFileSync(stateFile, 'utf8')).ingested) } catch { return new Set() }
}
function saveState(stateFile, seen) {
  writeFileSync(stateFile, JSON.stringify({ ingested: [...seen] }, null, 2))
}

export function pumpOnce(receiptsDir, stateFile) {
  const seen = loadState(stateFile)
  let processed = 0, nodes = 0, edges = 0
  for (const f of readdirSync(receiptsDir).filter((x) => x.endsWith('.json') && x !== '.pumped.json').sort()) {
    let receipt
    try { receipt = JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')) } catch { continue }
    const key = receipt.receipt_digest || f
    if (seen.has(key)) continue
    const res = ingestKnowledgeUpdate(receiptToKnowledgeUpdate(receipt))
    processed += 1; nodes += res.nodes; edges += res.edges; seen.add(key)
  }
  saveState(stateFile, seen)
  return { processed, nodes, edges }
}

async function pumpWatch(receiptsDir, stateFile, intervalMs) {
  process.stdout.write(`hellgraph-receipt-pump: watching ${receiptsDir} (every ${intervalMs}ms)\n`)
  for (;;) {
    const r = pumpOnce(receiptsDir, stateFile)
    if (r.processed) process.stdout.write(`  +${r.processed} receipt(s) → ${r.nodes} nodes / ${r.edges} edges\n`)
    await new Promise((res) => setTimeout(res, intervalMs))
  }
}

function selftest() {
  const receipt = {
    surface: 'sourceos.adr_watch.advisory.v1', decided_at: '2026-08-04T00:00:00Z',
    added: ['packages/new.nix'], adrs: ['ADR-0001-nix-to-guix'],
    violations: [{ path: 'packages/new.nix', adr: 'ADR-0001-nix-to-guix' }],
    disposition: 'advisory-warn', receipt_digest: 'sha256:abc',
  }
  const ku = receiptToKnowledgeUpdate(receipt)
  const okShape = ku.schema === 'agent.v1.KnowledgeUpdate' && ku.patch && Array.isArray(ku.patch.nodes)
  const hasViolates = ku.patch.edges.some((e) => e.rel === 'violates' && e.to === 'adr:ADR-0001-nix-to-guix')
  const hasReceiptNode = ku.patch.nodes.some((n) => n.kind === 'GateReceipt')
  const ok = okShape && hasViolates && hasReceiptNode && ku.patch.nodes.length === 3
  process.stdout.write(`selftest: ${ok ? 'PASS' : 'FAIL'} (nodes=${ku.patch.nodes.length}, violates=${hasViolates})\n`)
  return ok ? 0 : 1
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) process.exit(selftest())
  const dir = args.find((a) => !a.startsWith('--'))
  if (!dir) { process.stderr.write('usage: hellgraph-receipt-pump <receipts-dir> [--watch] [--interval-ms N] [--state F]\n'); process.exit(2) }
  const stateFile = args.includes('--state') ? args[args.indexOf('--state') + 1] : join(dir, '.pumped.json')
  if (args.includes('--watch')) {
    const iv = args.includes('--interval-ms') ? Number(args[args.indexOf('--interval-ms') + 1]) : 2000
    await pumpWatch(dir, stateFile, iv)
  } else {
    const r = pumpOnce(dir, stateFile)
    process.stdout.write(JSON.stringify({ pumped: r }) + '\n')
  }
}
