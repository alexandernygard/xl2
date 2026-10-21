import type { WorkbookModel } from "./engine"

// Help for writing cell formulas: what each function does and takes, and what
// fits at the caret (function calls, argument hints, completions). The grid's
// cell editor and the formula bar share this.

export type FunctionCategory = "Math" | "Statistics" | "Logic" | "Lookup" | "Text" | "Date" | "Finance"

export interface FunctionDoc {
  name: string
  category: FunctionCategory
  /** Argument names; optional ones in [brackets], repeating ones end in "…". */
  args: string[]
  description: string
  example: string
}

const fn = (name: string, category: FunctionCategory, args: string[], description: string, example: string): FunctionDoc => ({
  name,
  category,
  args,
  description,
  example,
})

export const FUNCTION_DOCS: FunctionDoc[] = [
  fn("SUM", "Math", ["values…"], "Adds numbers and ranges.", "=SUM(B2:B9)"),
  fn("PRODUCT", "Math", ["values…"], "Multiplies numbers and ranges.", "=PRODUCT(B2:B4)"),
  fn("ROUND", "Math", ["value", "[digits]"], "Rounds to a number of decimals.", "=ROUND(B2, 2)"),
  fn("ROUNDUP", "Math", ["value", "[digits]"], "Rounds away from zero.", "=ROUNDUP(B2)"),
  fn("ROUNDDOWN", "Math", ["value", "[digits]"], "Rounds toward zero.", "=ROUNDDOWN(B2, 1)"),
  fn("ABS", "Math", ["value"], "The value without its sign.", "=ABS(B2 - C2)"),
  fn("SQRT", "Math", ["value"], "Square root.", "=SQRT(B2)"),
  fn("POWER", "Math", ["value", "power"], "Raises a value to a power.", "=POWER(1 + B1, 5)"),
  fn("MOD", "Math", ["value", "divisor"], "Remainder after division.", "=MOD(B2, 7)"),
  fn("AVERAGE", "Statistics", ["values…"], "Mean of the numbers.", "=AVERAGE(B2:B9)"),
  fn("MEDIAN", "Statistics", ["values…"], "Middle value of the numbers.", "=MEDIAN(B2:B9)"),
  fn("MIN", "Statistics", ["values…"], "Smallest number.", "=MIN(B2:B9)"),
  fn("MAX", "Statistics", ["values…"], "Largest number.", "=MAX(B2:B9)"),
  fn("COUNT", "Statistics", ["values…"], "How many cells hold numbers.", "=COUNT(B2:B9)"),
  fn("COUNTA", "Statistics", ["values…"], "How many cells aren't empty.", "=COUNTA(A2:A9)"),
  fn("SUMIF", "Statistics", ["range", "criteria", "[sumRange]"], "Adds the cells that match a criteria, like \">10\" or \"North\".", '=SUMIF(A2:A9, "North", C2:C9)'),
  fn("COUNTIF", "Statistics", ["range", "criteria"], "Counts the cells that match a criteria.", '=COUNTIF(B2:B9, ">100")'),
  fn("AVERAGEIF", "Statistics", ["range", "criteria", "[averageRange]"], "Averages the cells that match a criteria.", '=AVERAGEIF(A2:A9, "North", C2:C9)'),
  fn("IF", "Logic", ["condition", "then", "[otherwise]"], "One value when the condition is true, another when it isn't.", '=IF(B2 > 100, "High", "Low")'),
  fn("IFERROR", "Logic", ["value", "fallback"], "The value, or the fallback if it's an error.", "=IFERROR(B2 / C2, 0)"),
  fn("AND", "Logic", ["conditions…"], "True when every condition is true.", "=AND(B2 > 0, C2 > 0)"),
  fn("OR", "Logic", ["conditions…"], "True when any condition is true.", '=OR(A2 == "N", A2 == "S")'),
  fn("NOT", "Logic", ["condition"], "Flips true and false.", "=NOT(B2)"),
  fn("XLOOKUP", "Lookup", ["value", "lookupRange", "resultRange", "[notFound]"], "Finds a value in one range and returns the matching cell of another.", '=XLOOKUP("Ada", A2:A9, B2:B9)'),
  fn("CONCAT", "Text", ["values…"], "Joins text together.", '=CONCAT(A2, " ", B2)'),
  fn("LEN", "Text", ["text"], "Number of characters.", "=LEN(A2)"),
  fn("UPPER", "Text", ["text"], "Text in capitals.", "=UPPER(A2)"),
  fn("LOWER", "Text", ["text"], "Text in lower case.", "=LOWER(A2)"),
  fn("TRIM", "Text", ["text"], "Text without surrounding spaces.", "=TRIM(A2)"),
  fn("TODAY", "Date", [], "Today's date.", "=TODAY()"),
  fn("DATE", "Date", ["year", "month", "day"], "A date from its parts.", "=DATE(2026, 1, 31)"),
  fn("YEAR", "Date", ["date"], "Year of a date.", "=YEAR(A2)"),
  fn("MONTH", "Date", ["date"], "Month of a date, 1–12.", "=MONTH(A2)"),
  fn("DAY", "Date", ["date"], "Day of the month.", "=DAY(A2)"),
  fn("EOMONTH", "Date", ["date", "[months]"], "Last day of the month, some months away.", "=EOMONTH(A2, 1)"),
  fn("DAYS", "Date", ["end", "start"], "Days between two dates.", "=DAYS(B2, A2)"),
  fn("PMT", "Finance", ["rate", "periods", "presentValue", "[futureValue]", "[type]"], "Payment per period for a loan.", "=PMT(B1 / 12, 360, -B2)"),
  fn("FV", "Finance", ["rate", "periods", "payment", "[presentValue]"], "Future value of regular payments.", "=FV(B1, 10, -100)"),
  fn("NPV", "Finance", ["rate", "cashflows…"], "Net present value of future cash flows.", "=NPV(B1, C2:C9)"),
  fn("IRR", "Finance", ["cashflows", "[guess]"], "Internal rate of return.", "=IRR(B2:B9)"),
]

