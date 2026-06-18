import type { HellGraphStore } from './store'
import type { Binding, PropertyValue, SparqlResult, Triple } from './types'

export type { Binding, SparqlResult }

/**
 * A focused, correct SPARQL 1.1 subset evaluator over HellGraph's triple
 * projection. Supports: PREFIX, SELECT (vars | *), DISTINCT, basic graph
 * patterns (BGP) with variable/IRI/literal terms, FILTER (comparison, &&, ||,
 * regex, CONTAINS, BOUND), OPTIONAL (left join), ORDER BY (ASC/DESC),
 * LIMIT, OFFSET.
 *
 * Evaluation model matches the SPARQL algebra: BGP → join of triple-pattern
 * solutions; OPTIONAL → left-join; FILTER → solution restriction; then
 * DISTINCT / ORDER / OFFSET / LIMIT / projection.
 */

// ─── Term model ────────────────────────────────────────────────────────────────

type Term =
  | { kind: 'var'; name: string }
  | { kind: 'iri'; value: string }
  | { kind: 'literal'; value: PropertyValue }

interface TriplePattern { s: Term; p: Term; o: Term }

type FilterExpr =
  | { kind: 'compare'; op: '=' | '!=' | '<' | '>' | '<=' | '>='; left: ValueExpr; right: ValueExpr }
  | { kind: 'and'; left: FilterExpr; right: FilterExpr }
  | { kind: 'or'; left: FilterExpr; right: FilterExpr }
  | { kind: 'not'; expr: FilterExpr }
  | { kind: 'regex'; varExpr: ValueExpr; pattern: string; flags: string }
  | { kind: 'contains'; haystack: ValueExpr; needle: ValueExpr }
  | { kind: 'bound'; varName: string }

type ValueExpr =
  | { kind: 'var'; name: string }
  | { kind: 'const'; value: PropertyValue }

interface GroupGraphPattern {
  patterns: TriplePattern[]
  optionals: GroupGraphPattern[]
  filters: FilterExpr[]
}

interface SparqlQuery {
  prefixes: Record<string, string>
  distinct: boolean
  projection: string[] | '*'
  where: GroupGraphPattern
  orderBy: { var: string; desc: boolean }[]
  limit?: number
  offset?: number
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(query: string): string[] {
  const tokens: string[] = []
  const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<[^>]*>|\?[A-Za-z0-9_]+|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|<=|>=|!=|&&|\|\||[<>=]|[(){}.,;]|\S)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(query)) !== null) {
    if (m[1]?.trim()) tokens.push(m[1])
  }
  return tokens
}

