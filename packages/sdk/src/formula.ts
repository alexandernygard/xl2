import { colIndex, colName } from "./address"

// Cell formulas: "=SUM(B2:B9) * growth". A formula is a JavaScript expression
// where A1 references (B3, $B$3, B2:B9, Sheet2!A1, 'My sheet'!A1:B4) are
// rewritten to lookups. Functions like SUM, IF and PMT, plus table and param
// names, are in scope. `<>` is accepted as "not equal" for Excel habits.

const REF =
  /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][\w]*))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/
const IDENT = /[\w$.]/

export interface FormulaRef {
  sheet?: string
  from: string
  to?: string
}

/** Rewrite references to __ref("Sheet","B3") / __range("Sheet","B2","B9") calls. */
export function translateFormula(expr: string): { js: string; refs: FormulaRef[] } {
  const refs: FormulaRef[] = []
  const out = mapRefs(expr, (ref) => {
    refs.push(ref)
    const s = ref.sheet === undefined ? "null" : JSON.stringify(ref.sheet)
    return ref.to ? `__range(${s},"${ref.from}","${ref.to}")` : `__ref(${s},"${ref.from}")`
  }, true)
  return { js: lazyIfError(out), refs }
}

/** Shift relative references (not $-anchored parts), as when copying "=B2*2" one row down. */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  const shift = (a: string) => {
    const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/.exec(a)!
    const col = m[1] ? colIndex(m[2]) : colIndex(m[2]) + dCol
    const row = m[3] ? +m[4] - 1 : +m[4] - 1 + dRow
    if (col < 0 || row < 0) return "#REF"
    return `${m[1]}${colName(col)}${m[3]}${row + 1}`
  }
  return mapRefs(formula, (ref, raw) => {
    const prefix = raw.slice(0, raw.length - ref.raw.length)
    const [a, b] = ref.raw.split(":")
    return prefix + shift(a) + (b ? ":" + shift(b) : "")
  }, false)
}

interface MatchedRef extends FormulaRef {
  /** The A1 part as written, with $ signs: "$B$2:B9". */
  raw: string
}

function mapRefs(expr: string, fn: (ref: MatchedRef, text: string) => string, rewriteNe: boolean): string {
  let out = ""
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    // a quoted sheet name is a reference, not a string
    const m = (ch === "'" || /[A-Za-z_$]/.test(ch)) && !(i > 0 && IDENT.test(expr[i - 1])) ? REF.exec(expr.slice(i)) : null
    if (m && !/[\w(]/.test(expr[i + m[0].length] ?? "")) {
      const sheet = m[1]?.replace(/''/g, "'") ?? m[2]
      const from = m[3].replace(/\$/g, "")
      const to = m[4]?.replace(/\$/g, "")
      const raw = m[4] ? `${m[3]}:${m[4]}` : m[3]
      out += fn({ sheet, from, to, raw }, m[0])
      i += m[0].length
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1
      while (j < expr.length && expr[j] !== ch) j += expr[j] === "\\" ? 2 : 1
      out += expr.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (rewriteNe && ch === "<" && expr[i + 1] === ">") {
      out += "!="
      i += 2
      continue
    }
    // copy identifiers whole so "AB12" inside "XAB12" isn't treated as a ref
    if (/[\w$]/.test(ch)) {
      let j = i
      while (j < expr.length && /[\w$]/.test(expr[j])) j++
      out += expr.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

// IFERROR(x, y) must see x's error, so x becomes a thunk.
function lazyIfError(js: string): string {
  const key = "IFERROR("
  let at = js.indexOf(key)
  while (at >= 0 && !(at > 0 && /[\w$.]/.test(js[at - 1]))) {
    let depth = 0
    let j = at + key.length
    for (; j < js.length; j++) {
      const c = js[j]
      if (c === '"' || c === "'" || c === "`") {
        const q = c
        j++
        while (j < js.length && js[j] !== q) j += js[j] === "\\" ? 2 : 1
        continue
      }
      if (c === "(" || c === "[" || c === "{") depth++
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break
        depth--
      } else if (c === "," && depth === 0) break
    }
    const start = at + key.length
    js = `${js.slice(0, start)}() => (${js.slice(start, j)})${js.slice(j)}`
    at = js.indexOf(key, start)
  }
  return js
}

export type CompiledFormula = (scope: object) => unknown

const compiled = new Map<string, CompiledFormula>()

/** Compile once per distinct formula text. Scope lookups go through a `with` proxy. */
export function compileFormula(formula: string): CompiledFormula {
  const hit = compiled.get(formula)
  if (hit) return hit
  const body = formula.replace(/^=/, "")
  const { js } = translateFormula(body)
  let fn: CompiledFormula
  try {
    // non-strict on purpose: `with` resolves names lazily via the scope proxy
    fn = new Function("__scope", `with (__scope) { return (${js}\n) }`) as CompiledFormula
  } catch (e: any) {
    const err = new Error(`#SYNTAX: ${e?.message ?? e}`)
    fn = () => {
      throw err
    }
  }
  if (compiled.size > 5000) compiled.clear()
  compiled.set(formula, fn)
  return fn
}

export const isFormula = (v: unknown): v is string => typeof v === "string" && v.startsWith("=") && v.length > 1