export const FUNCTION_CATEGORIES: FunctionCategory[] = ["Math", "Statistics", "Logic", "Lookup", "Text", "Date", "Finance"]

const DOCS = new Map(FUNCTION_DOCS.map((d) => [d.name, d]))
export const functionDoc = (name: string): FunctionDoc | undefined => DOCS.get(name.toUpperCase())

export interface OperatorDoc {
  /** What gets inserted. */
  op: string
  /** How it shows on a chip. */
  label: string
  description: string
}

export const OPERATOR_DOCS: OperatorDoc[] = [
  { op: " + ", label: "+", description: "Add" },
  { op: " - ", label: "−", description: "Subtract" },
  { op: " * ", label: "×", description: "Multiply" },
  { op: " / ", label: "÷", description: "Divide" },
  { op: " ** ", label: "^", description: "Power" },
  { op: "(", label: "( )", description: "Group" },
  { op: " == ", label: "=", description: "Equal to" },
  { op: " <> ", label: "≠", description: "Not equal to" },
  { op: " > ", label: ">", description: "Greater than" },
  { op: " < ", label: "<", description: "Less than" },
  { op: " >= ", label: "≥", description: "At least" },
  { op: " <= ", label: "≤", description: "At most" },
  { op: " && ", label: "and", description: "Both true" },
  { op: " || ", label: "or", description: "Either true" },
  { op: ":", label: ":", description: "Range, as in B2:B9" },
]

/** Methods on a table's rows, as in `=sales.sum("units")`. */
export const ROWS_METHODS: { name: string; args: string[]; description: string; column?: boolean }[] = [
  { name: "sum", args: ["column"], description: "Total of a column.", column: true },
  { name: "avg", args: ["column"], description: "Average of a column.", column: true },
  { name: "min", args: ["column"], description: "Smallest value in a column.", column: true },
  { name: "max", args: ["column"], description: "Largest value in a column.", column: true },
  { name: "count", args: ["[column]"], description: "Number of rows (with a value in the column).", column: true },
  { name: "column", args: ["column"], description: "A column's values as a list.", column: true },
  { name: "lookup", args: ["keyColumn", "value", "[returnColumn]"], description: "The first row whose key column equals the value.", column: true },
  { name: "length", args: [], description: "Number of rows." },
]

/** Tables (and queries) and params a formula can name. */
export interface FormulaNames {
  tables: { name: string; columns: { key: string; label: string }[] }[]
  params: { name: string; label: string }[]
}

export function formulaNames(model: WorkbookModel | null | undefined): FormulaNames {
  const names: FormulaNames = { tables: [], params: [] }
  for (const s of model?.sheets ?? [])
    for (const b of s.blocks) {
      if (b.type === "table") names.tables.push({ name: b.name, columns: b.columns.map((c) => ({ key: c.key, label: c.label })) })
      else if (b.type === "param") names.params.push({ name: b.name, label: b.label })
    }
  return names
}

export interface FormulaCall {
  /** Function or method name, e.g. "SUM" or "sum". */
  name: string
  /** Set for a method call: the name before the dot. */
  object?: string
  /** 0-based index of the argument the caret is in. */
  argIndex: number
}

export interface FormulaCaret {
  /** The innermost call whose parentheses hold the caret. */
  call: FormulaCall | null
  /** Inside a string literal. */
  inString: boolean
  /** The word being typed: text from `start` to the caret. */
  word: { start: number; text: string; object?: string }
  /** A click on a cell would insert a reference here (after "=", an operator, "(" or ","). */
  canPoint: boolean
}

const IDENT = /[\w$]/