// ─── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0
  private prefixes: Record<string, string> = {}
  constructor(private tokens: string[]) {}

  private peek(): string | undefined { return this.tokens[this.pos] }
  private next(): string { return this.tokens[this.pos++] }
  private expect(tok: string): void {
    const got = this.next()
    if (got?.toUpperCase() !== tok.toUpperCase()) throw new Error(`SPARQL parse error: expected '${tok}', got '${got}'`)
  }

  private parsePrefixes(): void {
    while (this.peek()?.toUpperCase() === 'PREFIX') {
      this.next()
      const prefix = this.next().replace(/:$/, '')
      const iri = this.next().replace(/^<|>$/g, '')
      this.prefixes[prefix] = iri
    }
  }

  parseConstruct(): { prefixes: Record<string, string>; template: TriplePattern[]; where: GroupGraphPattern } {
    this.parsePrefixes()
    this.expect('CONSTRUCT')
    this.expect('{')
    const template: TriplePattern[] = []
    while (this.peek() && this.peek() !== '}') {
      if (this.peek() === '.') { this.next(); continue }
      template.push(this.parseTriplePattern())
    }
    this.expect('}')
    this.expect('WHERE')
    const where = this.parseGroup()
    return { prefixes: this.prefixes, template, where }
  }

  parse(): SparqlQuery {
    this.parsePrefixes()
    this.expect('SELECT')
    let distinct = false
    if (this.peek()?.toUpperCase() === 'DISTINCT') { distinct = true; this.next() }

    let projection: string[] | '*'
    if (this.peek() === '*') { projection = '*'; this.next() }
    else {
      const vars: string[] = []
      while (this.peek()?.startsWith('?')) vars.push(this.next().slice(1))
      if (vars.length === 0) throw new Error('SPARQL parse error: SELECT requires variables or *')
      projection = vars
    }

    this.expect('WHERE')
    const where = this.parseGroup()

    const orderBy: { var: string; desc: boolean }[] = []
    let limit: number | undefined
    let offset: number | undefined

    while (this.peek()) {
      const kw = this.peek()!.toUpperCase()
      if (kw === 'ORDER') {
        this.next(); this.expect('BY')
        while (this.peek()?.startsWith('?') || this.peek()?.toUpperCase() === 'ASC' || this.peek()?.toUpperCase() === 'DESC') {
          let desc = false
          const d = this.peek()!.toUpperCase()
          if (d === 'ASC' || d === 'DESC') { desc = d === 'DESC'; this.next(); this.expect('(') }
          const v = this.next().slice(1)
          if (this.peek() === ')') this.next()
          orderBy.push({ var: v, desc })
        }
      } else if (kw === 'LIMIT') { this.next(); limit = parseInt(this.next(), 10) }
      else if (kw === 'OFFSET') { this.next(); offset = parseInt(this.next(), 10) }
      else break
    }

    return { prefixes: this.prefixes, distinct, projection, where, orderBy, limit, offset }
  }

  private parseGroup(): GroupGraphPattern {
    this.expect('{')
    const group: GroupGraphPattern = { patterns: [], optionals: [], filters: [] }
    while (this.peek() && this.peek() !== '}') {
      const kw = this.peek()!.toUpperCase()
      if (kw === 'OPTIONAL') { this.next(); group.optionals.push(this.parseGroup()) }
      else if (kw === 'FILTER') { this.next(); group.filters.push(this.parseFilter()) }
      else if (this.peek() === '.') { this.next() }
      else group.patterns.push(this.parseTriplePattern())
    }
    this.expect('}')
    return group
  }

  private parseTriplePattern(): TriplePattern {
    const s = this.parseTerm()
    const p = this.parseTerm()
    const o = this.parseTerm()
    if (this.peek() === '.') this.next()
    return { s, p, o }
  }

  private parseTerm(): Term {
    const tok = this.next()
    if (tok.startsWith('?')) return { kind: 'var', name: tok.slice(1) }
    if (tok.startsWith('<')) return { kind: 'iri', value: tok.replace(/^<|>$/g, '') }
    if (tok.startsWith('"') || tok.startsWith("'")) return { kind: 'literal', value: unquote(tok) }
    // prefixed name (prefix:local) or bareword keyword like rdf:type
    if (tok.includes(':')) {
      const [prefix, local] = tok.split(':')
      const base = this.prefixes[prefix]
      if (base) return { kind: 'iri', value: base + local }
      return { kind: 'iri', value: tok } // unresolved prefix — treat literally (e.g. rdf:type)
    }
    // numeric literal
    const num = Number(tok)
    if (!Number.isNaN(num)) return { kind: 'literal', value: num }
    return { kind: 'literal', value: tok }
  }

  private parseFilter(): FilterExpr {
    this.expect('(')
    const expr = this.parseFilterExpr()
    this.expect(')')
    return expr
  }

  private parseFilterExpr(): FilterExpr {
    let left = this.parseFilterTerm()
    while (this.peek() === '&&' || this.peek() === '||') {
      const op = this.next()
      const right = this.parseFilterTerm()
      left = op === '&&' ? { kind: 'and', left, right } : { kind: 'or', left, right }
    }
    return left
  }

  private parseFilterTerm(): FilterExpr {
    const tok = this.peek()
    if (tok === '(') { this.next(); const e = this.parseFilterExpr(); this.expect(')'); return e }
    const fn = tok?.toLowerCase()
    if (fn === 'regex') {
      this.next(); this.expect('(')
      const varExpr = this.parseValueExpr(); this.expect(',')
      const pattern = unquote(this.next())
      let flags = ''
      if (this.peek() === ',') { this.next(); flags = unquote(this.next()) }
      this.expect(')')
      return { kind: 'regex', varExpr, pattern, flags }
    }
    if (fn === 'contains') {
      this.next(); this.expect('(')
      const haystack = this.parseValueExpr(); this.expect(',')
      const needle = this.parseValueExpr(); this.expect(')')
      return { kind: 'contains', haystack, needle }
    }
    if (fn === 'bound') {
      this.next(); this.expect('('); const v = this.next().slice(1); this.expect(')')
      return { kind: 'bound', varName: v }
    }
    // comparison
    const left = this.parseValueExpr()
    const op = this.next() as '=' | '!=' | '<' | '>' | '<=' | '>='
    const right = this.parseValueExpr()
    return { kind: 'compare', op, left, right }
  }

  private parseValueExpr(): ValueExpr {
    const tok = this.next()
    if (tok.startsWith('?')) return { kind: 'var', name: tok.slice(1) }
    if (tok.startsWith('"') || tok.startsWith("'")) return { kind: 'const', value: unquote(tok) }
    const num = Number(tok)
    if (!Number.isNaN(num)) return { kind: 'const', value: num }
    if (tok.startsWith('<')) return { kind: 'const', value: tok.replace(/^<|>$/g, '') }
    return { kind: 'const', value: tok }
  }
}

