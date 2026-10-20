import { parse } from "@babel/parser"
import type {
  ArrayExpression,
  CallExpression,
  Expression,
  Node,
  ObjectExpression,
  ObjectProperty,
} from "@babel/types"
import { parseAddress } from "./address"
import { encodeCsvRow, encodeCsvValue, parseCsvRecords } from "./datafile"
import type { CellStyle, ColumnKind, Format, Literal, Override } from "./types"

// Source edits. The workbook code (plus its CSV data files) is the single
// source of truth; UI edits are expressed as intents and applied here as
// minimal text splices, so the rest of the file (formatting, comments,
// formulas) is left untouched.

/** Workbook code plus data files (name -> CSV text). */
export interface Bundle {
  source: string
  files: Record<string, string>
}

export type StylePatch = { [K in keyof CellStyle]?: CellStyle[K] | null }

export type EditIntent =
  | { type: "setCell"; table: string; row: number; column: string; value: Literal }
  /** Type over a formula cell; value undefined clears the override. */
  | { type: "setOverride"; table: string; row: number; column: string; value: Literal | undefined; note?: string }
  | { type: "setParam"; name: string; value: Literal }
  | { type: "addRow"; table: string; values?: Record<string, Literal> }
  | { type: "deleteRow"; table: string; row: number }
  | { type: "addColumn"; table: string; column: string; kind: ColumnKind; label?: string }
  | { type: "deleteColumn"; table: string; column: string }
  | { type: "setColumnFormat"; table: string; column: string; format: Format | null }
  | { type: "setColumnLabel"; table: string; column: string; label: string }
  | { type: "setTableTitle"; table: string; title: string }
  | { type: "addSheet"; name: string }
  | { type: "renameSheet"; sheet: string; name: string }
  | { type: "addBlock"; sheet: string; code: string }
  | { type: "moveBlock"; sheet: string; index: number; at: string }
  | { type: "deleteBlock"; sheet: string; index: number }
  /** A free grid cell. Strings starting with "=" are formulas; null clears the value. */
  | { type: "setFreeCell"; sheet: string; address: string; value: Literal }
  | { type: "setCellStyle"; sheet: string; address: string; style: StylePatch }
  | { type: "setWidth"; sheet: string; column: string; width: number | null }
  | { type: "addDataFile"; file: string; text: string }

export type EditResult = { ok: true; source: string } | { ok: false; error: string }
export type BundleResult = { ok: true; bundle: Bundle } | { ok: false; error: string }

export type Target =
  | { type: "cell"; table: string; row: number; column: string }
  | { type: "column"; table: string; column: string }
  | { type: "row"; table: string; row: number }
  | { type: "table"; table: string }
  | { type: "param"; name: string }
  | { type: "freeCell"; sheet: string; address: string }
  | { type: "block"; sheet: string; index: number }

export interface Range {
  start: number
  end: number
  /** Set when the range is in a data file rather than the code. */
  file?: string
}

class EditError extends Error {}

function parseSource(source: string) {
  return parse(source, { sourceType: "module", plugins: ["typescript"] })
}

function walk(node: any, visit: (n: Node) => void) {
  if (!node || typeof node.type !== "string") return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit))
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit)
  }
}

function calleeName(call: CallExpression): string | undefined {
  const c = call.callee
  if (c.type === "Identifier") return c.name
  if (c.type === "MemberExpression" && c.property.type === "Identifier") return c.property.name
  return undefined
}

function stringArg(call: CallExpression, i: number): string | undefined {
  const a = call.arguments[i]
  if (a?.type === "StringLiteral") return a.value
  if (a?.type === "TemplateLiteral" && a.expressions.length === 0) return a.quasis[0].value.cooked ?? undefined
  return undefined
}

function findCalls(ast: Node, name: string): CallExpression[] {
  const out: CallExpression[] = []
  walk(ast, (n) => {
    if (n.type === "CallExpression" && calleeName(n) === name) out.push(n)
  })
  return out
}

function findNamedCall(ast: Node, name: string, first: string, minArgs = 2): CallExpression {
  // definitions take a second argument; this skips reads like ctx.table("x")
  const hit = findCalls(ast, name).find((c) => stringArg(c, 0) === first && c.arguments.length >= minArgs)
  if (!hit) throw new EditError(`Could not find ${name}("${first}") in the code`)
  return hit
}

function propKey(p: ObjectProperty): string | undefined {
  if (p.key.type === "Identifier") return p.key.name
  if (p.key.type === "StringLiteral") return p.key.value
  return undefined
}

function getProp(obj: ObjectExpression, key: string): ObjectProperty | undefined {
  return obj.properties.find((p): p is ObjectProperty => p.type === "ObjectProperty" && propKey(p) === key)
}

function isFormulaColumn(value: Node): boolean {
  return (
    value.type === "CallExpression" &&
    value.callee.type === "MemberExpression" &&
    value.callee.property.type === "Identifier" &&
    value.callee.property.name === "formula"
  )
}

