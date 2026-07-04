/**
 * metrics — a tiny, dependency-free Prometheus-exposition registry (Sprint 1 observability).
 *
 * Counters + gauges with labels, rendered in Prometheus text format for a /metrics endpoint.
 * Intentionally minimal (no histograms/summaries) — enough to see request rate, query mix,
 * errors, denials, and replication depth without pulling a metrics library into the bundle.
 */

type Labels = Record<string, string>
type Kind = 'counter' | 'gauge'

function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name
  const inner = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')
  return `${name}{${inner}}`
}

export class Metrics {
  private readonly values = new Map<string, number>()
  private readonly kinds = new Map<string, Kind>() // base name → kind
  private readonly help = new Map<string, string>()

  /** Declare a metric's kind + help once (optional; inc/set auto-register as counter/gauge). */
  register(name: string, kind: Kind, help: string): this {
    this.kinds.set(name, kind)
    this.help.set(name, help)
    return this
  }

  inc(name: string, labels?: Labels, by = 1): void {
    if (!this.kinds.has(name)) this.kinds.set(name, 'counter')
    const k = seriesKey(name, labels)
    this.values.set(k, (this.values.get(k) ?? 0) + by)
  }

  set(name: string, value: number, labels?: Labels): void {
    if (!this.kinds.has(name)) this.kinds.set(name, 'gauge')
    this.values.set(seriesKey(name, labels), value)
  }

  /** Render Prometheus text exposition format. */
  render(): string {
    const byBase = new Map<string, string[]>()
    for (const [series, val] of this.values) {
      const base = series.includes('{') ? series.slice(0, series.indexOf('{')) : series
      if (!byBase.has(base)) byBase.set(base, [])
      byBase.get(base)!.push(`${series} ${val}`)
    }
    const out: string[] = []
    for (const [base, lines] of byBase) {
      const help = this.help.get(base)
      if (help) out.push(`# HELP ${base} ${help}`)
      out.push(`# TYPE ${base} ${this.kinds.get(base) ?? 'counter'}`)
      out.push(...lines.sort())
    }
    return out.join('\n') + '\n'
  }
}
