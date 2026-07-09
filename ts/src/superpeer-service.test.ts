import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSuperPeerFromEnv } from './superpeer-service.js'
import { HmacTokenVerifier } from './auth.js'

// Boot the super-peer exactly as the deployment does (env-driven), swarm off, and assert the
// public/authenticated surface the k8s manifest depends on. Regression guard: the entrypoint must
// wire a metrics registry (else /metrics 401s the Prometheus scrape) + auth.
test('startSuperPeerFromEnv: /livez + /metrics public, /health auth-gated (deploy contract)', async () => {
  const secret = 'test-superpeer-secret-0123456789'
  const env = {
    HELLGRAPH_AUTH_SECRET: secret,
    HELLGRAPH_HTTP_PORT: '0', // ephemeral port
    HELLGRAPH_JOIN_SWARM: '0',
    HELLGRAPH_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'hg-sp-')),
  }
  const sp = await startSuperPeerFromEnv(env)
  const base = `http://127.0.0.1:${sp.port}`
  const code = async (path: string, headers?: Record<string, string>): Promise<number> =>
    (await fetch(base + path, { headers })).status
  try {
    const token = HmacTokenVerifier.fromSecret(secret).mint({ id: 'ops', scopes: ['read', 'query', 'admit'] })

    assert.equal(await code('/livez'), 200, '/livez is public')
    assert.equal(await code('/metrics'), 200, '/metrics is public (registry wired) — else Prometheus 401s')
    assert.equal(await code('/health'), 401, '/health requires auth')
    assert.equal(await code('/health', { authorization: 'Bearer nope.sig' }), 401, 'invalid token rejected')
    assert.equal(await code('/health', { authorization: `Bearer ${token}` }), 200, 'valid minted token accepted')
  } finally {
    await sp.superPeer.close()
  }
})
