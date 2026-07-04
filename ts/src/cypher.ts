import { createHash } from 'node:crypto'
import { AtomSpace } from './atomspace'
import { findMatches, V, N, L, type Pattern, type PatternTerm } from './patternMatcher'

/**
 * Cypher Facade v0.1 — a human/agent-friendly query surface over the AtomSpace.
 *
 * Conforms to docs/specs/04_Cypher_Facade_v0_1.md: a curated openCypher/GQL
 * subset lowered into the native hypergraph pattern IR (patternMatcher.Pattern),
 * plus the native `MATCH LINK` clause for n-ary hyperedges. The facade never
 * defines canonical semantics — it compiles to the same IR the OpenCog
 * BindLink/GetLink pattern matcher runs, then projects rows.
 *
 * CSKG encoding (Open_Agent_Archetype_Synthesis §3.3): a Cypher relationship
 *   (a)-[:IsA]->(b)
 * lowers to the Atomese standard
 *   EvaluationLink (PredicateNode "IsA") (ListLink (ConceptNode a) (ConceptNode b))
 * so the Archetype's CSKG query — `MATCH (h:Concept {form:$lemma})-[:CSKG*1..2]->(t)`
 * — runs natively as bounded multi-hop pattern matching over ConceptNodes.
 *
 * Sentinel discipline (Archetype §3.2 / §14): this v0.1 is READ-ONLY, rejects
 * unbounded traversals, caps hop-count, and requires a LIMIT — so an agent can
 * never issue an accidentally expensive query. Writes (CREATE/MERGE/SET/DELETE)
 * are refused unless explicitly opted in.
 *
 * Every query carries a snapshot (`evaluatedAtSeq`) and a `queryHash`, so the
 * result is bindable to the reasoning-evidence receipt spine (a grounded query
 * is a recordable justification: propose → query → justify → decide → record).
 */

const NODE_TYPE_DEFAULT = 'ConceptNode'
const REL_LINK = 'EvaluationLink'
const REL_PRED = 'PredicateNode'
const REL_LIST = 'ListLink'

export interface CypherOptions {
  /** Maximum variable-length hop count (Sentinel). Default 3. */
  maxHops?: number
  /** Require an explicit LIMIT clause (Sentinel). Default true. */
  requireLimit?: boolean
  /** Hard cap on returned rows regardless of LIMIT. Default 1000. */
  maxRows?: number
  /** Allow mutation clauses (CREATE/MERGE/SET/DELETE). Default false. */
  allowWrite?: boolean
  /** Declared epistemic mode carried onto the evidence record. */
  mode?: string
  /** Optional hook to emit a receipt-spine evidence record for this query. */
  onEvidence?: (rec: CypherEvidence) => void
}

export interface CypherEvidence {
  queryHash: string
  space: string
  mode: string
  columns: string[]
  rowCount: number
  evaluatedAtSeq: number
  useSpace?: string
}

export interface CypherResult {
  columns: string[]
  rows: Record<string, string>[]
  evaluatedAtSeq: number
  queryHash: string
  useSpace?: string
  /** Populated instead of rows when the query is `EXPLAIN`. */
  plan?: Pattern[]
}

// ─── AST ─────────────────────────────────────────────────────────────────────

interface NodePat { var?: string; label?: string; props: { key: string; value: string }[] }
interface EdgePat { rel: string; dir: 'out' | 'in' | 'both'; lo: number; hi: number }
interface PathPat { nodes: NodePat[]; edges: EdgePat[] }
interface LinkPat { linkType: string; alias?: string; roleVars: string[] }
interface WhereEq { var: string; prop: string; value: string }

interface CypherAst {
  useSpace?: string
  explain: boolean
  write: boolean
  paths: PathPat[]
  links: LinkPat[]
  where: WhereEq[]
  ret: { var: string; prop?: string }[] | '*'
  limit?: number
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(q: string): string[] {
  const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+|\.\.|->|<-|<=|>=|!=|[A-Za-z_][A-Za-z0-9_]*|[(){}\[\]:,.*=<>$-])/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(q)) !== null) if (m[1] !== undefined) out.push(m[1])
  return out
}

