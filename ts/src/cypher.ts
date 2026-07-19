import { createHash } from 'node:crypto'
import { AtomSpace, nodeHandle, linkHandle, type Handle } from './atomspace'
import { findMatches, V, N, L, type Pattern, type PatternTerm } from './patternMatcher'

/**
 * Cypher Facade v0.1 — a human/agent-friendly READ query surface over the AtomSpace.
 *
 * Honest scope (NOT full Neo4j): MATCH/RETURN, name/form WHERE pins, node-property + edge
 * strength/confidence filters, boolean WHERE (AND/OR/NOT, parenthesised), bounded variable-length paths,
 * ORDER BY/LIMIT, and native `MATCH LINK` for n-ary hyperedges. It is read-only. Anti-silent-wrong: WHERE
 * on a property that exists on NO matched node, XOR in WHERE, and WITH/UNWIND pipelines THROW an explicit
 * "unsupported" error rather than silently returning a wrong/empty result.
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
 * so `MATCH (h:Concept {form:$lemma})-[:CSKG*1..2]->(t)` runs as bounded
 * multi-hop matching. A bound relationship `-[r:IsA]->` exposes the edge's
 * TruthValue as `r.strength` / `r.confidence`, so CSKG edge weights are
 * filterable and sortable: `WHERE r.confidence > 0.5 ... ORDER BY r.confidence DESC`.
 *
 * Sentinel discipline (Archetype §3.2 / §14): this v0.1 is READ-ONLY, rejects
 * unbounded traversals, caps hop-count, and requires a LIMIT — so an agent can
 * never issue an accidentally expensive query.
 *
 * Every query carries a snapshot (`evaluatedAtSeq`) and a `queryHash`, so the
 * result is bindable to the reasoning-evidence receipt spine.
 */

const NODE_TYPE_DEFAULT = 'ConceptNode'
const REL_LINK = 'EvaluationLink'
const REL_PRED = 'PredicateNode'
const REL_LIST = 'ListLink'

export interface CypherOptions {
  maxHops?: number          // Sentinel: max variable-length hops. Default 3.
  requireLimit?: boolean    // Sentinel: require an explicit LIMIT. Default true.
  maxRows?: number          // Hard row cap. Default 1000.
  allowWrite?: boolean      // Allow mutation clauses. Default false.
  mode?: string             // Declared epistemic mode carried onto evidence.
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
  plan?: Pattern[]          // populated for EXPLAIN
}

// ─── AST ─────────────────────────────────────────────────────────────────────

interface NodePat { var?: string; label?: string; props: { key: string; value: string }[] }
interface EdgePat { var?: string; rel: string; dir: 'out' | 'in' | 'both'; lo: number; hi: number }
interface PathPat { nodes: NodePat[]; edges: EdgePat[] }
interface LinkPat { linkType: string; alias?: string; roleVars: string[] }
interface ColRef { var: string; prop?: string }
type CmpOp = '=' | '!=' | '<' | '>' | '<=' | '>='
interface Filter { lhs: ColRef; op: CmpOp; rhs: string | number }

// Boolean WHERE expression tree (AND/OR/NOT + parenthesised comparisons). A pure conjunction of
// comparisons is lowered to `pins` + flat `filters` (keeping the compile-time name/form pin fast path);
// anything with OR/NOT is kept as a `where` tree and evaluated per-row at runtime.
type WExpr =
  | { t: 'cmp'; lhs: ColRef; op: CmpOp; rhs: string | number }
  | { t: 'and' | 'or'; l: WExpr; r: WExpr }
  | { t: 'not'; e: WExpr }

interface CypherAst {
  useSpace?: string
  explain: boolean
  write: boolean
  paths: PathPat[]
  links: LinkPat[]
  pins: { var: string; value: string }[]   // form/name equalities → node-name pins (pure-AND fast path)
  filters: Filter[]                          // pure-AND residual comparisons → post-match filter
  where?: WExpr                              // set instead of pins/filters when OR/NOT is present
  ret: ColRef[] | '*'
  orderBy: { key: string; desc: boolean }[]
  limit?: number
}

