import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSuperPeerFromEnv, type SuperPeerServiceEnv } from './superpeer-service.js'
import { HmacTokenVerifier } from './auth.js'

const boot = (extra: SuperPeerServiceEnv = {}) =>
  startSuperPeerFromEnv({
    HELLGRAPH_HTTP_PORT: '0',
    HELLGRAPH_JOIN_SWARM: '0',
    HELLGRAPH_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'hg-sp6-')),
    ...extra,
  })

// ─── Attack 14: metric-label cardinality DoS via attacker-controlled path ──────────────────
test('SECURITY: request-metric label is bucketed — unknown paths cannot explode registry cardinality', async () => {
  const sp = await boot() // open mode: unknown paths reach 404 (still counted)
  const base = `http://127.0.0.1:${sp.port}`
  try {
    for (let i = 0; i < 5; i++) await fetch(`${base}/attacker-unique-path-${i}-${Math.random()}`)
    const metrics = await (await fetch(`${base}/metrics`)).text()
    assert.match(metrics, /route="other"/, 'unknown paths bucket to a single "other" label')
    assert.doesNotMatch(metrics, /attacker-unique-path/, 'raw attacker path never becomes a label value')
  } finally {
    await sp.superPeer.close()
  }
})

// ─── Attack 15: /cskg (expensive read ops) must be rate-limited like /query ────────────────
test('SECURITY: /cskg is rate-limited (not just /query and /admit)', async () => {
  const secret = 'sp6-cskg-secret-0123456789abcd'
  const sp = await boot({ HELLGRAPH_AUTH_SECRET: secret, HELLGRAPH_RATE_PER_SEC: '1', HELLGRAPH_RATE_BURST: '1' })
  const base = `http://127.0.0.1:${sp.port}`
  try {
    const token = HmacTokenVerifier.fromSecret(secret).mint({ id: 'ops', scopes: ['read', 'query', 'admit'] })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const codes: number[] = []
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/cskg`, { method: 'POST', headers, body: '{"op":"ScanEdges"}' })
      codes.push(r.status)
    }
    assert.ok(codes.includes(429), `a burst of /cskg must hit the 429 limiter — got ${codes.join(',')}`)
  } finally {
    await sp.superPeer.close()
  }
})

// ─── Attack 16: oversized request body must be rejected, not buffered into memory ──────────
test('SECURITY: oversized request body is rejected (not buffered / no hang)', async () => {
  const sp = await boot() // open mode so /query is reachable without a token
  const base = `http://127.0.0.1:${sp.port}`
  try {
    const big = 'x'.repeat(1_200_000) // > the 1MB cap
    let outcome = ''
    try {
      const r = await fetch(`${base}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"lang":"gremlin","query":"${big}"}`,
      })
      outcome = `status:${r.status}`
    } catch {
      outcome = 'neterr' // the server destroys the connection on overflow — also a valid rejection
    }
    // Either a >=400 error OR a connection reset is acceptable; a 200 or a hang is NOT.
    assert.ok(outcome === 'neterr' || /status:[45]\d\d/.test(outcome), `oversized body rejected — got ${outcome}`)
  } finally {
    await sp.superPeer.close()
  }
})
