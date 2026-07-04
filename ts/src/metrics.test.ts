import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Metrics } from './metrics.js'
import { RateLimiter } from './rate-limit.js'

test('metrics render counters + gauges in Prometheus text format', () => {
  const m = new Metrics()
  m.register('hellgraph_requests_total', 'counter', 'total HTTP requests')
  m.inc('hellgraph_requests_total', { route: '/query' })
  m.inc('hellgraph_requests_total', { route: '/query' })
  m.inc('hellgraph_requests_total', { route: '/health' })
  m.set('hellgraph_writers', 3)

  const out = m.render()
  assert.match(out, /# HELP hellgraph_requests_total total HTTP requests/)
  assert.match(out, /# TYPE hellgraph_requests_total counter/)
  assert.match(out, /hellgraph_requests_total\{route="\/query"\} 2/)
  assert.match(out, /hellgraph_requests_total\{route="\/health"\} 1/)
  assert.match(out, /# TYPE hellgraph_writers gauge/)
  assert.match(out, /hellgraph_writers 3/)
})

test('label values are escaped', () => {
  const m = new Metrics()
  m.inc('x', { l: 'a"b\\c' })
  assert.match(m.render(), /x\{l="a\\"b\\\\c"\} 1/)
})

test('rate limiter: burst then deny, refills over time', () => {
  const rl = new RateLimiter(1, 2) // 1/sec, burst 2
  assert.equal(rl.allow('k', 0), true)
  assert.equal(rl.allow('k', 0), true)
  assert.equal(rl.allow('k', 0), false, 'burst exhausted')
  assert.equal(rl.allow('k', 1000), true, 'refilled 1 token after 1s')
  assert.equal(rl.allow('k', 1000), false)
  // distinct keys have independent buckets
  assert.equal(rl.allow('other', 0), true)
})

test('rate limiter rejects invalid config', () => {
  assert.throws(() => new RateLimiter(0, 5))
  assert.throws(() => new RateLimiter(5, 0))
})
