import { AtomSpace, type Atom, type Handle, type TruthValue } from './atomspace'

/**
 * Atomese codec — lossless s-expression serialization compatible with OpenCog's
 * AtomSpace text format. This is the foundation for first-class OpenCog interop:
 * the same syntax is read/written by guile, the CogServer, and StorageNodes.
 *
 *   (EvaluationLink (stv 0.9 0.8)
 *     (PredicateNode "likes")
 *     (ListLink
 *       (ConceptNode "Alice")
 *       (ConceptNode "Bob")))
 *
 * Nodes:  (TypeNode "name")
 * Links:  (TypeLink <child atoms…>)
 * TruthValue: (stv <strength> <confidence>) as an optional first form.
 */

// ─── Emit ────────────────────────────────────────────────────────────────────

export function atomToSexpr(as: AtomSpace, handle: Handle, indent = 0): string {
  const atom = as.getAtom(handle)
  if (!atom) return ''
  return emit(as, atom, indent)
}

function emit(as: AtomSpace, atom: Atom, indent: number): string {
  const pad = '  '.repeat(indent)
  const tv = atom.tv ? ` (stv ${fmt(atom.tv.strength)} ${fmt(atom.tv.confidence)})` : ''
  if (atom.name !== undefined) {
    return `${pad}(${atom.type}${tv} "${escape(atom.name)}")`
  }
  const children = (atom.outgoing ?? [])
    .map((h) => { const c = as.getAtom(h); return c ? emit(as, c, indent + 1) : `${'  '.repeat(indent + 1)}; <missing ${h}>` })
    .join('\n')
  return `${pad}(${atom.type}${tv}\n${children})`
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n)
}
function escape(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') }

/** Dump the entire AtomSpace as Atomese — only top-level atoms (those with no incoming links). */
export function dumpAtomese(as: AtomSpace): string {
  const roots = as.allAtoms().filter((a) => as.getIncoming(a.handle).length === 0)
  return roots.map((a) => emit(as, a, 0)).join('\n\n')
}

// ─── Parse ─────────────────────────────────────────────────────────────────────

type SExpr = string | SForm
interface SForm { head: string; tv?: TruthValue; rest: SExpr[] }

export function parseAtomese(as: AtomSpace, text: string): Handle[] {
  const tokens = tokenize(text)
  const parser = new SParser(tokens)
  const forms: SForm[] = []
  while (parser.hasNext()) {
    const form = parser.parseForm()
    if (form && typeof form !== 'string') forms.push(form)
  }
  return forms.map((f) => materialize(as, f))
}

function tokenize(text: string): string[] {
  // Strip line comments (; …)
  const stripped = text.replace(/;[^\n]*/g, '')
  const tokens: string[] = []
  const re = /\s*("(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    if (m[1]) tokens.push(m[1])
  }
  return tokens
}

class SParser {
  private pos = 0
  constructor(private tokens: string[]) {}
  hasNext(): boolean { return this.pos < this.tokens.length }
  private peek(): string | undefined { return this.tokens[this.pos] }
  private next(): string { return this.tokens[this.pos++] }

  parseForm(): SExpr | null {
    const tok = this.next()
    if (tok === undefined) return null
    if (tok !== '(') return unquote(tok)

    const head = this.next()
    const form: SForm = { head, rest: [] }

    // optional truth value: (stv s c)
    if (this.peek() === '(' && this.tokens[this.pos + 1] === 'stv') {
      this.next() // (
      this.next() // stv
      const s = parseFloat(this.next())
      const c = parseFloat(this.next())
      this.next() // )
      form.tv = { strength: s, confidence: c }
    }

    while (this.peek() && this.peek() !== ')') {
      const child = this.parseForm()
      if (child !== null) form.rest.push(child)
    }
    this.next() // consume ')'
    return form
  }
}

function unquote(tok: string): string {
  if (tok.startsWith('"')) return tok.slice(1, -1).replace(/\\(.)/g, '$1')
  return tok
}

/** Recursively realize an s-expression form as atoms; returns the root handle. */
function materialize(as: AtomSpace, form: SForm): Handle {
  // Node: a single quoted-string child and a *Node type.
  const isNode = as.types.isNode(form.head) || /Node$/.test(form.head)
  if (isNode && form.rest.length >= 1 && typeof form.rest[0] === 'string') {
    const atom = as.addNode(form.head, form.rest[0] as string, { tv: form.tv })
    return atom.handle
  }
  // Link: children are sub-forms.
  const outgoing = form.rest.map((child) =>
    typeof child === 'string'
      ? as.addNode('ConceptNode', child).handle  // bare symbol → ConceptNode
      : materialize(as, child),
  )
  const atom = as.addLink(form.head, outgoing, { tv: form.tv })
  return atom.handle
}