type CmpLeaf = Extract<WExpr, { t: 'cmp' }>
// A pure conjunction of comparisons (only `and` nodes over `cmp` leaves) → the flat leaf list; any `or`/`not`
// makes it non-conjunctive → null (caller keeps the tree for runtime evaluation instead of the pin fast path).
function flattenAndCmp(e: WExpr): CmpLeaf[] | null {
  if (e.t === 'cmp') return [e]
  if (e.t === 'and') { const l = flattenAndCmp(e.l), r = flattenAndCmp(e.r); return l && r ? [...l, ...r] : null }
  return null
}
// Every comparison leaf in a WHERE tree (for the anti-silent-wrong projected-property check).
function cmpLeaves(e: WExpr | undefined): CmpLeaf[] {
  if (!e) return []
  if (e.t === 'cmp') return [e]
  if (e.t === 'not') return cmpLeaves(e.e)
  return [...cmpLeaves(e.l), ...cmpLeaves(e.r)]
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(q: string): string[] {
  // String literals use the unrolled-loop form ("[^"\\]*(?:\\.[^"\\]*)*") — a
  // linear-time equivalent of "(?:[^"\\]|\\.)*" that avoids polynomial ReDoS
  // backtracking on inputs like `"\"\"\"…` (CodeQL js/polynomial-redos).
  const re = /\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\d+(?:\.\d+)?|\.\.|->|<-|<=|>=|<>|!=|[A-Za-z_][A-Za-z0-9_]*|[(){}\[\]:,.*=<>$-])/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(q)) !== null) if (m[1] !== undefined) out.push(m[1])
  return out
}

const unquote = (t: string) => t.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1')
const WRITE_KW = new Set(['CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE'])
const isNum = (t?: string) => t !== undefined && /^\d+(\.\d+)?$/.test(t)

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
    const ast: CypherAst = { explain: false, write: false, paths: [], links: [], pins: [], filters: [], ret: '*', orderBy: [] }
    if (this.up() === 'EXPLAIN' || this.up() === 'PROFILE') { ast.explain = this.up() === 'EXPLAIN'; this.next() }
    if (this.up() === 'USE') { this.next(); this.expect('SPACE'); ast.useSpace = this.next() }

    while (this.peek()) {
      const kw = this.up()!
      if (WRITE_KW.has(kw)) { ast.write = true; this.next(); continue }
      if (kw === 'MATCH') {
        this.next()
        if (this.up() === 'LINK') { this.next(); ast.links.push(this.parseLink()) }
        else ast.paths.push(this.parsePath())
      } else if (kw === 'OPTIONAL') { this.next(); this.expect('MATCH'); ast.paths.push(this.parsePath()) }
      else if (kw === 'WHERE') { this.next(); this.applyWhere(ast, this.parseWhereExpr()) }
      else if (kw === 'RETURN') { this.next(); ast.ret = this.parseReturn() }
      else if (kw === 'ORDER') { this.next(); this.expect('BY'); this.parseOrderBy(ast) }
      else if (kw === 'LIMIT') { this.next(); ast.limit = parseInt(this.next(), 10) }
      else if (kw === 'WITH' || kw === 'UNWIND') {
        // Was a SILENT no-op (token consumed, pipeline ignored) → wrong results. Refuse loudly instead.
        throw new Error(`Cypher unsupported: ${kw} pipelines are not implemented in this read facade`)
      }
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
      if (this.peek() && this.peek() !== ':' && this.peek() !== '*' && this.peek() !== ']') edge.var = this.next()   // -[r:REL]->
      if (this.peek() === ':') this.next()
      if (this.peek() && this.peek() !== '*' && this.peek() !== ']') edge.rel = this.next()
      if (this.peek() === '*') {
        this.next()
        edge.lo = isNum(this.peek()) ? parseInt(this.next(), 10) : 1
        if (this.peek() === '..') { this.next(); if (!isNum(this.peek())) throw new Error('Cypher: unbounded variable-length path (missing upper hop bound) is rejected'); edge.hi = parseInt(this.next(), 10) }
        else edge.hi = edge.lo
      }
      this.expect(']')
    }
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

  // WHERE grammar (precedence NOT > AND > OR), parenthesised: or := and (OR and)* ; and := not (AND not)* ;
  // not := NOT not | primary ; primary := '(' or ')' | cmp ; cmp := var '.' prop op value.
  private parseWhereExpr(): WExpr { return this.parseOr() }
  private parseOr(): WExpr {
    let e = this.parseAnd()
    for (;;) {
      const u = this.up()
      if (u === 'OR') { this.next(); e = { t: 'or', l: e, r: this.parseAnd() } }
      // XOR was silently skipped by the old flat loop (unknown token → main loop no-op) → wrong results.
      else if (u === 'XOR') throw new Error('Cypher unsupported: XOR in WHERE — only AND/OR/NOT are implemented')
      else return e
    }
  }
  private parseAnd(): WExpr {
    let e = this.parseNot()
    while (this.up() === 'AND') { this.next(); e = { t: 'and', l: e, r: this.parseNot() } }
    return e
  }
  private parseNot(): WExpr {
    if (this.up() === 'NOT') { this.next(); return { t: 'not', e: this.parseNot() } }
    return this.parsePrimary()
  }
  private parsePrimary(): WExpr {
    if (this.peek() === '(') { this.next(); const e = this.parseOr(); this.expect(')'); return e }
    const v = this.next(); this.expect('.'); const prop = this.next()
    const opTok = this.next()
    const op: CmpOp = (opTok === '<>' ? '!=' : opTok) as CmpOp
    const rawTok = this.next()
    const rhs = isNum(rawTok) ? Number(rawTok) : this.resolveVal(rawTok)
    return { t: 'cmp', lhs: { var: v, prop }, op, rhs }
  }

  // Lower the parsed tree: a pure conjunction of comparisons → compile-time name/form pins + flat filters
  // (fast path, preserves the pattern-narrowing pin optimization). Any OR/NOT → keep the whole tree for
  // runtime row evaluation (pins can't narrow a disjunction, so name/form equalities become row filters).
  private applyWhere(ast: CypherAst, e: WExpr): void {
    const conj = flattenAndCmp(e)
    if (conj) {
      for (const c of conj) {
        if (c.op === '=' && (c.lhs.prop === 'form' || c.lhs.prop === 'name') && typeof c.rhs === 'string') {
          ast.pins.push({ var: c.lhs.var, value: c.rhs })
        } else ast.filters.push({ lhs: c.lhs, op: c.op, rhs: c.rhs })
      }
    } else ast.where = e
  }

  private parseReturn(): ColRef[] | '*' {
    if (this.peek() === '*') { this.next(); return '*' }
    const cols: ColRef[] = []
    while (this.peek() && this.up() !== 'LIMIT' && this.up() !== 'ORDER') {
      const v = this.next()
      let prop: string | undefined
      if (this.peek() === '.') { this.next(); prop = this.next() }
      cols.push({ var: v, prop })
      if (this.peek() === ',') this.next(); else break
    }
    return cols
  }

  private parseOrderBy(ast: CypherAst): void {
    while (this.peek() && this.up() !== 'LIMIT') {
      const v = this.next()
      let prop: string | undefined
      if (this.peek() === '.') { this.next(); prop = this.next() }
      let desc = false
      if (this.up() === 'ASC' || this.up() === 'DESC') { desc = this.up() === 'DESC'; this.next() }
      ast.orderBy.push({ key: prop ? `${v}.${prop}` : v, desc })
      if (this.peek() === ',') this.next(); else break
    }
  }

  private resolveVal(tok: string): string {
    if (tok === '$') return this.params[this.next()] ?? ''
    if (tok?.startsWith('$')) return this.params[tok.slice(1)] ?? ''
    return unquote(tok)
  }
}

