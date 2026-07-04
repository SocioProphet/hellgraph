import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HmacTokenVerifier, hasScope, bearer, type Principal } from './auth.js'
import { SuperPeer } from './super-peer.js'
import { InMemoryAuditLog } from './policy.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-auth-'))

async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

// ─── Token verifier ────────────────────────────────────────────────────────────────
test('HMAC tokens round-trip; tampered/foreign/expired tokens are rejected', () => {
  const v = HmacTokenVerifier.fromSecret('tenant-secret')
  const p: Principal = { id: 'u1', tenant: 't1', scopes: ['read', 'query'] }
  const token = v.mint(p)
  assert.deepEqual(v.verify(token), p)

  assert.equal(v.verify(token + 'x'), null, 'tampered signature rejected')
  assert.equal(HmacTokenVerifier.fromSecret('other').verify(token), null, 'foreign secret rejected')
  assert.equal(v.verify('garbage'), null, 'malformed rejected')

  const expired = v.mint({ id: 'u1', scopes: ['read'], exp: Date.now() - 1 })
  assert.equal(v.verify(expired), null, 'expired rejected')
})

test('bearer() extracts the token; hasScope() checks scopes', () => {
  assert.equal(bearer('Bearer abc.def'), 'abc.def')
  assert.equal(bearer('bearer abc.def'), 'abc.def')
  assert.equal(bearer(undefined), null)
  assert.equal(bearer('Basic xyz'), null)
  assert.ok(hasScope({ id: 'u', scopes: ['query'] }, 'query'))
  assert.ok(!hasScope({ id: 'u', scopes: ['read'] }, 'admit'))
})

// ─── End-to-end: the super-peer enforces auth on its HTTP surface ────────────────────
test('super-peer enforces bearer auth: 401 / 403 / 200, denials audited', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const v = HmacTokenVerifier.fromSecret('sp-secret')
  const audit = new InMemoryAuditLog()
  const sp = await SuperPeer.create(tmp(), { auth: v, audit })
  const port = await sp.listen(0)
  const base = `http://127.0.0.1:${port}`
  const q = { lang: 'gremlin', query: 'g.V().count()' }

  try {
    assert.equal(sp.authEnforced, true)

    // Public liveness works WITHOUT a token even when auth is enforced (k8s probes).
    const livez = await fetch(`${base}/livez`)
    assert.equal(livez.status, 200)

    // No token → 401.
    const noTok = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) })
    assert.equal(noTok.status, 401)

    // Valid token but wrong scope (read only, needs query) → 403.
    const readOnly = v.mint({ id: 'u', scopes: ['read'] })
    const forbidden = await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readOnly}` }, body: JSON.stringify(q),
    })
    assert.equal(forbidden.status, 403)

    // Right scope → 200.
    const querier = v.mint({ id: 'u', scopes: ['query'] })
    const ok = await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${querier}` }, body: JSON.stringify(q),
    })
    assert.equal(ok.status, 200)

    // /admit needs the 'admit' scope — a querier is forbidden.
    const admitAttempt = await fetch(`${base}/admit`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${querier}` },
      body: JSON.stringify({ writerKey: 'a'.repeat(64) }),
    })
    assert.equal(admitAttempt.status, 403)

    // Denials were audited to the evidence-spine sink.
    const denials = audit.entries().filter((e) => e.kind === 'blocked')
    assert.ok(denials.some((e) => e.reason === 'unauthenticated'))
    assert.ok(denials.some((e) => e.reason === 'forbidden:query' || e.reason === 'forbidden:admit'))
  } finally {
    await sp.close()
  }
})