const unquote = (t: string) => t.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1')

const WRITE_KW = new Set(['CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE'])

// ─── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0
  constructor(private t: string[], private params: Record<string, string>) {}
  private peek(): string | undefined { return this.t[this.pos] }
  private up(): string | undefined { return this.t[this.pos]?.toUpperCase() }
  private next(): string { return this.t[this.pos++] }
  private expect(tok: string): void {
    const g = this.next()
    if (g?.toUpperCase() !== tok.toUpperCase()) throw new Error(`Cypher parse error: expected '${tok}', got '${g ?? '<eof>'}'`)
  }

  parse(): CypherAst {
    const ast: CypherAst = { explain: false, write: false, paths: [], links: [], where: [], ret: '*' }
    if (this.up() === 'EXPLAIN' || this.up() === 'PROFILE') { ast.explain = this.up() === 'EXPLAIN'; this.next() }
    if (this.up() === 'USE') { this.next(); this.expect('SPACE'); ast.useSpace = this.next() }

    while (this.peek()) {
      const kw = this.up()!
      if (WRITE_KW.has(kw)) { ast.write = true; this.next(); continue }        // flagged; refused later
      if (kw === 'MATCH') {
        this.next()
        if (this.up() === 'LINK') { this.next(); ast.links.push(this.parseLink()) }
        else ast.paths.push(this.parsePath())
      } else if (kw === 'OPTIONAL') { this.next(); this.expect('MATCH'); ast.paths.push(this.parsePath()) }
      else if (kw === 'WHERE') { this.next(); ast.where.push(...this.parseWhere()) }
      else if (kw === 'RETURN') { this.next(); ast.ret = this.parseReturn() }
      else if (kw === 'LIMIT') { this.next(); ast.limit = parseInt(this.next(), 10) }
      else if (kw === 'WITH' || kw === 'ORDER' || kw === 'UNWIND') { this.next() }  // tolerated no-ops in v0.1
      else this.next()
    }
    return ast
  }

  private parseNode(): NodePat {
    this.expect('(')
    const node: NodePat = { props: [] }
    if (this.peek() && this.peek() !== ')' && this.peek() !== ':' && this.peek() !== '{') node.var = this.next()
    if (this.peek() === ':') { this.next(); node.label = this.next() }
    if (this.peek() === '{') {
      this.next()
      while (this.peek() && this.peek() !== '}') {
        const key = this.next(); this.expect(':')
        node.props.push({ key, value: this.resolveVal(this.next()) })
        if (this.peek() === ',') this.next()
      }
      this.expect('}')
    }
    this.expect(')')
    return node
  }

  private parseEdge(): EdgePat {
    let dirIn = false
    if (this.peek() === '<-') { dirIn = true; this.next() } else this.expect('-')
    const edge: EdgePat = { rel: '', dir: dirIn ? 'in' : 'out', lo: 1, hi: 1 }
    if (this.peek() === '[') {
      this.next()
      if (this.peek() === ':') this.next()
      if (this.peek() && this.peek() !== '*' && this.peek() !== ']') edge.rel = this.next()
      if (this.peek() === '*') {
        this.next()
        edge.lo = this.peek() && /^\d+$/.test(this.peek()!) ? parseInt(this.next(), 10) : 1
        if (this.peek() === '..') { this.next(); if (!this.peek() || !/^\d+$/.test(this.peek()!)) throw new Error('Cypher: unbounded variable-length path (missing upper hop bound) is rejected'); edge.hi = parseInt(this.next(), 10) }
        else edge.hi = edge.lo
      }
      this.expect(']')
    }
    // arrow tail
    if (this.peek() === '->') { this.next(); if (dirIn) edge.dir = 'both' }
    else if (this.peek() === '-') { this.next(); if (!dirIn) edge.dir = 'both' }
    return edge
  }

  private parsePath(): PathPat {
    const path: PathPat = { nodes: [this.parseNode()], edges: [] }
    while (this.peek() === '-' || this.peek() === '<-') {
      path.edges.push(this.parseEdge())
      path.nodes.push(this.parseNode())
    }
    return path
  }

  private parseLink(): LinkPat {
    // MATCH LINK d:Decrypt(caller=p, key=k)
    let alias: string | undefined
    let first = this.next()
    if (this.peek() === ':') { alias = first; this.next(); first = this.next() }
    const link: LinkPat = { linkType: first, alias, roleVars: [] }
    this.expect('(')
    while (this.peek() && this.peek() !== ')') {
      this.next(); this.expect('='); link.roleVars.push(this.next())
      if (this.peek() === ',') this.next()
    }
    this.expect(')')
    return link
  }

  private parseWhere(): WhereEq[] {
    const eqs: WhereEq[] = []
    for (;;) {
      const v = this.next(); this.expect('.'); const prop = this.next(); this.expect('=')
      eqs.push({ var: v, prop, value: this.resolveVal(this.next()) })
      if (this.up() === 'AND') { this.next(); continue }
      break
    }
    return eqs
  }

  private parseReturn(): { var: string; prop?: string }[] | '*' {
    if (this.peek() === '*') { this.next(); return '*' }
    const cols: { var: string; prop?: string }[] = []
    while (this.peek() && this.up() !== 'LIMIT' && this.up() !== 'ORDER') {
      const v = this.next()
      let prop: string | undefined
      if (this.peek() === '.') { this.next(); prop = this.next() }
      cols.push({ var: v, prop })
      if (this.peek() === ',') this.next(); else break
    }
    return cols
  }

  private resolveVal(tok: string): string {
    if (tok?.startsWith('$')) return this.params[this.next()] ?? ''  // $ then name
    if (tok === '$') return this.params[this.next()] ?? ''
    return unquote(tok)
  }
}