// ─── Compiler: AST → native Pattern(s) + edge specs (for TruthValue projection) ──

type TermRef = { kind: 'var'; name: string; type: string } | { kind: 'node'; type: string; name: string }
interface EdgeSpec { var?: string; rel: string; dir: 'out' | 'in' | 'both'; src: TermRef; tgt: TermRef }

let anon = 0
function nodeTermRef(n: NodePat, pin: Map<string, string>): TermRef {
  const type = n.label && n.label !== 'Concept' ? n.label : NODE_TYPE_DEFAULT
  const inline = n.props.find((p) => p.key === 'form' || p.key === 'name')?.value
  const pinned = inline ?? (n.var ? pin.get(n.var) : undefined)
  if (pinned) return { kind: 'node', type, name: pinned }
  return { kind: 'var', name: n.var ?? `_anon${anon++}`, type }
}
const asTerm = (r: TermRef): PatternTerm => (r.kind === 'node' ? N(r.type, r.name) : V(r.name, r.type))

function edgeClause(rel: string, src: PatternTerm, tgt: PatternTerm, dir: 'out' | 'in' | 'both') {
  const [a, b] = dir === 'in' ? [tgt, src] : [src, tgt]
  return L(REL_LINK, N(REL_PRED, rel), L(REL_LIST, a, b))
}

interface Compiled { patterns: Pattern[]; edgeSpecs: EdgeSpec[] }

