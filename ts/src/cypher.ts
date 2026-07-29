import { createHash } from 'node:crypto'
import { AtomSpace, nodeHandle, linkHandle, type Atom, type Handle } from './atomspace'
import { findMatches, V, N, L, type Pattern, type PatternTerm, type Grounding } from './patternMatcher'
import { cloneDict, emptyDict, ownValue, toPlainRow } from './safe-dict.js'

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
 * Façade encoding (store.ts, the supported write path — 0.4.45): `addNode(id, labels, props)`
 * writes ONE ConceptNode(name = id) carrying its labels in the `graph:labels` Value and each
 * property under a `prop:`-namespaced Value key. Cypher therefore reads BOTH namespaces:
 *   • a label matches an atom TYPE (natively-typed atoms, e.g. the KKO lattice kko.ts declares)
 *     OR membership of `graph:labels` (façade-written nodes); multi-label nodes match on ANY label;
 *   • `n.price` reads the `prop:price` Value (the raw Value key stays readable too).
 * Reading only one namespace is what made a façade-written graph answer `MATCH (n:Label)` with a
 * single all-empty row — silent-wrong, fixed in 0.4.45.
 *
 * Sentinel discipline (Archetype §3.2 / §14): this v0.1 is READ-ONLY, rejects
 * unbounded traversals, caps hop-count, and requires a LIMIT — so an agent can
 * never issue an accidentally expensive query. A label/anchor-free node pattern is a SCAN, so it
 * is bounded twice over: it stops as soon as LIMIT rows exist (when nothing downstream can
 * re-order or drop them) and it THROWS at `maxScan` candidates rather than silently truncating.
 *
 * Every query carries a snapshot (`evaluatedAtSeq`) and a `queryHash`, so the
 * result is bindable to the reasoning-evidence receipt spine.
 */

const NODE_TYPE_DEFAULT = 'ConceptNode'
const REL_LINK = 'EvaluationLink'
const REL_PRED = 'PredicateNode'
const REL_LIST = 'ListLink'
// The two Value namespaces store.ts writes façade nodes under (see the header note).
const LABELS_KEY = 'graph:labels'
const PROP_NS = 'prop:'
// `(n:Concept)` is the facade's spelling of "the default ConceptNode type", not a stored label.
const CONCEPT_ALIAS = 'Concept'