// ─── Compiler: AST → native Pattern(s) ──────────────────────────────────────────

function nodeTerm(n: NodePat, pin: Map<string, string>): PatternTerm {
  const type = n.label && n.label !== 'Concept' ? n.label : NODE_TYPE_DEFAULT
  const inline = n.props.find((p) => p.key === 'form' || p.key === 'name')?.value
  const pinned = inline ?? (n.var ? pin.get(n.var) : undefined)
  if (pinned) return N(type, pinned)
  return V(n.var ?? `_anon${anon++}`, type)
}
let anon = 0

function edgeClause(rel: string, src: PatternTerm, tgt: PatternTerm, dir: 'out' | 'in' | 'both') {
  const [a, b] = dir === 'in' ? [tgt, src] : [src, tgt]
  return L(REL_LINK, N(REL_PRED, rel), L(REL_LIST, a, b))
}

/** A single path compiles to one-or-more Patterns (variable-length → alternatives). */
function compilePath(path: PathPat, pin: Map<string, string>): Pattern[] {
  anon = 0
  const terms = path.nodes.map((n) => nodeTerm(n, pin))
  // Only a single variable-length edge is expanded (the CSKG multi-hop case);
  // multi-edge paths use fixed length per edge.
  if (path.edges.length === 1 && (path.edges[0].lo !== 1 || path.edges[0].hi !== 1)) {
    const e = path.edges[0]
    const patterns: Pattern[] = []
    for (let k = e.lo; k <= e.hi; k++) {
      const clauses: Extract<PatternTerm, { kind: 'link' }>[] = []
      let prev = terms[0]
      for (let i = 0; i < k; i++) {
        const next = i === k - 1 ? terms[1] : V(`_mid${i}`, NODE_TYPE_DEFAULT)
        clauses.push(edgeClause(e.rel, prev, next, e.dir))
        prev = next
      }
      patterns.push({ clauses })
    }
    return patterns
  }
  const clauses = path.edges.map((e, i) => edgeClause(e.rel, terms[i], terms[i + 1], e.dir))
  return [{ clauses }]
}