/** The JS value of a literal node, or undefined if it isn't a plain literal. */
function literalValue(n: Node | null | undefined): Literal | undefined {
  if (!n) return undefined
  switch (n.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return n.value
    case "NullLiteral":
      return null
    case "UnaryExpression":
      if (n.operator === "-" && n.argument.type === "NumericLiteral") return -n.argument.value
      return undefined
    case "TemplateLiteral":
      return n.expressions.length === 0 ? (n.quasis[0].value.cooked ?? undefined) : undefined
    default:
      return undefined
  }
}

interface TableNodes {
  call: CallExpression
  def: ObjectExpression
  columns: ObjectExpression
  rows?: ArrayExpression
  rowsProp?: ObjectProperty
  dataFile?: string
  dataColumns: string[]
}

function tableNodes(ast: Node, name: string): TableNodes {
  const call = findNamedCall(ast, "table", name)
  const def = call.arguments[1]
  if (def?.type !== "ObjectExpression") throw new EditError(`table("${name}") needs an object literal definition`)
  const colsProp = getProp(def, "columns")
  if (colsProp?.value.type !== "ObjectExpression") throw new EditError(`table("${name}") columns must be an object literal`)
  const columns = colsProp.value
  const dataColumns = columns.properties
    .filter((p): p is ObjectProperty => p.type === "ObjectProperty" && !isFormulaColumn(p.value))
    .map((p) => propKey(p)!)
  const rowsProp = getProp(def, "rows")
  let rows: ArrayExpression | undefined
  let dataFile: string | undefined
  if (rowsProp) {
    const v = rowsProp.value
    if (v.type === "CallExpression" && calleeName(v) === "data" && stringArg(v, 0)) dataFile = stringArg(v, 0)
    else if (v.type !== "ArrayExpression")
      throw new EditError(`Rows of "${name}" are generated by code, so they can't be edited in the grid`)
    else rows = v
  }
  return { call, def, columns, rows, rowsProp, dataFile, dataColumns }
}

export function literalCode(v: Literal): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null"
  return JSON.stringify(v)
}