function compile(ast: CypherAst): Compiled {
  anon = 0
  const pin = new Map<string, string>()
  for (const p of ast.pins) pin.set(p.var, p.value)

  const fixedClauses: Extract<PatternTerm, { kind: 'link' }>[] = []
  const edgeSpecs: EdgeSpec[] = []
  let varAlternatives: Pattern[] | null = null

  for (const path of ast.paths) {
    const refs = path.nodes.map((n) => nodeTermRef(n, pin))
    if (path.edges.length === 1 && (path.edges[0].lo !== 1 || path.edges[0].hi !== 1)) {
      // variable-length: expand to alternatives (no edge-var TV projection here)
      const e = path.edges[0]
      const alts: Pattern[] = []
      for (let k = e.lo; k <= e.hi; k++) {
        const clauses: Extract<PatternTerm, { kind: 'link' }>[] = []
        let prev = asTerm(refs[0])
        for (let i = 0; i < k; i++) {
          const next = i === k - 1 ? asTerm(refs[1]) : V(`_mid${i}`, NODE_TYPE_DEFAULT)
          clauses.push(edgeClause(e.rel, prev, next, e.dir))
          prev = next
        }
        alts.push({ clauses })
      }
      varAlternatives = alts
    } else {
      path.edges.forEach((e, i) => {
        fixedClauses.push(edgeClause(e.rel, asTerm(refs[i]), asTerm(refs[i + 1]), e.dir))
        edgeSpecs.push({ var: e.var, rel: e.rel, dir: e.dir, src: refs[i], tgt: refs[i + 1] })
      })
    }
  }
  for (const lk of ast.links) fixedClauses.push(L(lk.linkType, ...lk.roleVars.map((v) => V(v))))

  const patterns = varAlternatives
    ? varAlternatives.map((alt) => ({ clauses: [...fixedClauses, ...alt.clauses] }))
    : [{ clauses: fixedClauses }]
  return { patterns, edgeSpecs }
}

// ─── Edge TruthValue resolution ──────────────────────────────────────────────

function handleOf(ref: TermRef, grounding: Record<string, Handle>): Handle | undefined {
  return ref.kind === 'node' ? nodeHandle(ref.type, ref.name) : grounding[ref.name]
}

function edgeTv(as: AtomSpace, spec: EdgeSpec, grounding: Record<string, Handle>): { strength: number; confidence: number } | null {
  const s = handleOf(spec.src, grounding), t = handleOf(spec.tgt, grounding)
  if (!s || !t) return null
  const [h1, h2] = spec.dir === 'in' ? [t, s] : [s, t]
  const list = linkHandle(REL_LIST, [h1, h2])
  const pred = nodeHandle(REL_PRED, spec.rel)
  const evalH = linkHandle(REL_LINK, [pred, list])
  const atom = as.getAtom(evalH)
  return atom?.tv ?? null
}

// ─── Runner ────────────────────────────────────────────────────────────────────