function compile(ast: CypherAst): Pattern[] {
  const pin = new Map<string, string>()
  for (const w of ast.where) if (w.prop === 'form' || w.prop === 'name') pin.set(w.var, w.value)

  // A pattern set is the cross of each path's alternatives, merged into one
  // conjunctive Pattern (plus native links). For simplicity v0.1 supports a
  // single variable-length path; fixed paths and links all conjoin.
  const fixedClauses: Extract<PatternTerm, { kind: 'link' }>[] = []
  let varAlternatives: Pattern[] | null = null
  for (const p of ast.paths) {
    const compiled = compilePath(p, pin)
    if (compiled.length > 1) varAlternatives = compiled
    else fixedClauses.push(...compiled[0].clauses)
  }
  for (const lk of ast.links) {
    fixedClauses.push(L(lk.linkType, ...lk.roleVars.map((v) => V(v))))
  }
  if (varAlternatives) return varAlternatives.map((alt) => ({ clauses: [...fixedClauses, ...alt.clauses] }))
  return [{ clauses: fixedClauses }]
}

// ─── Runner ────────────────────────────────────────────────────────────────────

export function runCypher(as: AtomSpace, query: string, params: Record<string, string> = {}, opts: CypherOptions = {}): CypherResult {
  const maxHops = opts.maxHops ?? 3
  const requireLimit = opts.requireLimit ?? true
  const maxRows = opts.maxRows ?? 1000

  const ast = new Parser(tokenize(query), params).parse()

  if (ast.write && !opts.allowWrite) throw new Error('Cypher facade v0.1 is read-only; mutation clauses (CREATE/MERGE/SET/DELETE) are refused')
  for (const p of ast.paths) for (const e of p.edges) {
    if (e.hi > maxHops) throw new Error(`Cypher: variable-length hop ${e.hi} exceeds maxHops ${maxHops}`)
  }
  if (requireLimit && ast.limit === undefined && !ast.explain) throw new Error('Cypher: a LIMIT is required (Sentinel bounded-traversal policy)')

  const patterns = compile(ast)
  const queryHash = 'sha256:' + createHash('sha256').update(query.replace(/\s+/g, ' ').trim()).digest('hex')

  if (ast.explain) {
    return { columns: [], rows: [], evaluatedAtSeq: as.logicalClock, queryHash, useSpace: ast.useSpace, plan: patterns }
  }

  // Union results across variable-length alternatives; dedup rows.
  const seen = new Set<string>()
  let rows: Record<string, string>[] = []
  let columns: string[] = []
  for (const pattern of patterns) {
    const res = findMatches(as, pattern)
    if (columns.length === 0) columns = res.variables.filter((v) => !v.startsWith('_'))
    for (const row of res.results) {
      const projected: Record<string, string> = {}
      for (const c of columns) projected[c] = row[c] ?? ''
      const key = JSON.stringify(projected)
      if (!seen.has(key)) { seen.add(key); rows.push(projected) }
    }
  }

  // Projection (RETURN) — column subset + labels.
  if (ast.ret !== '*') {
    const cols = ast.ret.map((r) => r.var)
    rows = rows.map((r) => { const o: Record<string, string> = {}; for (const c of cols) o[c] = r[c] ?? ''; return o })
    columns = cols
  }

  const limit = Math.min(ast.limit ?? maxRows, maxRows)
  rows = rows.slice(0, limit)

  const result: CypherResult = { columns, rows, evaluatedAtSeq: as.logicalClock, queryHash, useSpace: ast.useSpace }
  opts.onEvidence?.({
    queryHash, space: as.id, mode: opts.mode ?? 'operational', columns, rowCount: rows.length,
    evaluatedAtSeq: as.logicalClock, useSpace: ast.useSpace,
  })
  return result
}
