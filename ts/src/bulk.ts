/**
 * bulk — CSV bulk import (Neo4j admin-import / Neptune bulk-loader parity). Parse node/edge CSVs
 * (RFC-4180-ish: quoted fields, embedded commas/quotes/newlines) and load them into a
 * HellGraphStore. Non-transactional fast path; wrap in store.transaction() for atomic loads.
 */
import type { HellGraphStore } from './store.js'
import type { PropertyValue } from './types.js'

/** Parse CSV text into headers + row objects. Handles quotes ("" escapes), commas, CRLF/LF. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let sawAny = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') { inQuotes = true; sawAny = true }
    else if (c === ',') { row.push(field); field = ''; sawAny = true }
    else if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; sawAny = false }
    else if (c === '\r') { /* skip */ }
    else { field += c; sawAny = true }
  }
  if (sawAny || field !== '' || row.length > 0) { row.push(field); records.push(row) }
  const headers = records.shift() ?? []
  const rows = records
    .filter((r) => r.length > 1 || (r[0] ?? '') !== '')
    .map((r) => {
      const o: Record<string, string> = {}
      headers.forEach((h, i) => { o[h] = r[i] ?? '' })
      return o
    })
  return { headers, rows }
}

/** Coerce a CSV string to number / boolean / string. */
function coerce(v: string): PropertyValue {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v)
  return v
}

export interface NodeCsvOptions {
  /** Column holding the node id (required). */
  id: string
  /** Static labels applied to every node. */
  labels?: string[]
  /** Column whose value is an additional per-row label. */
  labelColumn?: string
  /** Property columns to import (default: all columns except id + labelColumn). */
  propColumns?: string[]
}

export interface EdgeCsvOptions {
  from: string
  to: string
  /** Static edge label (used if labelColumn absent). */
  label?: string
  labelColumn?: string
  propColumns?: string[]
}

function propsFrom(row: Record<string, string>, cols: string[]): Record<string, PropertyValue> {
  const props: Record<string, PropertyValue> = {}
  for (const k of cols) { const v = row[k]; if (v !== undefined && v !== '') props[k] = coerce(v) }
  return props
}

/** Load nodes from CSV; returns the count added. */
export function loadNodesCsv(store: HellGraphStore, csv: string, opts: NodeCsvOptions): number {
  const { headers, rows } = parseCsv(csv)
  const propCols = opts.propColumns ?? headers.filter((h) => h !== opts.id && h !== opts.labelColumn)
  let count = 0
  for (const r of rows) {
    const id = r[opts.id]
    if (!id) continue
    const labels = [...(opts.labels ?? [])]
    if (opts.labelColumn && r[opts.labelColumn]) labels.push(r[opts.labelColumn]!)
    store.addNode(id, labels, propsFrom(r, propCols))
    count++
  }
  return count
}

/** Load edges from CSV; returns the count added. */
export function loadEdgesCsv(store: HellGraphStore, csv: string, opts: EdgeCsvOptions): number {
  const { headers, rows } = parseCsv(csv)
  const propCols = opts.propColumns ?? headers.filter((h) => h !== opts.from && h !== opts.to && h !== opts.labelColumn)
  let count = 0
  for (const r of rows) {
    const from = r[opts.from], to = r[opts.to]
    if (!from || !to) continue
    const label = (opts.labelColumn ? r[opts.labelColumn] : undefined) || opts.label
    if (!label) continue
    store.addEdge(label, from, to, propsFrom(r, propCols))
    count++
  }
  return count
}