/** What surrounds the caret in a formula ("=..." text). */
export function formulaCaret(text: string, caret: number): FormulaCaret {
  const stack: (FormulaCall | null)[] = []
  let quote: string | null = null
  let quoteAt = -1
  for (let i = 0; i < caret; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "`" || (ch === "'" && !isSheetQuote(text, i))) {
      quote = ch
      quoteAt = i
    } else if (ch === "(") {
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i))
      const obj = m ? /([A-Za-z_$][\w$]*)\.$/.exec(text.slice(0, m.index)) : null
      stack.push(m ? { name: m[1], object: obj?.[1], argIndex: 0 } : null)
    } else if (ch === ")") stack.pop()
    else if (ch === "," && stack.length) {
      const top = stack[stack.length - 1]
      if (top) top.argIndex++
    }
  }
  const call = [...stack].reverse().find((c) => c !== null) ?? null
  const inner = stack[stack.length - 1] ?? null
  if (quote) return { call: inner ?? call, inString: true, word: { start: quoteAt + 1, text: text.slice(quoteAt + 1, caret) }, canPoint: false }
  let start = caret
  while (start > 0 && IDENT.test(text[start - 1])) start--
  const object = text[start - 1] === "." ? /([A-Za-z_$][\w$]*)$/.exec(text.slice(0, start - 1))?.[1] : undefined
  const before = text.slice(0, caret)
  const canPoint = text.startsWith("=") && /(^=|[+\-*/(,<>&^:=|!?]|\s)$/.test(before)
  return { call, inString: false, word: { start, text: text.slice(start, caret), object }, canPoint }
}

// 'My sheet'!A1 is a reference, not a string
function isSheetQuote(text: string, i: number) {
  const m = /^'((?:[^']|'')+)'!/.exec(text.slice(i))
  return !!m
}

export interface FormulaSuggestion {
  label: string
  kind: "function" | "table" | "param" | "method" | "column"
  detail: string
  /** Replaces text from `from` to the caret. */
  insert: string
  from: number
}

/** Completions for the word at the caret. Empty when nothing fits or the word is a cell address. */
export function formulaSuggestions(text: string, caret: number, names: FormulaNames): FormulaSuggestion[] {
  if (!text.startsWith("=")) return []
  const at = formulaCaret(text, caret)
  const w = at.word
  const q = w.text.toLowerCase()
  const rank = <T extends { label: string }>(items: T[]) =>
    items
      .filter((s) => s.label.toLowerCase().includes(q))
      .sort((a, b) => Number(!b.label.toLowerCase().startsWith(q)) - Number(!a.label.toLowerCase().startsWith(q)))
      .slice(0, 8)

  if (at.inString) {
    // a column key inside sales.sum("…")
    const c = at.call
    const t = c?.object ? names.tables.find((x) => x.name === c.object) : undefined
    const m = ROWS_METHODS.find((x) => x.name === c?.name)
    if (!t || !m?.column || (c!.name === "lookup" && c!.argIndex === 1)) return []
    const quote = text[w.start - 1]
    const closes = text[caret] === quote
    return rank(t.columns.map((col) => ({ label: col.key, kind: "column" as const, detail: col.label, insert: closes ? col.key : col.key + quote, from: w.start })))
  }
  if (w.object) {
    if (!names.tables.some((x) => x.name === w.object)) return []
    return rank(
      ROWS_METHODS.map((m) => ({
        label: m.name,
        kind: "method" as const,
        detail: m.description,
        insert: m.args.length ? `${m.name}("` : m.name,
        from: w.start,
      })),
    )
  }
  if (!q || /^\$?[a-z]{1,3}\$?\d+$/i.test(w.text) || /\d/.test(w.text[0])) return []
  return rank([
    ...FUNCTION_DOCS.map((d) => ({ label: d.name, kind: "function" as const, detail: d.description, insert: `${d.name}(`, from: w.start })),
    ...names.tables.map((t) => ({ label: t.name, kind: "table" as const, detail: `Table · ${t.columns.length} columns`, insert: `${t.name}.`, from: w.start })),
    ...names.params.map((p) => ({ label: p.name, kind: "param" as const, detail: `Input · ${p.label}`, insert: p.name, from: w.start })),
  ])
}

/** Signature text for a call's hint, with the current argument marked. */
export function callSignature(call: FormulaCall): { name: string; args: string[]; active: number; description: string } | null {
  if (call.object) {
    const m = ROWS_METHODS.find((x) => x.name === call.name)
    return m ? { name: `${call.object}.${m.name}`, args: m.args, active: call.argIndex, description: m.description } : null
  }
  const d = functionDoc(call.name)
  if (!d) return null
  const last = d.args.length - 1
  // repeating last argument: every later comma stays on it
  const active = last >= 0 && d.args[last].endsWith("…") ? Math.min(call.argIndex, last) : call.argIndex
  return { name: d.name, args: d.args, active, description: d.description }
}