export interface CypherOptions {
  maxHops?: number          // Sentinel: max variable-length hops. Default 3.
  requireLimit?: boolean    // Sentinel: require an explicit LIMIT. Default true.
  maxRows?: number          // Hard row cap. Default 1000.
  maxScan?: number          // Sentinel: max node candidates a label/anchor-free scan may visit. Default 100000.
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
  pins: { var: string; value: string }[]   // `form` equalities → node-identity pins (pure-AND fast path)
  filters: Filter[]                          // pure-AND residual comparisons → post-match filter
  where?: WExpr                              // set instead of pins/filters when OR/NOT is present
  ret: ColRef[] | '*'
  orderBy: { ref: ColRef; desc: boolean }[]
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
        else this.addPath(ast, this.parsePath())
      } else if (kw === 'OPTIONAL') { this.next(); this.expect('MATCH'); this.addPath(ast, this.parsePath()) }
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

  /**
   * Record a parsed path and lower its inline `{…}` property map.
   * `{form:"x"}` is the node-IDENTITY pin (compile-time, narrows the pattern); every OTHER inline
   * property is a predicate and is lowered to the same residual filter list WHERE uses — it used to
   * be parsed and then silently DROPPED, so `(n {symbol:"SP:AAA"})` matched every node. An inline
   * predicate on an anonymous node has no row key to filter on, so it is refused loudly instead.
   * A comma-separated multi-pattern MATCH was also silently dropped after the comma; refuse it too
   * (`MATCH (a) MATCH (b)` is the supported spelling).
   */
  private addPath(ast: CypherAst, path: PathPat): void {
    if (this.peek() === ',') {
      throw new Error('Cypher unsupported: comma-separated MATCH patterns — write a separate MATCH clause per pattern')
    }
    for (const node of path.nodes) {
      for (const p of node.props) {
        if (p.key === 'form') continue
        if (!node.var) throw new Error(`Cypher unsupported: inline property '{${p.key}: …}' on an anonymous node — give the node a variable`)
        ast.filters.push({ lhs: { var: node.var, prop: p.key }, op: '=', rhs: isNum(p.value) ? Number(p.value) : p.value })
      }
    }
    ast.paths.push(path)
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

  // Lower the parsed tree: a pure conjunction of comparisons → compile-time `form` identity pins + flat
  // filters (fast path, preserves the pattern-narrowing pin optimization). Any OR/NOT → keep the whole
  // tree for runtime row evaluation (pins can't narrow a disjunction, so identity equalities become
  // row filters).
  //
  // `name` is NOT pinned (it was, through 0.4.44). Spec 04 §Property Access defines `n.name` as the
  // stored `prop.name` valuation, and a façade node routinely has a `name` property that differs from
  // its id — pinning it compiled `WHERE n.name = "Alice"` into an identity lookup for an atom named
  // "Alice" and silently returned nothing. `form` stays the reserved identity pin, and `name` falls
  // back to identity at row level when the node carries no `name` property, so the old spelling keeps
  // working (it just no longer narrows the pattern).
  private applyWhere(ast: CypherAst, e: WExpr): void {
    const conj = flattenAndCmp(e)
    if (conj) {
      for (const c of conj) {
        if (c.op === '=' && c.lhs.prop === 'form' && typeof c.rhs === 'string') {
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
      ast.orderBy.push({ ref: { var: v, prop }, desc })
      if (this.peek() === ',') this.next(); else break
    }
  }

  private resolveVal(tok: string): string {
    // The parameter NAME is query-derived and `params` is caller-supplied, so an own-property
    // read only: `$constructor` must be an unsupplied parameter, not Object.prototype.constructor.
    if (tok === '$') return ownValue(this.params, this.next()) ?? ''
    if (tok?.startsWith('$')) return ownValue(this.params, tok.slice(1)) ?? ''
    return unquote(tok)
  }
}

// ─── Compiler: AST → native Pattern(s) + edge specs (for TruthValue projection) ──

type TermRef = { kind: 'var'; name: string; type?: string } | { kind: 'node'; type: string; name: string }
interface EdgeSpec { var?: string; rel: string; dir: 'out' | 'in' | 'both'; src: TermRef; tgt: TermRef }

/**
 * One node position in the query, carrying what the native Pattern IR cannot express.
 * A Cypher label is NOT an atom type (see the header note), and an identity-pinned node is a
 * CONSTANT in the IR — so the matcher never binds its variable. Both are settled here, against the
 * groundings, instead of being dropped.
 */
interface NodeSlot {
  irVar: string          // grounding key: the user's variable, or a generated `_anon`/`_pin` name
  label?: string         // enforced over BOTH namespaces (atom type OR `graph:labels` membership)
  pinnedHandle?: Handle  // identity-pinned node: bound explicitly, since the IR holds it as a constant
}

let anon = 0
function nodeTermRef(as: AtomSpace, n: NodePat, pin: Map<string, string>, slots: NodeSlot[]): TermRef {
  const label = n.label
  const inline = n.props.find((p) => p.key === 'form')?.value
  const pinned = inline ?? (n.var ? pin.get(n.var) : undefined)
  if (pinned) {
    // A label may still name a real atom TYPE (natively-typed atoms): prefer the natively-typed atom
    // when one exists under (label, name), else the façade's ConceptNode. Either way the label is
    // re-checked as a predicate below, so a wrong guess yields no rows rather than a wrong row.
    const type = label && label !== CONCEPT_ALIAS && as.getNode(label, pinned) ? label : NODE_TYPE_DEFAULT
    slots.push({ irVar: n.var ?? `_pin${anon++}`, label, pinnedHandle: nodeHandle(type, pinned) })
    return { kind: 'node', type, name: pinned }
  }
  const name = n.var ?? `_anon${anon++}`
  slots.push({ irVar: name, label })
  // Labelled vars stay UNTYPED in the IR (a label is not an atom type) and are narrowed by the label
  // predicate; unlabelled vars keep the ConceptNode restriction they have always had.
  return { kind: 'var', name, type: label ? undefined : NODE_TYPE_DEFAULT }
}
const asTerm = (r: TermRef): PatternTerm => (r.kind === 'node' ? N(r.type, r.name) : V(r.name, r.type))

/**
 * Cypher label semantics (settled in 0.4.45). `(n:Foo)` matches an atom when EITHER
 *   (a) its atom TYPE is Foo or a subtype of Foo — natively-typed atoms, e.g. the hierarchy kko.ts
 *       declares on the type lattice; this is what the facade has always done, and it stays; OR
 *   (b) its `graph:labels` Value contains Foo — every node written through HellGraphStore.addNode,
 *       which is the supported write path and was previously unmatchable by its own labels.
 * A multi-label node matches on ANY of its labels (openCypher semantics).
 */
function atomMatchesLabel(as: AtomSpace, atom: Atom | undefined, label: string): boolean {
  if (!atom) return false
  if (as.types.isA(atom.type, label === CONCEPT_ALIAS ? NODE_TYPE_DEFAULT : label)) return true
  const v = atom.values[LABELS_KEY]
  return v !== undefined && v.kind === 'string' && v.value.includes(label)
}

// ─── Label index (version-keyed) ─────────────────────────────────────────────
// `graph:labels` is a multi-valued Value, so the AtomSpace's exact-match value index cannot answer
// "which nodes carry label X" (it keys the whole label list). Build the inverted index once per
// AtomSpace VERSION — same discipline as the attribute index — so a label scan costs O(|label|)
// while the space is unchanged, and O(nodes) only on the first query after a write.
interface LabelIndex { version: number; byLabel: Map<string, Handle[]> }
const LABEL_INDEX = new WeakMap<AtomSpace, LabelIndex>()

function labelIndex(as: AtomSpace): Map<string, Handle[]> {
  const hit = LABEL_INDEX.get(as)
  if (hit && hit.version === as.logicalClock) return hit.byLabel
  const byLabel = new Map<string, Handle[]>()
  for (const atom of as.getByType(NODE_TYPE_DEFAULT, false)) {
    const v = atom.values[LABELS_KEY]
    if (v === undefined || v.kind !== 'string') continue
    for (const label of v.value) {
      const bucket = byLabel.get(label)
      if (bucket) bucket.push(atom.handle)
      else byLabel.set(label, [atom.handle])
    }
  }
  LABEL_INDEX.set(as, { version: as.logicalClock, byLabel })
  return byLabel
}

/** Candidate atoms for a node position no clause binds: the union of both label namespaces. */
function scanCandidates(as: AtomSpace, label: string | undefined): Handle[] {
  if (label === undefined) return as.getByType(NODE_TYPE_DEFAULT, false).map((a) => a.handle)
  const byType = as.getByType(label === CONCEPT_ALIAS ? NODE_TYPE_DEFAULT : label, true)
  const byLabel = labelIndex(as).get(label) ?? []
  if (byType.length === 0) return byLabel
  const out = new Set<Handle>(byLabel)
  for (const a of byType) out.add(a.handle)
  return Array.from(out)
}

function edgeClause(rel: string, src: PatternTerm, tgt: PatternTerm, dir: 'out' | 'in' | 'both') {
  const [a, b] = dir === 'in' ? [tgt, src] : [src, tgt]
  return L(REL_LINK, N(REL_PRED, rel), L(REL_LIST, a, b))
}

interface Compiled { patterns: Pattern[]; edgeSpecs: EdgeSpec[]; slots: NodeSlot[] }

function compile(as: AtomSpace, ast: CypherAst): Compiled {
  anon = 0
  const pin = new Map<string, string>()
  for (const p of ast.pins) pin.set(p.var, p.value)

  const fixedClauses: Extract<PatternTerm, { kind: 'link' }>[] = []
  const edgeSpecs: EdgeSpec[] = []
  const slots: NodeSlot[] = []
  let varAlternatives: Pattern[] | null = null

  for (const path of ast.paths) {
    const refs = path.nodes.map((n) => nodeTermRef(as, n, pin, slots))
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
  return { patterns, edgeSpecs, slots }
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

type RRow = Record<string, string | number>

/**
 * Resolve a `var[.prop]` reference against a projected row. ONE resolver, shared by WHERE, ORDER BY
 * and RETURN, so the three can never disagree — they did: RETURN fell back to the node id for ANY
 * unknown property (so `n.price` RENDERED the node id) while WHERE on the same reference matched
 * nothing. Resolution order:
 *   • `var`             → the bound node's name (its façade id).
 *   • `var.form`        → RESERVED node identity, never shadowed (it is the compile-time pin).
 *   • `var.prop`        → the projected property: the bare `prop:`-namespaced name, or a raw Value key.
 *   • `var.name`        → the stored `name` property (spec 04 §Property Access), else the identity.
 * Anything never projected stays `undefined`: RETURN renders '' and WHERE refuses loudly.
 */
function refValue(r: RRow, c: ColRef): string | number | undefined {
  if (!c.prop || c.prop === 'form') return r[c.var]
  const v = r[`${c.var}.${c.prop}`]
  if (v !== undefined) return v
  return c.prop === 'name' ? r[c.var] : undefined
}

export function runCypher(as: AtomSpace, query: string, params: Record<string, string> = {}, opts: CypherOptions = {}): CypherResult {
  const maxHops = opts.maxHops ?? 3
  const requireLimit = opts.requireLimit ?? true
  const maxRows = opts.maxRows ?? 1000
  const maxScan = opts.maxScan ?? 100_000

  const ast = new Parser(tokenize(query), params).parse()
  if (ast.write && !opts.allowWrite) throw new Error('Cypher facade v0.1 is read-only; mutation clauses (CREATE/MERGE/SET/DELETE) are refused')
  for (const p of ast.paths) for (const e of p.edges) if (e.hi > maxHops) throw new Error(`Cypher: variable-length hop ${e.hi} exceeds maxHops ${maxHops}`)
  if (requireLimit && ast.limit === undefined && !ast.explain) throw new Error('Cypher: a LIMIT is required (Sentinel bounded-traversal policy)')

  const { patterns, edgeSpecs, slots } = compile(as, ast)
  const queryHash = 'sha256:' + createHash('sha256').update(query.replace(/\s+/g, ' ').trim()).digest('hex')
  if (ast.explain) return { columns: [], rows: [], evaluatedAtSeq: as.logicalClock, queryHash, useSpace: ast.useSpace, plan: patterns }

  const edgeVarSpecs = edgeSpecs.filter((s) => s.var)
  const seen = new Set<string>()
  const resolved: RRow[] = []

  // Sentinel bound on a node scan. Truncating at LIMIT is only CORRECT when nothing downstream can
  // re-order or drop rows: with an ORDER BY or any predicate the full candidate set is needed, so the
  // scan runs to completion and THROWS at maxScan rather than silently truncating.
  const streamable = ast.orderBy.length === 0 && ast.filters.length === 0 && !ast.where
  const rowBudget = Math.min(ast.limit ?? maxRows, maxRows)
  let scanned = 0

  // Build one output row from a complete grounding. Returns false when enough rows exist.
  const emit = (g: Grounding): boolean => {
    // Keyed by Cypher variable names and `var.prop` paths, all query-derived — null-prototype
    // so a variable named `__proto__` is stored rather than swallowed (see safe-dict.ts).
    const rr: RRow = emptyDict<string | number>()
    for (const [v, h] of Object.entries(g)) {
      if (v.startsWith('_')) continue
      const atom = as.getAtom(h)
      if (!atom) continue
      // `var` = the node's façade id. findMatches only reports variables its CLAUSES bind, so a
      // label-only pattern (no clauses) and an identity-pinned node (a constant, not a variable)
      // both left the row's own variable unbound — `RETURN n` rendered ''. Bind it from the atom.
      rr[v] = atom.name ?? atom.type
      // Node-property projection: every scalar Value is readable as `var.key` under its RAW key…
      for (const [pk, pv] of Object.entries(atom.values)) {
        if (pv.kind === 'link') continue
        const scalar = pv.value[0]
        if (scalar !== undefined) rr[`${v}.${pk}`] = scalar
      }
      // …and, for the façade's `prop:` namespace, under the BARE name every query actually asks for.
      // Projecting only the raw key meant `n.price` was never a key, so RETURN silently rendered the
      // node id and WHERE silently dropped every row. The façade namespace wins a name collision.
      for (const [pk, pv] of Object.entries(atom.values)) {
        if (pv.kind === 'link' || !pk.startsWith(PROP_NS)) continue
        const scalar = pv.value[0]
        if (scalar !== undefined) rr[`${v}.${pk.slice(PROP_NS.length)}`] = scalar
      }
    }
    // edge-var TruthValue projection (single fixed edges)
    for (const spec of edgeVarSpecs) {
      const tv = edgeTv(as, spec, g)
      if (tv) { rr[`${spec.var}.strength`] = tv.strength; rr[`${spec.var}.confidence`] = tv.confidence }
    }
    const rowKey = JSON.stringify(rr)
    if (!seen.has(rowKey)) { seen.add(rowKey); resolved.push(rr) }
    return !streamable || resolved.length < rowBudget
  }

  // Slots are per NODE POSITION, but two positions may name the SAME variable
  // (`MATCH (a:X) MATCH (a:Y)`), so resolve per VARIABLE: every label declared for it must hold, and
  // two different identity pins on one variable are unsatisfiable.
  const byVar = new Map<string, { labels: string[]; pins: Set<Handle> }>()
  for (const s of slots) {
    let e = byVar.get(s.irVar)
    if (!e) { e = { labels: [], pins: new Set() }; byVar.set(s.irVar, e) }
    if (s.label !== undefined) e.labels.push(s.label)
    if (s.pinnedHandle !== undefined) e.pins.add(s.pinnedHandle)
  }

  for (const pattern of patterns) {
    const res = findMatches(as, pattern)
    const clauseBound = new Set(res.variables)
    // What the clauses could not settle: an identity pin is a CONSTANT in the IR, so its variable is
    // never bound (bind it here, and drop the pattern when the pinned atom does not exist); a node
    // position no clause binds at all must be SCANNED — that is the `MATCH (n:Label)` case which
    // compiled to zero clauses and which the matcher then satisfied with one empty binding.
    let groundings: Grounding[] = res.groundings
    const scanVars: { irVar: string; labels: string[] }[] = []
    for (const [irVar, e] of byVar) {
      const pin = e.pins.size === 1 ? e.pins.values().next().value as Handle : undefined
      if (e.pins.size > 1 || (pin !== undefined && !as.getAtom(pin))) { groundings = []; break }
      if (pin !== undefined) groundings = groundings.map((g) => { const n = cloneDict(g); n[irVar] = pin; return n })
      else if (!clauseBound.has(irVar)) { scanVars.push({ irVar, labels: e.labels }); continue }
      for (const label of e.labels) groundings = groundings.filter((g) => atomMatchesLabel(as, as.getAtom(g[irVar]!), label))
    }
    const candidates = scanVars.map((v) => {
      let c = scanCandidates(as, v.labels[0])
      for (const label of v.labels.slice(1)) c = c.filter((h) => atomMatchesLabel(as, as.getAtom(h), label))
      return c
    })
    const walk = (i: number, g: Grounding): boolean => {
      if (i === scanVars.length) return emit(g)
      for (const h of candidates[i]!) {
        if (++scanned > maxScan) {
          throw new Error(`Cypher: node scan exceeded maxScan ${maxScan} candidates — narrow the pattern with a ` +
            `label, a form pin or an edge, or raise maxScan (Sentinel bounded-traversal policy)`)
        }
        const next = cloneDict(g)
        next[scanVars[i]!.irVar] = h
        if (!walk(i + 1, next)) return false
      }
      return true
    }
    let more = true
    for (const g of groundings) { if (!walk(0, g)) { more = false; break } }
    if (!more) break
  }

  // Anti-silent-wrong: node properties ARE projected above, so a real property filters correctly. But a
  // predicate on a property that exists on NO matched node would silently drop every row (0 results when the
  // true answer is non-empty). Detect that — across BOTH the flat filters and the boolean `where` tree — and
  // THROW rather than return a wrong empty set.
  if (resolved.length > 0) {
    const refs = [...ast.filters.map((f) => f.lhs), ...cmpLeaves(ast.where).map((c) => c.lhs)]
    for (const lhs of refs) {
      if (!resolved.some((r) => refValue(r, lhs) !== undefined)) {
        throw new Error(`Cypher unsupported: WHERE on node property '${lhs.var}.${lhs.prop}' — no matched node ` +
          `carries that property (refusing a silently-wrong empty result)`)
      }
    }
  }
  const evalW = (e: WExpr, r: RRow): boolean => {
    switch (e.t) {
      case 'cmp': return cmp(refValue(r, e.lhs), e.op, e.rhs)
      case 'and': return evalW(e.l, r) && evalW(e.r, r)
      case 'or': return evalW(e.l, r) || evalW(e.r, r)
      case 'not': return !evalW(e.e, r)
    }
  }
  // Both lists always apply: `filters` also carries inline `{prop: value}` predicates, which an
  // OR/NOT `where` tree must not shadow.
  let rows = resolved.filter((r) => ast.filters.every((f) => cmp(refValue(r, f.lhs), f.op, f.rhs)))
  if (ast.where) rows = rows.filter((r) => evalW(ast.where as WExpr, r))

  // ORDER BY
  if (ast.orderBy.length) {
    rows = [...rows].sort((a, b) => {
      for (const { ref, desc } of ast.orderBy) {
        const c = compareVal(refValue(a, ref), refValue(b, ref))
        if (c !== 0) return desc ? -c : c
      }
      return 0
    })
  }

  // Projection + stringify
  const outRefs: { col: string; ref: ColRef }[] = ast.ret === '*'
    ? Array.from(new Set(resolved.flatMap((r) => Object.keys(r)).filter((k) => !k.includes('.'))))
        .map((c) => ({ col: c, ref: { var: c } }))
    : ast.ret.map((c) => ({ col: c.prop ? `${c.var}.${c.prop}` : c.var, ref: c }))
  const outCols = outRefs.map((c) => c.col)
  // Column names are query-derived (RETURN aliases). Materialize via toPlainRow so a hostile
  // name lands as an own data property instead of hitting the inherited __proto__ setter and
  // leaving a DECLARED column missing from every row.
  let outRows = rows.map((r) =>
    toPlainRow(outRefs.map(({ col, ref }) => {
      const v = refValue(r, ref)
      return [col, v === undefined ? '' : String(v)] as const
    })),
  )

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
