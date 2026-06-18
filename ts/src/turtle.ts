/**
 * Minimal Turtle 1.1 parser — enough to load SHACL shape files.
 *
 * Handles: @prefix / @base / PREFIX / BASE directives; subject-predicate-object
 * triples with `;` and `,` shorthand; blank-node property lists `[ ... ]`;
 * RDF collections `( item... )`; long strings `"""..."""`; `^^` datatype
 * annotations; `@lang` language tags; numeric and boolean literals; `a` shorthand.
 *
 * Intentionally does NOT implement full IRI resolution, graph names, or the
 * complete PN_LOCAL character class — this is for internal use on trusted
 * shape files from the ontogenesis ecosystem.
 */

export type RdfTerm = IriTerm | BNodeTerm | LiteralTerm

export interface IriTerm    { kind: 'iri';     value: string }
export interface BNodeTerm  { kind: 'bnode';   value: string }
export interface LiteralTerm { kind: 'literal'; value: string; datatype: string; language?: string }

export interface RdfTriple { s: RdfTerm; p: IriTerm; o: RdfTerm }

const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const XSD  = 'http://www.w3.org/2001/XMLSchema#'

const RDF_TYPE  = RDF + 'type'
const RDF_FIRST = RDF + 'first'
const RDF_REST  = RDF + 'rest'
const RDF_NIL   = RDF + 'nil'
const XSD_STRING  = XSD + 'string'
const XSD_INTEGER = XSD + 'integer'
const XSD_DECIMAL = XSD + 'decimal'
const XSD_BOOLEAN = XSD + 'boolean'

export function parseTurtle(text: string, baseUri = ''): RdfTriple[] {
  return new TurtleParser(text, baseUri).parse()
}

class TurtleParser {
  private pos = 0
  private bnodeSeq = 0
  private triples: RdfTriple[] = []
  private prefixes: Record<string, string> = {
    rdf:  RDF,
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd:  XSD,
    owl:  'http://www.w3.org/2002/07/owl#',
    sh:   'http://www.w3.org/ns/shacl#',
  }

  constructor(private text: string, private base: string) {}

  // ─── Public ─────────────────────────────────────────────────────────────────

  parse(): RdfTriple[] {
    this.ws()
    while (this.pos < this.text.length) {
      try {
        this.statement()
      } catch {
        // Skip to next '.' to recover from unknown syntax
        const dot = this.text.indexOf('.', this.pos)
        if (dot === -1) break
        this.pos = dot + 1
      }
      this.ws()
    }
    return this.triples
  }

  // ─── Whitespace / comments ────────────────────────────────────────────────