export function runCypher(as: AtomSpace, query: string, params: Record<string, string> = {}, opts: CypherOptions = {}): CypherResult {
  const maxHops = opts.maxHops ?? 3
  const requireLimit = opts.requireLimit ?? true
  const maxRows = opts.maxRows ?? 1000

  const ast = new Parser(tokenize(query), params).parse()
  if (ast.write && !opts.allowWrite) throw new Error('Cypher facade v0.1 is read-only; mutation clauses (CREATE/MERGE/SET/DELETE) are refused')
  for (const p of ast.paths) for (const e of p.edges) if (e.hi > maxHops) throw new Error(`Cypher: variable-length hop ${e.hi} exceeds maxHops ${maxHops}`)
  if (requireLimit && ast.limit === undefined && !ast.explain) throw new Error('Cypher: a LIMIT is required (Sentinel bounded-traversal policy)')

  const { patterns, edgeSpecs } = compile(ast)
  const queryHash = 'sha256:' + createHash('sha256').update(query.replace(/\s+/g, ' ').trim()).digest('hex')
  if (ast.explain) return { columns: [], rows: [], evaluatedAtSeq: as.logicalClock, queryHash, useSpace: ast.useSpace, plan: patterns }

  const edgeVarSpecs = edgeSpecs.filter((s) => s.var)
  type RRow = Record<string, string | number>
  const seen = new Set<string>()
  const resolved: RRow[] = []

  for (const pattern of patterns) {
    const res = findMatches(as, pattern)
    res.results.forEach((row, i) => {
      const rr: RRow = {}
      for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) rr[k] = v
      // node-property projection: expose each grounded node's generic Values as `var.prop`, so WHERE/RETURN
      // can filter and read arbitrary node properties (e.g. `a.age > 10`), not just name/form. Float/string
      // Values project their first scalar; the row already carries `var` = node name for name/form predicates.
      for (const [v, h] of Object.entries(res.groundings[i])) {
        if (v.startsWith('_')) continue
        const atom = as.getAtom(h)
        if (!atom) continue
        for (const [pk, pv] of Object.entries(atom.values)) {
          const scalar = pv.kind === 'link' ? undefined : pv.value[0]
          if (scalar !== undefined) rr[`${v}.${pk}`] = scalar
        }
      }
      // edge-var TruthValue projection (single fixed edges)
      for (const spec of edgeVarSpecs) {
        const tv = edgeTv(as, spec, res.groundings[i])
        if (tv) { rr[`${spec.var}.strength`] = tv.strength; rr[`${spec.var}.confidence`] = tv.confidence }
      }
      const key = JSON.stringify(rr)
      if (!seen.has(key)) { seen.add(key); resolved.push(rr) }
    })
  }

  // WHERE filters (comparisons over resolved values). form/name → the `var` key (node name); every other
  // property → the projected `var.prop` key (node Values or edge strength/confidence).
  const key = (c: ColRef) => (c.prop && c.prop !== 'form' && c.prop !== 'name' ? `${c.var}.${c.prop}` : c.var)
  // Anti-silent-wrong: node properties ARE projected above, so a real property filters correctly. But a
  // predicate on a property that exists on NO matched node would silently drop every row (0 results when the
  // true answer is non-empty). Detect that — across BOTH the flat filters and the boolean `where` tree — and
  // THROW rather than return a wrong empty set.
  if (resolved.length > 0) {
    const projected = new Set(resolved.flatMap((r) => Object.keys(r)))
    const refs = [...ast.filters.map((f) => f.lhs), ...cmpLeaves(ast.where).map((c) => c.lhs)]
    for (const lhs of refs) {
      if (!projected.has(key(lhs))) {
        throw new Error(`Cypher unsupported: WHERE on node property '${lhs.var}.${lhs.prop}' — no matched node ` +
          `carries that property (refusing a silently-wrong empty result)`)
      }
    }
  }
  const evalW = (e: WExpr, r: RRow): boolean => {
    switch (e.t) {
      case 'cmp': return cmp(r[key(e.lhs)], e.op, e.rhs)
      case 'and': return evalW(e.l, r) && evalW(e.r, r)
      case 'or': return evalW(e.l, r) || evalW(e.r, r)
      case 'not': return !evalW(e.e, r)
    }
  }
  let rows = ast.where
    ? resolved.filter((r) => evalW(ast.where as WExpr, r))
    : resolved.filter((r) => ast.filters.every((f) => cmp(r[key(f.lhs)], f.op, f.rhs)))

  // ORDER BY
  if (ast.orderBy.length) {
    rows = [...rows].sort((a, b) => {
      for (const { key: k, desc } of ast.orderBy) {
        const c = compareVal(a[k], b[k])
        if (c !== 0) return desc ? -c : c
      }
      return 0
    })
  }

  // Projection + stringify
  const outCols = ast.ret === '*'
    ? Array.from(new Set(resolved.flatMap((r) => Object.keys(r)).filter((k) => !k.includes('.'))))
    : ast.ret.map((c) => (c.prop ? `${c.var}.${c.prop}` : c.var))
  let outRows = rows.map((r) => {
    const o: Record<string, string> = {}
    for (const c of outCols) { const v = r[c] ?? r[c.split('.')[0]]; o[c] = v === undefined ? '' : String(v) }
    return o
  })

  outRows = outRows.slice(0, Math.min(ast.limit ?? maxRows, maxRows))
  opts.onEvidence?.({ queryHash, space: as.id, mode: opts.mode ?? 'operational', columns: outCols, rowCount: outRows.length, evaluatedAtSeq: as.logicalClock, useSpace: ast.useSpace })
  return { columns: outCols, rows: outRows, evaluatedAtSeq: as.logicalClock, queryHash, useSpace: ast.useSpace }
}

function cmp(l: string | number | undefined, op: CmpOp, r: string | number): boolean {
  if (l === undefined) return false
  const ln = typeof l === 'number' ? l : Number(l), rn = typeof r === 'number' ? r : Number(r)
  const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && l !== '' && r !== ''
  switch (op) {
    case '=': return String(l) === String(r)
    case '!=': return String(l) !== String(r)
    case '<': return numeric ? ln < rn : String(l) < String(r)
    case '>': return numeric ? ln > rn : String(l) > String(r)
    case '<=': return numeric ? ln <= rn : String(l) <= String(r)
    case '>=': return numeric ? ln >= rn : String(l) >= String(r)
  }
}

function compareVal(a: string | number | undefined, b: string | number | undefined): number {
  const an = Number(a), bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  return String(a ?? '').localeCompare(String(b ?? ''))
}
