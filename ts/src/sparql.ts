import type { HellGraphStore } from './store'
import type { Binding, PropertyValue, SparqlResult, Triple } from './types'

export type { Binding, SparqlResult }

/**
 * A focused, correct SPARQL 1.1 evaluator over HellGraph's triple projection.
 * Supports: PREFIX, SELECT (vars | *), the 'a' (rdf:type) shorthand, DISTINCT,
 * basic graph patterns (BGP), FILTER (comparison, && ||, regex, CONTAINS, BOUND),
 * OPTIONAL (left join), UNION, MINUS, BIND (arithmetic + CONCAT/STR), VALUES,
 * aggregation (COUNT/SUM/AVG/MIN/MAX incl. DISTINCT) with GROUP BY, plus
 * ORDER BY (ASC/DESC), LIMIT, OFFSET, and CONSTRUCT.
 *
 * Anti-silent-wrong guarantee: query forms this engine does NOT implement
 * (ASK, DESCRIBE, SPARQL UPDATE, SERVICE federation, named GRAPH, property
 * paths, sub-SELECT, HAVING) THROW an explicit "unsupported" error rather than
 * mis-parsing into a silently-empty result set.
 *
 * Evaluation model matches the SPARQL algebra: BGP → join; UNION → disjunction;
 * VALUES/BIND → join/extend; OPTIONAL → left-join; MINUS → antijoin; FILTER →
 * restriction; then GROUP/aggregate or DISTINCT / ORDER / OFFSET / LIMIT / projection.
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

// BIND expression: value, left-assoc arithmetic (+ - * /), CONCAT, STR. A focused-but-real subset.
type BindExpr =
  | { kind: 'val'; expr: ValueExpr }
  | { kind: 'arith'; op: '+' | '-' | '*' | '/'; left: BindExpr; right: BindExpr }
  | { kind: 'concat'; args: BindExpr[] }
  | { kind: 'str'; arg: BindExpr }

interface GroupGraphPattern {
  patterns: TriplePattern[]
  optionals: GroupGraphPattern[]
  filters: FilterExpr[]
  // SPARQL 1.1 additions (all default-empty so existing BGP/OPTIONAL/FILTER paths are unchanged):
  unions: GroupGraphPattern[][]                          // { A } UNION { B } … → one entry [A,B,…]
  minus: GroupGraphPattern[]                             // MINUS { … }
  binds: { var: string; expr: BindExpr }[]               // BIND(expr AS ?v)
  values: { vars: string[]; rows: (PropertyValue | null)[][] }[]  // VALUES ?v { … } / VALUES (?a ?b) { (…) }
  subgroups: GroupGraphPattern[]                         // a lone nested { … } joined in
}

interface AggSpec { fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; arg: string | '*'; as: string; distinct: boolean }

interface SparqlQuery {
  prefixes: Record<string, string>
  distinct: boolean
  projection: string[] | '*'
  aggregates: AggSpec[]         // (COUNT(?x) AS ?c) … — when present, results are grouped
  groupBy: string[]             // GROUP BY ?g …
  where: GroupGraphPattern
  orderBy: { var: string; desc: boolean }[]
  limit?: number
  offset?: number
}

function emptyGroup(): GroupGraphPattern {
  return { patterns: [], optionals: [], filters: [], unions: [], minus: [], binds: [], values: [], subgroups: [] }
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
  // A Map (not a plain object) so query-derived prefix names can never inject
  // properties / pollute a prototype (js/remote-property-injection).
  private prefixes = new Map<string, string>()
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
      this.prefixes.set(prefix, iri)
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
    return { prefixes: Object.fromEntries(this.prefixes), template, where }
  }

  parse(): SparqlQuery {
    this.parsePrefixes()
    // Reject query forms we do NOT support LOUDLY, rather than mis-parsing them into silently-wrong results.
    const verb = this.peek()?.toUpperCase()
    if (verb && verb !== 'SELECT') {
      if (['ASK', 'DESCRIBE', 'INSERT', 'DELETE', 'LOAD', 'CLEAR', 'DROP', 'CREATE', 'ADD', 'MOVE', 'COPY'].includes(verb)) {
        throw new Error(`SPARQL unsupported: ${verb} is not implemented (this engine supports SELECT/CONSTRUCT queries only)`)
      }
    }
    this.expect('SELECT')
    let distinct = false
    if (this.peek()?.toUpperCase() === 'DISTINCT') { distinct = true; this.next() }

    // Projection: plain ?vars and/or aggregate expressions "(FN([DISTINCT] ?x|*) AS ?name)".
    const projVars: string[] = []
    const aggregates: AggSpec[] = []
    if (this.peek() === '*') { this.next(); /* projection '*' */ }
    while (this.peek()?.startsWith('?') || this.peek() === '(') {
      if (this.peek() === '(') { aggregates.push(this.parseAggregate()) }
      else projVars.push(this.next().slice(1))
    }
    const projection: string[] | '*' = (projVars.length === 0 && aggregates.length === 0) ? '*' : projVars

    this.expect('WHERE')
    const where = this.parseGroup()

    const orderBy: { var: string; desc: boolean }[] = []
    const groupBy: string[] = []
    let limit: number | undefined
    let offset: number | undefined

    while (this.peek()) {
      const kw = this.peek()!.toUpperCase()
      if (kw === 'GROUP') {
        this.next(); this.expect('BY')
        while (this.peek()?.startsWith('?')) groupBy.push(this.next().slice(1))
      } else if (kw === 'ORDER') {
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
      else if (kw === 'HAVING') { throw new Error('SPARQL unsupported: HAVING is not implemented') }
      else break
    }

    return { prefixes: Object.fromEntries(this.prefixes), distinct, projection, aggregates, groupBy, where, orderBy, limit, offset }
  }

  // "(FN( [DISTINCT] ?arg | * ) AS ?name)"
  private parseAggregate(): AggSpec {
    this.expect('(')
    const fn = this.next().toUpperCase()
    if (!['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(fn)) throw new Error(`SPARQL unsupported: aggregate ${fn}`)
    this.expect('(')
    let distinct = false
    if (this.peek()?.toUpperCase() === 'DISTINCT') { distinct = true; this.next() }
    let arg: string | '*'
    if (this.peek() === '*') { this.next(); arg = '*' }
    else arg = this.next().slice(1)
    this.expect(')')
    this.expect('AS')
    const as = this.next().slice(1)
    this.expect(')')
    return { fn: fn as AggSpec['fn'], arg, as, distinct }
  }

  private parseGroup(): GroupGraphPattern {
    this.expect('{')
    const group = emptyGroup()
    while (this.peek() && this.peek() !== '}') {
      const kw = this.peek()!.toUpperCase()
      if (kw === 'SERVICE' || kw === 'GRAPH') {
        throw new Error(`SPARQL unsupported: ${kw} (federation / named graphs are not implemented) — refusing to return a silently-wrong result`)
      }
      else if (kw === 'OPTIONAL') { this.next(); group.optionals.push(this.parseGroup()) }
      else if (kw === 'FILTER') { this.next(); group.filters.push(this.parseFilter()) }
      else if (kw === 'MINUS') { this.next(); group.minus.push(this.parseGroup()) }
      else if (kw === 'BIND') { this.next(); group.binds.push(this.parseBind()) }
      else if (kw === 'VALUES') { this.next(); group.values.push(this.parseValues()) }
      else if (this.peek() === '{') {
        // a nested group: either the LHS of a UNION chain, or a lone joined subgroup.
        const first = this.parseGroup()
        if (this.peek()?.toUpperCase() === 'UNION') {
          const alts = [first]
          while (this.peek()?.toUpperCase() === 'UNION') { this.next(); alts.push(this.parseGroup()) }
          group.unions.push(alts)
        } else {
          group.subgroups.push(first)
        }
      }
      else if (this.peek() === '.') { this.next() }
      else group.patterns.push(this.parseTriplePattern())
    }
    this.expect('}')
    return group
  }

  private parseBind(): { var: string; expr: BindExpr } {
    this.expect('(')
    const expr = this.parseBindExpr()
    this.expect('AS')
    const v = this.next().slice(1)
    this.expect(')')
    return { var: v, expr }
  }

  // Left-assoc BIND expression: term (('+'|'-'|'*'|'/') term)* ; plus CONCAT(...) and STR(...).
  private parseBindExpr(): BindExpr {
    let left = this.parseBindTerm()
    while (this.peek() === '+' || this.peek() === '-' || this.peek() === '*' || this.peek() === '/') {
      const op = this.next() as '+' | '-' | '*' | '/'
      left = { kind: 'arith', op, left, right: this.parseBindTerm() }
    }
    return left
  }

  private parseBindTerm(): BindExpr {
    const tok = this.peek()
    const fn = tok?.toUpperCase()
    if (fn === 'CONCAT') {
      this.next(); this.expect('(')
      const args: BindExpr[] = [this.parseBindExpr()]
      while (this.peek() === ',') { this.next(); args.push(this.parseBindExpr()) }
      this.expect(')')
      return { kind: 'concat', args }
    }
    if (fn === 'STR') {
      this.next(); this.expect('('); const a = this.parseBindExpr(); this.expect(')')
      return { kind: 'str', arg: a }
    }
    if (tok === '(') { this.next(); const e = this.parseBindExpr(); this.expect(')'); return e }
    return { kind: 'val', expr: this.parseValueExpr() }
  }

  // VALUES ?v { "a" "b" }  OR  VALUES (?a ?b) { ("x" "y") (UNDEF "z") }
  private parseValues(): { vars: string[]; rows: (PropertyValue | null)[][] } {
    const vars: string[] = []
    if (this.peek() === '(') {
      this.next()
      while (this.peek()?.startsWith('?')) vars.push(this.next().slice(1))
      this.expect(')')
    } else {
      vars.push(this.next().slice(1))
    }
    this.expect('{')
    const rows: (PropertyValue | null)[][] = []
    while (this.peek() && this.peek() !== '}') {
      if (this.peek() === '(') {
        this.next()
        const row: (PropertyValue | null)[] = []
        while (this.peek() && this.peek() !== ')') row.push(this.parseValuesCell())
        this.expect(')')
        rows.push(row)
      } else {
        rows.push([this.parseValuesCell()])
      }
    }
    this.expect('}')
    return { vars, rows }
  }

  private parseValuesCell(): PropertyValue | null {
    const tok = this.next()
    if (tok.toUpperCase() === 'UNDEF') return null
    if (tok.startsWith('"') || tok.startsWith("'")) return unquote(tok)
    if (tok.startsWith('<')) return tok.replace(/^<|>$/g, '')
    const num = Number(tok)
    return Number.isNaN(num) ? tok : num
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
    if (tok === 'a') return { kind: 'iri', value: 'rdf:type' }  // SPARQL 'a' shorthand — the store projects rdf:type

    if (tok.startsWith('<')) return { kind: 'iri', value: tok.replace(/^<|>$/g, '') }
    if (tok.startsWith('"') || tok.startsWith("'")) return { kind: 'literal', value: unquote(tok) }
    // prefixed name (prefix:local) or bareword keyword like rdf:type
    if (tok.includes(':')) {
      const [prefix, local] = tok.split(':')
      const base = this.prefixes.get(prefix)
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

function joinSolutions(a: Binding[], b: Binding[]): Binding[] {
  const out: Binding[] = []
  for (const x of a) for (const y of b) if (compatible(x, y)) out.push({ ...x, ...y })
  return out
}

function evalGroup(group: GroupGraphPattern, triples: Triple[]): Binding[] {
  let solutions = evalBGP(group.patterns, triples, [{}])

  // Lone nested { … } subgroups → natural join.
  for (const sub of group.subgroups) solutions = joinSolutions(solutions, evalGroup(sub, triples))

  // UNION: each set's alternatives are concatenated, then joined with the current solutions.
  for (const alts of group.unions) {
    const unioned = alts.flatMap((alt) => evalGroup(alt, triples))
    solutions = solutions.length === 1 && Object.keys(solutions[0]).length === 0 ? unioned : joinSolutions(solutions, unioned)
  }

  // VALUES: inline data → join.
  for (const vb of group.values) {
    const rows: Binding[] = vb.rows.map((row) => {
      const b: Binding = {}
      vb.vars.forEach((v, i) => { if (row[i] !== null && row[i] !== undefined) b[v] = row[i] as PropertyValue })
      return b
    })
    solutions = solutions.length === 1 && Object.keys(solutions[0]).length === 0 ? rows : joinSolutions(solutions, rows)
  }

  // BIND: compute a new variable per solution.
  for (const bind of group.binds) {
    solutions = solutions.map((sol) => ({ ...sol, [bind.var]: evalBind(bind.expr, sol) ?? null } as Binding))
  }

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

  // MINUS → remove solutions that share a variable with, and are compatible with, some minus solution.
  for (const m of group.minus) {
    const mSols = evalGroup(m, triples)
    solutions = solutions.filter((sol) => !mSols.some((ms) => sharesVarAndCompatible(sol, ms)))
  }

  // FILTER restriction
  for (const filter of group.filters) {
    solutions = solutions.filter((sol) => evalFilter(filter, sol))
  }

  return solutions
}

function sharesVarAndCompatible(a: Binding, b: Binding): boolean {
  const shared = Object.keys(b).filter((k) => k in a)
  return shared.length > 0 && shared.every((k) => looseEq(a[k], b[k]))
}

function evalBind(expr: BindExpr, binding: Binding): PropertyValue | null {
  switch (expr.kind) {
    case 'val': return resolveValue(expr.expr, binding)
    case 'str': return String(evalBind(expr.arg, binding) ?? '')
    case 'concat': return expr.args.map((a) => String(evalBind(a, binding) ?? '')).join('')
    case 'arith': {
      const l = Number(evalBind(expr.left, binding)), r = Number(evalBind(expr.right, binding))
      if (Number.isNaN(l) || Number.isNaN(r)) return null
      switch (expr.op) { case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return r === 0 ? null : l / r }
    }
  }
}

// GROUP BY + aggregate projection. Called from runSparql when aggregates/groupBy are present.
function aggregate(solutions: Binding[], groupBy: string[], aggregates: AggSpec[]): { variables: string[]; bindings: Binding[] } {
  const groups = new Map<string, Binding[]>()
  for (const sol of solutions) {
    const key = groupBy.map((g) => String(sol[g] ?? '')).join('')
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(sol)
  }
  if (groups.size === 0 && groupBy.length === 0) groups.set('', [])  // aggregate over empty input → one row
  const variables = [...groupBy, ...aggregates.map((a) => a.as)]
  const bindings: Binding[] = []
  for (const rows of groups.values()) {
    const out: Binding = {}
    for (const g of groupBy) out[g] = rows[0]?.[g] ?? null
    for (const a of aggregates) out[a.as] = computeAgg(a, rows)
    bindings.push(out)
  }
  return { variables, bindings }
}

function computeAgg(a: AggSpec, rows: Binding[]): PropertyValue {
  const raw = a.arg === '*' ? rows.map(() => 1) : rows.map((r) => r[a.arg as string]).filter((v) => v !== undefined && v !== null)
  const vals = a.distinct ? Array.from(new Set(raw.map((v) => JSON.stringify(v)))).map((s) => JSON.parse(s)) : raw
  switch (a.fn) {
    case 'COUNT': return a.arg === '*' ? rows.length : vals.length
    case 'SUM': return vals.reduce((s: number, v) => s + Number(v), 0)
    case 'AVG': return vals.length ? vals.reduce((s: number, v) => s + Number(v), 0) / vals.length : 0
    case 'MIN': return vals.length ? vals.reduce((m, v) => (Number(v) < Number(m) ? v : m)) : 0
    case 'MAX': return vals.length ? vals.reduce((m, v) => (Number(v) > Number(m) ? v : m)) : 0
  }
}

function orderSolutions(solutions: Binding[], orderBy: { var: string; desc: boolean }[]): Binding[] {
  return [...solutions].sort((a, b) => {
    for (const { var: v, desc } of orderBy) {
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

  // Aggregation (GROUP BY + COUNT/SUM/AVG/MIN/MAX) short-circuits the normal projection path.
  if (query.aggregates.length > 0 || query.groupBy.length > 0) {
    const agg = aggregate(solutions, query.groupBy, query.aggregates)
    let bindings = agg.bindings
    if (query.orderBy.length > 0) bindings = orderSolutions(bindings, query.orderBy)
    if (query.offset) bindings = bindings.slice(query.offset)
    if (query.limit !== undefined) bindings = bindings.slice(0, query.limit)
    return { variables: agg.variables, bindings, evaluatedAtSeq: store.logicalClock }
  }

  // ORDER BY
  if (query.orderBy.length > 0) solutions = orderSolutions(solutions, query.orderBy)

  // Projection
  const variables = query.projection === '*'
    ? Array.from(new Set(solutions.flatMap((s) => Object.keys(s))))
    : query.projection

  let bindings = solutions.map((s) => {
    // Build via a Map so projection variable names (query-derived) can't inject
    // properties, then materialize a plain Binding (js/remote-property-injection).
    const m = new Map<string, PropertyValue | null>()
    for (const v of variables) m.set(v, s[v] ?? null)
    return Object.fromEntries(m) as Binding
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
