import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SuperPeer } from './super-peer.js'
import { Metrics } from './metrics.js'
import { RateLimiter } from './rate-limit.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ops-'))
async function autobaseAvailable(): Promise<boolean> {
  try { await import('autobase'); await import('corestore'); return true } catch { return false }
}

test('super-peer exposes /metrics and rate-limits /query (429)', async (t) => {
  if (!(await autobaseAvailable())) return t.skip('autobase/corestore not installed')
  const metrics = new Metrics().register('hellgraph_requests_total', 'counter', 'requests')
  const rateLimit = new RateLimiter(1, 1) // 1/sec, burst 1 — second request is throttled
  const sp = await SuperPeer.create(tmp(), { metrics, rateLimit })
  const port = await sp.listen(0)
  const base = `http://127.0.0.1:${port}`
  const q = { lang: 'gremlin', query: 'g.V().count()' }
  const post = () => fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) })

  try {
    // /livez is always public; a request bumps the counter.
    assert.equal((await fetch(`${base}/livez`)).status, 200)

    // First query allowed, second throttled (burst 1).
    assert.equal((await post()).status, 200)
    assert.equal((await post()).status, 429, 'burst exhausted → 429')

    // /metrics is public and shows the recorded series.
    const mres = await fetch(`${base}/metrics`)
    assert.equal(mres.status, 200)
    const body = await mres.text()
    assert.match(body, /hellgraph_requests_total\{route="\/query"\}/)
    assert.match(body, /hellgraph_ratelimited_total\{route="\/query"\} 1/)
    assert.match(body, /hellgraph_queries_total\{lang="gremlin"\} 1/)
  } finally {
    await sp.close()
  }
})