  private ws(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++
      } else {
        break
      }
    }
  }

  private ch(): string  { return this.text[this.pos] ?? '' }
  private peek(n: number): string { return this.text.slice(this.pos, this.pos + n) }

  private eat(s: string): boolean {
    if (this.text.startsWith(s, this.pos)) { this.pos += s.length; return true }
    return false
  }
  private need(s: string): void {
    if (!this.eat(s)) throw new Error(`Expected "${s}" at ${this.pos}, got "${this.peek(10)}"`)
  }

  // ─── Directives ──────────────────────────────────────────────────────────

  private statement(): void {
    const low = this.peek(8).toLowerCase()
    if (low.startsWith('@prefix')) {
      this.pos += 7; this.ws()
      const pfx = this.prefixLabel(); this.need(':'); this.ws()
      const iri = this.resolveIri(this.iriRef()); this.ws(); this.need('.')
      this.prefixes[pfx] = iri
    } else if (low.startsWith('@base')) {
      this.pos += 5; this.ws()
      this.base = this.resolveIri(this.iriRef()); this.ws(); this.need('.')
    } else if (low.startsWith('prefix')) {
      this.pos += 6; this.ws()
      const pfx = this.prefixLabel(); this.need(':'); this.ws()
      this.prefixes[pfx] = this.resolveIri(this.iriRef())
    } else if (low.startsWith('base')) {
      this.pos += 4; this.ws()
      this.base = this.resolveIri(this.iriRef())
    } else {
      const subj = this.subject()
      this.ws()
      this.predicateObjectList(subj)
      this.ws()
      this.need('.')
    }
  }

  private prefixLabel(): string {
    let s = ''
    while (this.pos < this.text.length && this.ch() !== ':' && this.ch() !== ' ' && this.ch() !== '\t') {
      s += this.text[this.pos++]
    }
    return s
  }

  private iriRef(): string {
    this.need('<')
    let s = ''
    while (this.pos < this.text.length && this.ch() !== '>') s += this.text[this.pos++]
    this.need('>')
    return s
  }

  private resolveIri(iri: string): string {
    if (!iri || iri.includes('://')) return iri
    if (iri.startsWith('#')) return (this.base || '') + iri
    if (iri.startsWith('/')) {
      const m = this.base.match(/^(https?:\/\/[^/]+)/)
      return m ? m[1] + iri : iri
    }
    const dir = this.base.replace(/[^/]*$/, '')
    return dir + iri
  }

  // ─── Terms ────────────────────────────────────────────────────────────────

  private newBnode(): BNodeTerm { return { kind: 'bnode', value: `_:b${this.bnodeSeq++}` } }

  private subject(): RdfTerm  { return this.termFull(true) }
  private object(): RdfTerm   { return this.termFull(false) }

  private predicate(): IriTerm {
    this.ws()
    if (this.ch() === 'a' && /[\s;,.)\]]/.test(this.text[this.pos + 1] ?? '')) {
      this.pos++; return { kind: 'iri', value: RDF_TYPE }
    }
    const t = this.termFull(false)
    if (t.kind !== 'iri') throw new Error(`Predicate must be IRI at pos ${this.pos}`)
    return t as IriTerm
  }

  private termFull(isSubject: boolean): RdfTerm {
    this.ws()
    const c = this.ch()
    if (c === '<') return { kind: 'iri', value: this.resolveIri(this.iriRef()) }
    if (c === '[') return this.bnodePropertyList()
    if (c === '(') return this.collection()
    if (c === '_' && this.text[this.pos + 1] === ':') {
      this.pos += 2; return { kind: 'bnode', value: '_:' + this.name() }
    }
    if (c === '"' || c === "'") return this.literal()
    // true / false
    if (this.peek(4) === 'true'  && /\W/.test(this.text[this.pos + 4] ?? '')) { this.pos += 4; return { kind: 'literal', value: 'true',  datatype: XSD_BOOLEAN } }
    if (this.peek(5) === 'false' && /\W/.test(this.text[this.pos + 5] ?? '')) { this.pos += 5; return { kind: 'literal', value: 'false', datatype: XSD_BOOLEAN } }
    // numeric
    const numM = this.text.slice(this.pos).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (numM) {
      const v = numM[0]; this.pos += v.length
      return { kind: 'literal', value: v, datatype: v.includes('.') ? XSD_DECIMAL : XSD_INTEGER }
    }
    // 'a' shorthand (subject position also valid)
    if (isSubject && c === 'a' && /[\s\t\n\r]/.test(this.text[this.pos + 1] ?? '')) {
      this.pos++; return { kind: 'iri', value: RDF_TYPE }
    }
    // prefixed name
    return this.prefixedName()
  }

  private prefixedName(): IriTerm {
    let pfx = ''
    while (this.pos < this.text.length && /[A-Za-z0-9_\-À-￿]/.test(this.ch())) pfx += this.text[this.pos++]
    this.need(':')
    let local = ''
    // local part: allow almost everything until whitespace or punctuation
    while (this.pos < this.text.length && !/[\s;,.\[\]()"']/.test(this.ch())) local += this.text[this.pos++]
    const base = this.prefixes[pfx]
    if (!base) throw new Error(`Unknown prefix "${pfx}:" at pos ${this.pos}`)
    return { kind: 'iri', value: base + local }
  }

  private literal(): LiteralTerm {
    const q = this.ch()
    let value = ''
    if (this.peek(3) === q.repeat(3)) {
      // Long string
      this.pos += 3
      while (this.pos < this.text.length) {
        if (this.peek(3) === q.repeat(3)) { this.pos += 3; break }
        value += this.ch() === '\\' ? (this.pos++, this.escape()) : this.text[this.pos++]
      }
    } else {
      this.pos++
      while (this.pos < this.text.length && this.ch() !== q) {
        value += this.ch() === '\\' ? (this.pos++, this.escape()) : this.text[this.pos++]
      }
      if (this.ch() === q) this.pos++
    }
    if (this.ch() === '@') {
      this.pos++; let lang = ''
      while (/[a-zA-Z0-9-]/.test(this.ch())) lang += this.text[this.pos++]
      return { kind: 'literal', value, datatype: RDF + 'langString', language: lang }
    }
    if (this.peek(2) === '^^') {
      this.pos += 2
      const dt = this.ch() === '<'
        ? { kind: 'iri' as const, value: this.resolveIri(this.iriRef()) }
        : this.prefixedName()
      return { kind: 'literal', value, datatype: dt.value }
    }
    return { kind: 'literal', value, datatype: XSD_STRING }
  }

  private escape(): string {
    const c = this.text[this.pos++] ?? ''
    return ({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '/': '/' } as Record<string,string>)[c] ?? c
  }

  private name(): string {
    let s = ''
    while (/[A-Za-z0-9_\-.À-￿]/.test(this.ch())) s += this.text[this.pos++]
    return s
  }

  // ─── Blank-node property list ─────────────────────────────────────────────

  private bnodePropertyList(): BNodeTerm {
    this.need('['); this.ws()
    const bn = this.newBnode()
    if (this.ch() !== ']') this.predicateObjectList(bn)
    this.ws(); this.need(']')
    return bn
  }

  // ─── RDF collection ───────────────────────────────────────────────────────

  private collection(): RdfTerm {
    this.need('('); this.ws()
    if (this.ch() === ')') { this.pos++; return { kind: 'iri', value: RDF_NIL } }
    const head = this.newBnode()
    let cur: RdfTerm = head
    let first = true
    while (this.ch() && this.ch() !== ')') {
      if (!first) {
        const next = this.newBnode()
        this.triples.push({ s: cur, p: { kind: 'iri', value: RDF_REST }, o: next })
        cur = next
      }
      const item = this.object()
      this.triples.push({ s: cur, p: { kind: 'iri', value: RDF_FIRST }, o: item })
      first = false
      this.ws()
    }
    this.triples.push({ s: cur, p: { kind: 'iri', value: RDF_REST }, o: { kind: 'iri', value: RDF_NIL } })
    this.need(')')
    return head
  }

  // ─── Predicate-object list ────────────────────────────────────────────────

  private predicateObjectList(subj: RdfTerm): void {
    while (true) {
      this.ws()
      const c = this.ch()
      if (!c || c === '.' || c === ']' || c === ')') break
      const pred = this.predicate()
      this.ws()
      this.objectList(subj, pred)
      this.ws()
      if (this.ch() === ';') { this.pos++; continue }
      break
    }
  }

  private objectList(subj: RdfTerm, pred: IriTerm): void {
    const obj = this.object()
    this.triples.push({ s: subj, p: pred, o: obj })
    this.ws()
    while (this.ch() === ',') {
      this.pos++; this.ws()
      const obj2 = this.object()
      this.triples.push({ s: subj, p: pred, o: obj2 })
      this.ws()
    }
  }
}