function unquote(tok: string): string {
  return tok.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1')
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

function matchTriple(pattern: TriplePattern, triple: Triple, binding: Binding): Binding | null {
  const next: Binding = { ...binding }

  function unify(term: Term, value: PropertyValue): boolean {
    if (term.kind === 'var') {
      if (term.name in next) return looseEq(next[term.name], value)
      next[term.name] = value
      return true
    }
    if (term.kind === 'iri') return String(value) === term.value
    return looseEq(term.value, value)
  }

  if (!unify(pattern.s, triple.subject)) return null
  if (!unify(pattern.p, triple.predicate)) return null
  if (!unify(pattern.o, triple.object)) return null
  return next
}

function looseEq(a: PropertyValue, b: PropertyValue): boolean {
  if (a === b) return true
  return String(a) === String(b)
}

function evalBGP(patterns: TriplePattern[], triples: Triple[], seed: Binding[]): Binding[] {
  let solutions = seed
  for (const pattern of patterns) {
    const nextSolutions: Binding[] = []
    for (const sol of solutions) {
      for (const triple of triples) {
        const merged = matchTriple(pattern, triple, sol)
        if (merged) nextSolutions.push(merged)
      }
    }
    solutions = nextSolutions
    if (solutions.length === 0) break
  }
  return solutions
}

function evalGroup(group: GroupGraphPattern, triples: Triple[]): Binding[] {
  let solutions = evalBGP(group.patterns, triples, [{}])

  // OPTIONAL → left join
  for (const opt of group.optionals) {
    const next: Binding[] = []
    for (const sol of solutions) {
      const matches = evalGroup(opt, triples).filter((m) => compatible(sol, m))
      if (matches.length === 0) next.push(sol)
      else for (const m of matches) next.push({ ...sol, ...m })
    }
    solutions = next
  }

  // FILTER restriction
  for (const filter of group.filters) {
    solutions = solutions.filter((sol) => evalFilter(filter, sol))
  }

  return solutions
}

function compatible(a: Binding, b: Binding): boolean {
  for (const k of Object.keys(b)) {
    if (k in a && !looseEq(a[k], b[k])) return false
  }
  return true
}

function resolveValue(expr: ValueExpr, binding: Binding): PropertyValue {
  return expr.kind === 'var' ? (binding[expr.name] ?? null) : expr.value
}

function evalFilter(expr: FilterExpr, binding: Binding): boolean {
  switch (expr.kind) {
    case 'and': return evalFilter(expr.left, binding) && evalFilter(expr.right, binding)
    case 'or': return evalFilter(expr.left, binding) || evalFilter(expr.right, binding)
    case 'not': return !evalFilter(expr.expr, binding)
    case 'bound': return expr.varName in binding && binding[expr.varName] !== null
    case 'regex': {
      const v = resolveValue(expr.varExpr, binding)
      try { return new RegExp(expr.pattern, expr.flags).test(String(v ?? '')) } catch { return false }
    }
    case 'contains': {
      const h = String(resolveValue(expr.haystack, binding) ?? '')
      const n = String(resolveValue(expr.needle, binding) ?? '')
      return h.includes(n)
    }
    case 'compare': {
      const l = resolveValue(expr.left, binding)
      const r = resolveValue(expr.right, binding)
      return compareValues(expr.op, l, r)
    }
  }
}

function compareValues(op: string, l: PropertyValue, r: PropertyValue): boolean {
  const ln = typeof l === 'number' ? l : Number(l)
  const rn = typeof r === 'number' ? r : Number(r)
  const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && l !== '' && r !== ''
  switch (op) {
    case '=': return looseEq(l, r)
    case '!=': return !looseEq(l, r)
    case '<': return numeric ? ln < rn : String(l) < String(r)
    case '>': return numeric ? ln > rn : String(l) > String(r)
    case '<=': return numeric ? ln <= rn : String(l) <= String(r)
    case '>=': return numeric ? ln >= rn : String(l) >= String(r)
    default: return false
  }
}

function instantiateTerm(term: Term, sol: Binding): PropertyValue | null {
  if (term.kind === 'var') return term.name in sol ? (sol[term.name] ?? null) : null
  if (term.kind === 'iri') return term.value
  return term.value
}

export function runSparqlConstruct(store: HellGraphStore, queryText: string): Triple[] {
  const tokens = tokenize(queryText)
  const query = new Parser(tokens).parseConstruct()
  const triples = store.triples()
  const solutions = evalGroup(query.where, triples)
  const now = new Date().toISOString()
  const result: Triple[] = []
  for (const sol of solutions) {
    for (const pattern of query.template) {
      const s = instantiateTerm(pattern.s, sol)
      const p = instantiateTerm(pattern.p, sol)
      const o = instantiateTerm(pattern.o, sol)
      if (s === null || p === null || o === null) continue
      result.push({ subject: String(s), predicate: String(p), object: o, isIri: pattern.o.kind === 'iri', assertedAt: now })
    }
  }
  return result
}

export function runSparql(store: HellGraphStore, queryText: string): SparqlResult {
  const tokens = tokenize(queryText)
  const query = new Parser(tokens).parse()
  const triples = store.triples()

  let solutions = evalGroup(query.where, triples)

  // ORDER BY
  if (query.orderBy.length > 0) {
    solutions = [...solutions].sort((a, b) => {
      for (const { var: v, desc } of query.orderBy) {
        const av = a[v], bv = b[v]
        const an = Number(av), bn = Number(bv)
        const cmp = !Number.isNaN(an) && !Number.isNaN(bn)
          ? an - bn
          : String(av ?? '').localeCompare(String(bv ?? ''))
        if (cmp !== 0) return desc ? -cmp : cmp
      }
      return 0
    })
  }

  // Projection
  const variables = query.projection === '*'
    ? Array.from(new Set(solutions.flatMap((s) => Object.keys(s))))
    : query.projection

  let bindings = solutions.map((s) => {
    const row: Binding = {}
    for (const v of variables) row[v] = s[v] ?? null
    return row
  })

  // DISTINCT
  if (query.distinct) {
    const seen = new Set<string>()
    bindings = bindings.filter((b) => {
      const key = JSON.stringify(b)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // OFFSET / LIMIT
  if (query.offset) bindings = bindings.slice(query.offset)
  if (query.limit !== undefined) bindings = bindings.slice(0, query.limit)

  return { variables, bindings, evaluatedAtSeq: store.logicalClock }
}