function identOrString(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

// --- text splicing helpers -------------------------------------------------

interface Splice {
  start: number
  end: number
  text: string
}

function apply(source: string, s: Splice) {
  return source.slice(0, s.start) + s.text + source.slice(s.end)
}

function applyAll(source: string, splices: Splice[]) {
  return [...splices].sort((a, b) => b.start - a.start).reduce(apply, source)
}

function lineIndent(source: string, pos: number) {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1
  const m = /^[ \t]*/.exec(source.slice(lineStart))
  return m ? m[0] : ""
}

function isMultiline(source: string, node: Node) {
  return source.slice(node.start!, node.end!).includes("\n")
}

/** Append an item to an array/object literal, following its existing style. */
function appendItem(source: string, container: Node, items: Node[], text: string): Splice {
  const closing = container.end! - 1
  if (items.length === 0) {
    const inner = source.slice(container.start! + 1, closing)
    // keep small things on one line: {} -> { a: 1 }
    if (!inner.includes("\n") && text.length < 60 && !text.includes("\n")) {
      const open = source[container.start!] === "{" ? "{ " : "["
      const close = source[container.start!] === "{" ? " }" : "]"
      return { start: container.start!, end: container.end!, text: `${open}${text}${close}` }
    }
    const indent = lineIndent(source, container.start!)
    return { start: container.start! + 1, end: closing, text: `\n${indent}  ${text},\n${indent}` }
  }
  const last = items[items.length - 1]
  const between = source.slice(last.end!, closing)
  const hasTrailingComma = between.trimStart().startsWith(",")
  if (!isMultiline(source, container)) {
    return hasTrailingComma
      ? { start: last.end! + between.indexOf(",") + 1, end: last.end! + between.indexOf(",") + 1, text: ` ${text},` }
      : { start: last.end!, end: last.end!, text: `, ${text}` }
  }
  const indent = lineIndent(source, last.start!)
  if (hasTrailingComma) {
    const at = last.end! + between.indexOf(",") + 1
    return { start: at, end: at, text: `\n${indent}${text},` }
  }
  return { start: last.end!, end: last.end!, text: `,\n${indent}${text}` }
}

/** Remove the i-th item of a list along with its separator. */
function removeItem(source: string, items: Node[], i: number): Splice {
  const item = items[i]
  if (i < items.length - 1) return { start: item.start!, end: items[i + 1].start!, text: "" }
  if (i > 0) return { start: items[i - 1].end!, end: item.end!, text: "" }
  // only item: also drop a trailing comma and the line it was on
  const after = source.slice(item.end!)
  const m = /^\s*,/.exec(after)
  return { start: item.start!, end: item.end! + (m ? m[0].length : 0), text: "" }
}

/** Set, add or (code undefined) remove a property of an object literal. */
function setProp(source: string, obj: ObjectExpression, key: string, code: string | undefined): Splice | null {
  const props = obj.properties as Node[]
  const i = props.findIndex((p) => p.type === "ObjectProperty" && propKey(p as ObjectProperty) === key)
  if (code === undefined) return i >= 0 ? removeItem(source, props, i) : null
  if (i >= 0) {
    const v = (props[i] as ObjectProperty).value
    return { start: v.start!, end: v.end!, text: code }
  }
  return appendItem(source, obj, props, `${identOrString(key)}: ${code}`)
}

/** Set a key in the options object at argument `index` of a call, creating the object if needed. */
function setCallOption(source: string, call: CallExpression, index: number, key: string, code: string | undefined): Splice | null {
  const arg = call.arguments[index]
  if (arg?.type === "ObjectExpression") return setProp(source, arg, key, code)
  if (arg) throw new EditError("The options argument isn't an object literal")
  if (code === undefined) return null
  if (call.arguments.length !== index) throw new EditError("Can't add options to this call")
  const obj = `{ ${identOrString(key)}: ${code} }`
  if (index === 0) {
    const close = call.end! - 1
    return { start: close, end: close, text: obj }
  }
  const last = call.arguments[index - 1]
  return { start: last.end!, end: last.end!, text: `, ${obj}` }
}

// --- sheets and blocks -----------------------------------------------------

function sheetCall(ast: Node, name: string): CallExpression {
  return findNamedCall(ast, "sheet", name, 1)
}

function sheetBlocks(call: CallExpression, name: string): ArrayExpression {
  const blocks = call.arguments[1]
  if (blocks?.type !== "ArrayExpression") throw new EditError(`sheet("${name}") blocks must be an array literal`)
  return blocks
}

const BLOCK_OPTIONS_ARG: Record<string, number> = { table: 1, query: 2, metric: 2, param: 2, text: 1 }

function blockCall(ast: Node, sheet: string, index: number): { call: CallExpression; items: Node[]; optionsArg: number } {
  const items = sheetBlocks(sheetCall(ast, sheet), sheet).elements.filter(Boolean) as Node[]
  const call = items[index]
  if (!call) throw new EditError(`Sheet "${sheet}" has no block ${index + 1}`)
  if (call.type !== "CallExpression") throw new EditError(`Block ${index + 1} of "${sheet}" isn't written inline, so it can't be moved here`)
  const name = calleeName(call) ?? ""
  return { call, items, optionsArg: BLOCK_OPTIONS_ARG[name] ?? 1 }
}

/** The sheet's options object (third argument), and how to create a key in it if missing. */
function sheetOption(source: string, ast: Node, sheet: string, key: string): { obj?: ObjectExpression; create: (code: string) => Splice } {
  const call = sheetCall(ast, sheet)
  const opts = call.arguments[2]
  if (opts && opts.type !== "ObjectExpression") throw new EditError(`sheet("${sheet}") options must be an object literal`)
  const value = opts ? getProp(opts, key)?.value : undefined
  if (value && value.type !== "ObjectExpression") throw new EditError(`sheet("${sheet}") ${key} must be an object literal`)
  return {
    obj: value as ObjectExpression | undefined,
    create(code) {
      if (opts) return appendItem(source, opts, opts.properties as Node[], `${key}: ${code}`)
      const last = call.arguments[call.arguments.length - 1]
      const blocks = call.arguments.length === 1 ? ", []" : ""
      return { start: last.end!, end: last.end!, text: `${blocks}, { ${key}: ${code} }` }
    },
  }
}

function cellKey(obj: ObjectExpression, address: string): ObjectProperty | undefined {
  const want = address.toUpperCase()
  return obj.properties.find((p): p is ObjectProperty => p.type === "ObjectProperty" && propKey(p)?.toUpperCase() === want)
}

function setFreeCell(source: string, ast: Node, sheet: string, addr: string, value: Literal): Splice | null {
  const a = parseAddress(addr)
  if (!a) throw new EditError(`"${addr}" is not a cell address`)
  const key = addr.toUpperCase().replace(/\$/g, "")
  const { obj, create } = sheetOption(source, ast, sheet, "cells")
  const code = literalCode(value)
  if (!obj) return value === null ? null : create(`{ ${key}: ${code} }`)
  const prop = cellKey(obj, key)
  if (prop?.value.type === "ObjectExpression") {
    // styled cell: keep the style, change the value
    return setProp(source, prop.value, "value", code)
  }
  if (value === null) return prop ? setProp(source, obj, propKey(prop)!, undefined) : null
  if (prop) return { start: prop.value.start!, end: prop.value.end!, text: code }
  return appendItem(source, obj, obj.properties as Node[], `${key}: ${code}`)
}

function styleCode(style: StylePatch): string[] {
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${literalCode(v as Literal)}`)
}

function setCellStyle(source: string, ast: Node, sheet: string, addr: string, style: StylePatch): Splice[] {
  if (!parseAddress(addr)) throw new EditError(`"${addr}" is not a cell address`)
  const key = addr.toUpperCase().replace(/\$/g, "")
  const { obj, create } = sheetOption(source, ast, sheet, "cells")
  const fresh = styleCode(style)
  if (!obj) return fresh.length ? [create(`{ ${key}: { value: null, ${fresh.join(", ")} } }`)] : []
  const prop = cellKey(obj, key)
  if (!prop) return fresh.length ? [appendItem(source, obj, obj.properties as Node[], `${key}: { value: null, ${fresh.join(", ")} }`)] : []
  if (prop.value.type === "ObjectExpression") {
    const spec = prop.value
    const splices: Splice[] = []
    for (const [k, v] of Object.entries(style)) {
      const s = setProp(source, spec, k, v === null || v === undefined ? undefined : literalCode(v as Literal))
      if (s) splices.push(s)
    }
    // appends to the same object collide; fall back to rewriting the whole spec
    if (splices.filter((s) => s.start === s.end).length > 1 || overlapping(splices)) {
      const cur: Record<string, string> = {}
      for (const p of spec.properties) if (p.type === "ObjectProperty") cur[propKey(p)!] = source.slice(p.value.start!, p.value.end!)
      for (const [k, v] of Object.entries(style)) {
        if (v === null || v === undefined) delete cur[k]
        else cur[k] = literalCode(v as Literal)
      }
      const body = Object.entries(cur).map(([k, v]) => `${k}: ${v}`)
      return [{ start: spec.start!, end: spec.end!, text: `{ ${body.join(", ")} }` }]
    }
    return splices
  }
  if (!fresh.length) return []
  const value = source.slice(prop.value.start!, prop.value.end!)
  return [{ start: prop.value.start!, end: prop.value.end!, text: `{ value: ${value}, ${fresh.join(", ")} }` }]
}

function overlapping(splices: Splice[]) {
  const s = [...splices].sort((a, b) => a.start - b.start)
  for (let i = 1; i < s.length; i++) if (s[i].start < s[i - 1].end || s[i].start === s[i - 1].start) return true
  return false
}

// --- overrides ---------------------------------------------------------------

function readOverrides(source: string, def: ObjectExpression): Override[] | null {
  const prop = getProp(def, "overrides")
  if (!prop) return []
  if (prop.value.type !== "ArrayExpression") return null
  const out: Override[] = []
  for (const el of prop.value.elements) {
    if (el?.type !== "ObjectExpression") return null
    const row = literalValue(getProp(el, "row")?.value)
    const column = literalValue(getProp(el, "column")?.value)
    const valueNode = getProp(el, "value")?.value
    const value = literalValue(valueNode)
    const note = literalValue(getProp(el, "note")?.value)
    if (typeof row !== "number" || typeof column !== "string" || value === undefined) return null
    out.push({ row, column, value, ...(typeof note === "string" ? { note } : {}) })
  }
  void source
  return out
}

function overridesCode(list: Override[], indent: string): string {
  const item = (o: Override) =>
    `{ row: ${o.row}, column: ${JSON.stringify(o.column)}, value: ${literalCode(o.value)}${o.note ? `, note: ${JSON.stringify(o.note)}` : ""} }`
  if (list.length <= 1) return `[${list.map(item).join("")}]`
  return `[\n${list.map((o) => `${indent}  ${item(o)},`).join("\n")}\n${indent}]`
}

function writeOverrides(source: string, nodes: TableNodes, list: Override[]): Splice | null {
  const prop = getProp(nodes.def, "overrides")
  if (!list.length) return prop ? setProp(source, nodes.def, "overrides", undefined) : null
  const indent = prop ? lineIndent(source, prop.start!) : lineIndent(source, (nodes.def.properties[0] ?? nodes.def).start!)
  return setProp(source, nodes.def, "overrides", overridesCode(list, indent))
}

function setOverride(source: string, ast: Node, t: string, row: number, column: string, value: Literal | undefined, note?: string): Splice | null {
  const nodes = tableNodes(ast, t)
  const colProp = getProp(nodes.columns, column)
  if (!colProp) throw new EditError(`Unknown column "${column}" in "${t}"`)
  if (!isFormulaColumn(colProp.value)) throw new EditError(`"${column}" isn't a formula column; set the cell instead`)
  const list = readOverrides(source, nodes.def)
  if (!list) throw new EditError(`overrides of "${t}" must be literal { row, column, value } objects`)
  const rest = list.filter((o) => !(o.row === row && o.column === column))
  if (value !== undefined) rest.push({ row, column, value, ...(note ? { note } : {}) })
  rest.sort((a, b) => a.row - b.row || a.column.localeCompare(b.column))
  return writeOverrides(source, nodes, rest)
}

/** Deleting a row shifts the overrides below it. */
function shiftOverrides(source: string, nodes: TableNodes, deleted: number): Splice | null {
  const list = readOverrides(source, nodes.def)
  if (!list?.length) return null
  if (!list.some((o) => o.row >= deleted)) return null
  const next = list.filter((o) => o.row !== deleted).map((o) => (o.row > deleted ? { ...o, row: o.row - 1 } : o))
  return writeOverrides(source, nodes, next)
}

// --- table intents (code rows) -------------------------------------------------

function setCell(source: string, nodes: TableNodes, t: string, row: number, column: string, value: Literal): Splice {
  const colProp = getProp(nodes.columns, column)
  if (!colProp) throw new EditError(`Unknown column "${column}" in "${t}"`)
  if (isFormulaColumn(colProp.value)) throw new EditError(`"${column}" is a formula column; edit its code instead`)
  const el = nodes.rows?.elements[row]
  if (!el) throw new EditError(`Row ${row + 1} of "${t}" is not a literal in the code`)
  const code = literalCode(value)
  if (el.type === "ObjectExpression") {
    const p = getProp(el, column)
    if (p) return { start: p.value.start!, end: p.value.end!, text: code }
    return appendItem(source, el, el.properties, `${identOrString(column)}: ${code}`)
  }
  if (el.type === "ArrayExpression") {
    const idx = nodes.dataColumns.indexOf(column)
    const cur = el.elements[idx]
    if (cur) return { start: cur.start!, end: cur.end!, text: code }
    const pad: string[] = []
    for (let i = el.elements.length; i < idx; i++) pad.push("null")
    pad.push(code)
    return appendItem(source, el, el.elements.filter(Boolean) as Node[], pad.join(", "))
  }
  throw new EditError(`Row ${row + 1} of "${t}" is computed by code, so it can't be edited in the grid`)
}

function addRow(source: string, nodes: TableNodes, values: Record<string, Literal> = {}): Splice {
  const cols = nodes.dataColumns
  if (!nodes.rows) {
    const obj = `{ ${cols.map((c) => `${identOrString(c)}: ${literalCode(values[c] ?? null)}`).join(", ")} }`
    return appendItem(source, nodes.def, nodes.def.properties, `rows: [${obj}]`)
  }
  const els = nodes.rows.elements.filter(Boolean) as Expression[]
  const tuple = els.length > 0 && els[els.length - 1].type === "ArrayExpression"
  const text = tuple
    ? `[${cols.map((c) => literalCode(values[c] ?? null)).join(", ")}]`
    : `{ ${cols.map((c) => `${identOrString(c)}: ${literalCode(values[c] ?? null)}`).join(", ")} }`
  return appendItem(source, nodes.rows, els, text)
}

function deleteRow(source: string, nodes: TableNodes, t: string, row: number): Splice {
  const els = (nodes.rows?.elements ?? []).filter(Boolean) as Node[]
  if (!els[row]) throw new EditError(`Row ${row + 1} of "${t}" is not a literal in the code`)
  return removeItem(source, els, row)
}

function columnBuilder(kind: ColumnKind, label?: string) {
  const opts = label ? `{ label: ${JSON.stringify(label)} }` : ""
  switch (kind) {
    case "select":
      return `col.select(["A", "B"]${opts && ", " + opts})`
    case "formula":
      return `col.formula((r) => null${opts && ", " + opts})`
    default:
      return `col.${kind}(${opts})`
  }
}

function addColumn(source: string, nodes: TableNodes, column: string, kind: ColumnKind, label?: string): Splice {
  if (getProp(nodes.columns, column)) throw new EditError(`Column "${column}" already exists`)
  return appendItem(source, nodes.columns, nodes.columns.properties, `${identOrString(column)}: ${columnBuilder(kind, label)}`)
}

function deleteColumn(source: string, nodes: TableNodes, column: string): string {
  const props = nodes.columns.properties as Node[]
  const i = props.findIndex((p) => p.type === "ObjectProperty" && propKey(p as ObjectProperty) === column)
  if (i < 0) throw new EditError(`Unknown column "${column}"`)
  const dataIdx = nodes.dataColumns.indexOf(column)
  const splices: Splice[] = [removeItem(source, props, i)]
  if (dataIdx >= 0 && nodes.rows) {
    for (const el of nodes.rows.elements) {
      if (el?.type === "ObjectExpression") {
        const j = el.properties.findIndex((p) => p.type === "ObjectProperty" && propKey(p) === column)
        if (j >= 0) splices.push(removeItem(source, el.properties, j))
      } else if (el?.type === "ArrayExpression") {
        const items = el.elements.filter(Boolean) as Node[]
        if (dataIdx < items.length) splices.push(removeItem(source, items, dataIdx))
      }
    }
  }
  return applyAll(source, splices)
}

function setColumnFormat(source: string, nodes: TableNodes, column: string, format: Format | null): Splice | null {
  const p = getProp(nodes.columns, column)
  if (!p) throw new EditError(`Unknown column "${column}"`)
  if (p.value.type !== "CallExpression") throw new EditError(`Column "${column}" isn't a col.*() call`)
  const kind = calleeName(p.value)
  const optIndex = kind === "select" || kind === "formula" ? 1 : 0
  return setCallOption(source, p.value, optIndex, "format", format === null ? undefined : JSON.stringify(format))
}

// --- table intents (data files) ------------------------------------------------

function csvHeader(text: string): string[] {
  const [h] = parseCsvRecords(text)
  return h ? h.cells.map((c) => c.text.trim()) : []
}

function rewriteCsv(text: string, fn: (rows: string[][]) => string[][]): string {
  const rows = parseCsvRecords(text).map((r) => r.cells.map((c) => c.text))
  return fn(rows).map((r) => r.map((c) => encodeCsvValue(c === "" ? null : c)).join(",")).join("\n") + "\n"
}

function csvSetCell(text: string, columns: string[], row: number, column: string, value: Literal): string {
  let header = csvHeader(text)
  if (!header.length) {
    text = encodeCsvRow(columns) + "\n"
    header = columns
  }
  if (!header.includes(column)) {
    text = rewriteCsv(text, (rows) => rows.map((r, i) => [...r, ...Array(Math.max(0, header.length - r.length)).fill(""), i === 0 ? column : ""]))
    header = [...header, column]
  }
  const recs = parseCsvRecords(text)
  const rec = recs[row + 1]
  if (!rec) throw new EditError(`Row ${row + 1} doesn't exist in the data file`)
  const ci = header.indexOf(column)
  const code = encodeCsvValue(value)
  const cell = rec.cells[ci]
  if (cell) return text.slice(0, cell.start) + code + text.slice(cell.end)
  return text.slice(0, rec.end) + ",".repeat(ci - rec.cells.length + 1) + code + text.slice(rec.end)
}

function csvAddRow(text: string, columns: string[], values: Record<string, Literal> = {}): string {
  let header = csvHeader(text)
  if (!header.length) {
    header = columns
    text = encodeCsvRow(columns) + "\n"
  }
  const line = encodeCsvRow(header.map((k) => values[k] ?? null))
  const sep = text === "" || text.endsWith("\n") ? "" : "\n"
  return `${text}${sep}${line}\n`
}

function csvDeleteRow(text: string, row: number): string {
  const rec = parseCsvRecords(text)[row + 1]
  if (!rec) throw new EditError(`Row ${row + 1} doesn't exist in the data file`)
  return text.slice(0, rec.start) + text.slice(rec.next)
}

function csvAddColumn(text: string, column: string): string {
  if (!text.trim()) return text
  return rewriteCsv(text, (rows) => {
    const w = rows[0]?.length ?? 0
    return rows.map((r, i) => [...r, ...Array(Math.max(0, w - r.length)).fill(""), i === 0 ? column : ""])
  })
}

function csvDeleteColumn(text: string, column: string): string {
  const ci = csvHeader(text).indexOf(column)
  if (ci < 0) return text
  return rewriteCsv(text, (rows) => rows.map((r) => r.filter((_, i) => i !== ci)))
}

function dataFileOf(bundle: Bundle, nodes: TableNodes): string {
  const text = bundle.files[nodes.dataFile!]
  if (text === undefined) throw new EditError(`Data file "${nodes.dataFile}" is missing`)
  return text
}

// --- dispatch --------------------------------------------------------------------

function withFile(bundle: Bundle, file: string, text: string, source = bundle.source): Bundle {
  return { source, files: { ...bundle.files, [file]: text } }
}

function editBundle(bundle: Bundle, intent: EditIntent): Bundle {
  const source = bundle.source
  const ast = parseSource(source)
  const code = (s: Splice | Splice[] | null) =>
    ({ ...bundle, source: s === null ? source : Array.isArray(s) ? applyAll(source, s) : apply(source, s) })

  switch (intent.type) {
    case "setCell": {
      const nodes = tableNodes(ast, intent.table)
      if (nodes.dataFile) {
        const colProp = getProp(nodes.columns, intent.column)
        if (!colProp) throw new EditError(`Unknown column "${intent.column}" in "${intent.table}"`)
        if (isFormulaColumn(colProp.value)) throw new EditError(`"${intent.column}" is a formula column; edit its code instead`)
        return withFile(bundle, nodes.dataFile, csvSetCell(dataFileOf(bundle, nodes), nodes.dataColumns, intent.row, intent.column, intent.value))
      }
      return code(setCell(source, nodes, intent.table, intent.row, intent.column, intent.value))
    }
    case "setOverride":
      return code(setOverride(source, ast, intent.table, intent.row, intent.column, intent.value, intent.note))
    case "setParam": {
      const call = findNamedCall(ast, "param", intent.name)
      const arg = call.arguments[1]
      return code({ start: arg.start!, end: arg.end!, text: literalCode(intent.value) })
    }
    case "addRow": {
      const nodes = tableNodes(ast, intent.table)
      if (nodes.dataFile) return withFile(bundle, nodes.dataFile, csvAddRow(dataFileOf(bundle, nodes), nodes.dataColumns, intent.values))
      return code(addRow(source, nodes, intent.values))
    }
    case "deleteRow": {
      const nodes = tableNodes(ast, intent.table)
      const shift = shiftOverrides(source, nodes, intent.row)
      if (nodes.dataFile) {
        const next = csvDeleteRow(dataFileOf(bundle, nodes), intent.row)
        return withFile(bundle, nodes.dataFile, next, shift ? apply(source, shift) : source)
      }
      return code([deleteRow(source, nodes, intent.table, intent.row), ...(shift ? [shift] : [])])
    }
    case "addColumn": {
      const nodes = tableNodes(ast, intent.table)
      const next = apply(source, addColumn(source, nodes, intent.column, intent.kind, intent.label))
      if (nodes.dataFile && intent.kind !== "formula")
        return withFile(bundle, nodes.dataFile, csvAddColumn(dataFileOf(bundle, nodes), intent.column), next)
      return { ...bundle, source: next }
    }
    case "deleteColumn": {
      const nodes = tableNodes(ast, intent.table)
      const next = deleteColumn(source, nodes, intent.column)
      if (nodes.dataFile) return withFile(bundle, nodes.dataFile, csvDeleteColumn(dataFileOf(bundle, nodes), intent.column), next)
      return { ...bundle, source: next }
    }
    case "setColumnFormat":
      return code(setColumnFormat(source, tableNodes(ast, intent.table), intent.column, intent.format))
    case "setColumnLabel": {
      const p = getProp(tableNodes(ast, intent.table).columns, intent.column)
      if (!p) throw new EditError(`Unknown column "${intent.column}"`)
      if (p.value.type !== "CallExpression") throw new EditError(`Column "${intent.column}" isn't a col.*() call`)
      const kind = calleeName(p.value)
      return code(setCallOption(source, p.value, kind === "select" || kind === "formula" ? 1 : 0, "label", JSON.stringify(intent.label)))
    }
    case "setTableTitle":
      return code(setProp(source, tableNodes(ast, intent.table).def, "title", JSON.stringify(intent.title)))
    case "addSheet": {
      const wb = findCalls(ast, "workbook")[0]
      const sheets = wb?.arguments[1]
      if (sheets?.type !== "ArrayExpression") throw new EditError("Could not find the workbook's sheet list")
      return code(appendItem(source, sheets, sheets.elements.filter(Boolean) as Node[], `sheet(${JSON.stringify(intent.name)}, [])`))
    }
    case "renameSheet": {
      const call = sheetCall(ast, intent.sheet)
      const arg = call.arguments[0]
      return code({ start: arg.start!, end: arg.end!, text: JSON.stringify(intent.name) })
    }
    case "addBlock": {
      const blocks = sheetBlocks(sheetCall(ast, intent.sheet), intent.sheet)
      const splices = [appendItem(source, blocks, blocks.elements.filter(Boolean) as Node[], intent.code)]
      const imp = missingImports(source, ast, intent.code)
      if (imp) splices.push(imp)
      return code(splices)
    }
    case "moveBlock": {
      const { call, optionsArg } = blockCall(ast, intent.sheet, intent.index)
      return code(setCallOption(source, call, optionsArg, "at", JSON.stringify(intent.at)))
    }
    case "deleteBlock": {
      const { items } = blockCall(ast, intent.sheet, intent.index)
      return code(removeItem(source, items, intent.index))
    }
    case "setFreeCell":
      return code(setFreeCell(source, ast, intent.sheet, intent.address, intent.value))
    case "setCellStyle":
      return code(setCellStyle(source, ast, intent.sheet, intent.address, intent.style))
    case "setWidth": {
      const col = intent.column.toUpperCase()
      const { obj, create } = sheetOption(source, ast, intent.sheet, "widths")
      const width = intent.width === null ? undefined : String(Math.round(intent.width))
      if (!obj) return code(width === undefined ? null : create(`{ ${col}: ${width} }`))
      return code(setProp(source, obj, col, width))
    }
    case "addDataFile":
      if (intent.file in bundle.files) throw new EditError(`A data file named "${intent.file}" already exists`)
      return withFile(bundle, intent.file, intent.text)
  }
}

const BUILDERS = ["table", "query", "col", "chart", "metric", "param", "text", "data", "sheet"]

/** Add builder names that `code` uses to the file's `import { ... } from "@xl2/sdk"`. */
function missingImports(source: string, ast: Node, code: string): Splice | null {
  const used = BUILDERS.filter((n) => new RegExp(`(^|[^.\\w$])${n}\\s*[.(]`).test(code))
  let decl: any
  walk(ast, (n) => {
    if (!decl && n.type === "ImportDeclaration" && (n.source.value === "@xl2/sdk" || n.source.value === "xl2")) decl = n
  })
  if (!decl) return null
  const have = new Set(decl.specifiers.filter((s: any) => s.type === "ImportSpecifier").map((s: any) => s.local.name))
  const add = used.filter((n) => !have.has(n))
  if (!add.length) return null
  const named = decl.specifiers.filter((s: any) => s.type === "ImportSpecifier")
  if (!named.length) return null
  const last = named[named.length - 1]
  return { start: last.end, end: last.end, text: `, ${add.join(", ")}` }
}

/** Apply a UI edit to a workbook bundle (code plus data files). */
export function applyEdit(bundle: Bundle, intent: EditIntent): BundleResult {
  try {
    return { ok: true, bundle: editBundle(bundle, intent) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Apply several edits in order; stops at the first failure. */
export function applyEdits(bundle: Bundle, intents: EditIntent[]): BundleResult {
  let cur = bundle
  for (const i of intents) {
    const r = applyEdit(cur, i)
    if (!r.ok) return r
    cur = r.bundle
  }
  return { ok: true, bundle: cur }
}

/** Apply a UI edit to workbook code alone (no data files). */
export function applyIntent(source: string, intent: EditIntent): EditResult {
  const r = applyEdit({ source, files: {} }, intent)
  return r.ok ? { ok: true, source: r.bundle.source } : r
}

/** Apply several intents to code alone; stops at the first failure. */
export function applyIntents(source: string, intents: EditIntent[]): EditResult {
  const r = applyEdits({ source, files: {} }, intents)
  return r.ok ? { ok: true, source: r.bundle.source } : r
}

/** Where a thing lives in the code (or a data file), for highlighting and formula display. */
export function locate(source: string, target: Target, files: Record<string, string> = {}): Range | null {
  try {
    const ast = parseSource(source)
    if (target.type === "param") {
      const c = findNamedCall(ast, "param", target.name)
      return { start: c.start!, end: c.end! }
    }
    if (target.type === "block") {
      const { call } = blockCall(ast, target.sheet, target.index)
      return { start: call.start!, end: call.end! }
    }
    if (target.type === "freeCell") {
      const { obj } = sheetOption(source, ast, target.sheet, "cells")
      const p = obj && cellKey(obj, target.address)
      return p ? { start: p.start!, end: p.end! } : null
    }
    const nodes = tableNodes(ast, target.table)
    if (target.type === "table") return { start: nodes.call.start!, end: nodes.call.end! }
    if (target.type === "column") {
      const p = getProp(nodes.columns, target.column)
      return p ? { start: p.start!, end: p.end! } : null
    }
    const colProp = getProp(nodes.columns, target.type === "cell" ? target.column : "")
    if (target.type === "cell" && colProp && isFormulaColumn(colProp.value)) {
      const ov = getProp(nodes.def, "overrides")
      if (ov?.value.type === "ArrayExpression") {
        const hit = ov.value.elements.find(
          (el) =>
            el?.type === "ObjectExpression" &&
            literalValue(getProp(el, "row")?.value) === target.row &&
            literalValue(getProp(el, "column")?.value) === target.column,
        )
        if (hit) return { start: hit.start!, end: hit.end! }
      }
      return { start: colProp.start!, end: colProp.end! }
    }
    if (nodes.dataFile) {
      const text = files[nodes.dataFile]
      if (text === undefined) return null
      const recs = parseCsvRecords(text)
      const rec = recs[target.row + 1]
      if (!rec) return null
      if (target.type === "row") return { start: rec.start, end: rec.end, file: nodes.dataFile }
      const cell = rec.cells[csvHeader(text).indexOf(target.column)]
      return cell ? { start: cell.start, end: cell.end, file: nodes.dataFile } : { start: rec.start, end: rec.end, file: nodes.dataFile }
    }
    const el = nodes.rows?.elements[target.row]
    if (target.type === "row") return el ? { start: el.start!, end: el.end! } : null
    if (!el) return null
    if (el.type === "ObjectExpression") {
      const p = getProp(el, target.column)
      return p ? { start: p.value.start!, end: p.value.end! } : { start: el.start!, end: el.end! }
    }
    if (el.type === "ArrayExpression") {
      const cur = el.elements[nodes.dataColumns.indexOf(target.column)]
      return cur ? { start: cur.start!, end: cur.end! } : { start: el.start!, end: el.end! }
    }
    return null
  } catch {
    return null
  }
}

/** Source text of a formula column's function, e.g. "(r) => r.units * r.price". */
export function formulaSource(source: string, tableName: string, column: string): string | null {
  try {
    const nodes = tableNodes(parseSource(source), tableName)
    const p = getProp(nodes.columns, column)
    if (!p || !isFormulaColumn(p.value)) return null
    const fn = (p.value as CallExpression).arguments[0]
    return fn ? source.slice(fn.start!, fn.end!) : null
  } catch {
    return null
  }
}

/** Exact-match string replacement, for AI edits. The old text must be unique. */
export function replaceOnce(source: string, oldText: string, newText: string): EditResult {
  const first = source.indexOf(oldText)
  if (first < 0) return { ok: false, error: "old_string not found" }
  if (source.indexOf(oldText, first + 1) >= 0)
    return { ok: false, error: "old_string appears more than once; include more surrounding context" }
  return { ok: true, source: source.slice(0, first) + newText + source.slice(first + oldText.length) }
}
