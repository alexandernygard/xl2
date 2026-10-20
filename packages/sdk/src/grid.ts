import { address, contains, type Rect } from "./address"
import {
  isCellError,
  tableRegion,
  type BlockModel,
  type CellModel,
  type CellValue,
  type ChartModel,
  type ColumnModel,
  type MetricModel,
  type ParamModel,
  type SheetModel,
  type TableModel,
  type TableRegion,
  type TextModel,
} from "./engine"
import { coerceInput, editText, kindForFormat } from "./format"
import { isFormula, shiftFormula } from "./formula"
import type { EditIntent, StylePatch } from "./source"
import type { Literal } from "./types"

// What's at a grid position, and how typing, pasting, filling and clearing
// there turns into edit intents. Pure functions over the evaluated model, so
// the grid UI, the formula bar and the assistant all share them.

export type CellInfo =
  | { kind: "empty"; row: number; col: number; address: string }
  | { kind: "free"; row: number; col: number; address: string; cell: CellModel }
  | {
      kind: "table"
      row: number
      col: number
      address: string
      table: TableModel
      region: TableRegion
      column?: ColumnModel
      columnIndex: number
      value: CellValue
      overridden: boolean
    }
  | { kind: "param"; row: number; col: number; address: string; param: ParamModel; part: "label" | "value" }
  | { kind: "overlay"; row: number; col: number; address: string; block: ChartModel | MetricModel | TextModel }

export const isOverlay = (b: BlockModel): b is ChartModel | MetricModel | TextModel =>
  b.type === "chart" || b.type === "metric" || b.type === "text"

export function blockAt(sheet: SheetModel, row: number, col: number): BlockModel | undefined {
  // later blocks draw on top
  for (let i = sheet.blocks.length - 1; i >= 0; i--) if (contains(sheet.blocks[i].rect, row, col)) return sheet.blocks[i]
  return undefined
}

export function cellAt(sheet: SheetModel, row: number, col: number): CellInfo {
  const a = address(row, col)
  const b = blockAt(sheet, row, col)
  if (b) {
    if (isOverlay(b)) return { kind: "overlay", row, col, address: a, block: b }
    if (b.type === "param") return { kind: "param", row, col, address: a, param: b, part: col === b.rect.col ? "label" : "value" }
    const columnIndex = col - b.rect.col
    const column = b.columns[columnIndex]
    const region = tableRegion(b, row) ?? { kind: "add" as const }
    let value: CellValue = null
    if (region.kind === "title") value = columnIndex === 0 ? b.title : null
    else if (region.kind === "header") value = column?.label ?? null
    else if (region.kind === "data") value = b.rows[region.index]?.[columnIndex] ?? null
    else if (region.kind === "totals") value = b.totals?.[columnIndex] ?? null
    const overridden = region.kind === "data" && !!column && b.overridden.includes(`${region.index}:${column.key}`)
    return { kind: "table", row, col, address: a, table: b, region, column, columnIndex, value, overridden }
  }
  const cell = sheet.cells[a]
  return cell ? { kind: "free", row, col, address: a, cell } : { kind: "empty", row, col, address: a }
}

/** Human-readable reference: "sales[2].units" for table cells, else the A1 address. */
export function cellLabel(info: CellInfo): string {
  if (info.kind === "table") {
    const key = info.column?.key
    switch (info.region.kind) {
      case "data":
        return `${info.table.name}[${info.region.index}].${key}`
      case "header":
        return `${info.table.name}.${key} (header)`
      case "title":
        return `${info.table.name} (title)`
      case "totals":
        return `${info.table.name}.${key} (total)`
      case "add":
        return `${info.table.name} (new row)`
    }
  }
  if (info.kind === "param") return `param ${info.param.name}`
  return info.address
}

/** Text to put in the editor when editing a cell. */
export function editTextFor(info: CellInfo): string {
  switch (info.kind) {
    case "free":
      return info.cell.formula ?? (isCellError(info.cell.value) ? "" : formatLiteral(info.cell.value, info.cell.style?.format))
    case "table":
      if (info.region.kind === "title") return info.table.title
      if (info.region.kind === "header") return info.column?.label ?? ""
      return info.column ? editText(info.value, info.column.computed ? kindForFormat(info.column.format) : info.column.kind) : ""
    case "param":
      return info.part === "value" ? editText(info.param.value, kindForFormat(info.param.format)) : info.param.label
    default:
      return ""
  }
}

function formatLiteral(v: CellValue, format?: string): string {
  if (v === null || isCellError(v)) return ""
  if (format === "percent" && typeof v === "number") return `${+(v * 100).toFixed(10)}%`
  return String(v)
}

/** Can the user type into this cell? */
export function isEditable(info: CellInfo): boolean {
  switch (info.kind) {
    case "empty":
    case "free":
      return true
    case "table":
      if (info.table.source === "query") return false
      return info.region.kind !== "totals" && !!(info.column || info.region.kind === "title")
    case "param":
      return info.part === "value"
    default:
      return false
  }
}

/** Best literal for text typed into a free cell: numbers, percents, booleans, else the string. */
export function guessLiteral(raw: string): Literal {
  const s = raw.trim()
  if (s === "") return null
  if (isFormula(s)) return s
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s)
  if (/^[-+]?[$€£¥]?\s?[\d,]*\.?\d+(e[-+]?\d+)?\s?%?$/i.test(s)) {
    const r = coerceInput(s, "number")
    if (r.ok) return r.value
  }
  return raw
}

export type IntentsResult = { ok: true; intents: EditIntent[] } | { ok: false; error: string }

const keyFor = (label: string, taken: string[]) => {
  const words = label.trim().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean)
  let key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("") || "column"
  if (/^\d/.test(key)) key = `c${key}`
  let k = key
  for (let n = 2; taken.includes(k); n++) k = `${key}${n}`
  return k
}

/** The table whose header row ends just left of this empty cell (typing there adds a column). */
function headerNeighbor(sheet: SheetModel, row: number, col: number): TableModel | undefined {
  return sheet.blocks.find(
    (b): b is TableModel => b.type === "table" && b.source === "table" && b.rect.row + 1 === row && b.rect.col + b.rect.cols === col,
  )
}

/** Intents for typing `raw` into a cell. */
export function inputIntents(sheet: SheetModel, info: CellInfo, raw: string): IntentsResult {
  const ok = (...intents: EditIntent[]): IntentsResult => ({ ok: true, intents })
  const fail = (error: string): IntentsResult => ({ ok: false, error })
  switch (info.kind) {
    case "empty": {
      const t = raw.trim() ? headerNeighbor(sheet, info.row, info.col) : undefined
      if (t)
        return ok({
          type: "addColumn",
          table: t.name,
          column: keyFor(raw, t.columns.map((c) => c.key)),
          kind: "text",
          label: raw.trim(),
        })
      return raw.trim() === "" ? ok() : ok({ type: "setFreeCell", sheet: sheet.name, address: info.address, value: guessLiteral(raw) })
    }
    case "free":
      return ok({ type: "setFreeCell", sheet: sheet.name, address: info.address, value: guessLiteral(raw) })
    case "param": {
      if (info.part === "label") return fail("Param labels are set in code")
      const p = info.param
      const r = coerceInput(raw, kindForFormat(p.format), p.options)
      return r.ok ? ok({ type: "setParam", name: p.name, value: r.value }) : fail(r.error)
    }
    case "overlay":
      return fail("Charts, metrics and text are edited in code")
    case "table": {
      const t = info.table
      if (t.source === "query") return fail(`"${t.name}" is a query; its rows are computed`)
      const { region, column } = info
      if (region.kind === "title") return raw.trim() ? ok({ type: "setTableTitle", table: t.name, title: raw.trim() }) : ok()
      if (!column) return fail("Outside the table's columns")
      if (region.kind === "header")
        return raw.trim() ? ok({ type: "setColumnLabel", table: t.name, column: column.key, label: raw.trim() }) : ok()
      if (region.kind === "totals") return fail("Totals are computed")
      if (column.computed) {
        if (region.kind === "add") return fail(`"${column.label}" is a formula column`)
        if (raw.trim() === "") return ok({ type: "setOverride", table: t.name, row: region.index, column: column.key, value: undefined })
        const r = coerceInput(raw, kindForFormat(column.format))
        return r.ok ? ok({ type: "setOverride", table: t.name, row: region.index, column: column.key, value: r.value }) : fail(r.error)
      }
      const r = coerceInput(raw, column.kind, column.options)
      if (!r.ok) return fail(r.error)
      if (region.kind === "add") return raw.trim() === "" ? ok() : ok({ type: "addRow", table: t.name, values: { [column.key]: r.value } })
      return ok({ type: "setCell", table: t.name, row: region.index, column: column.key, value: r.value })
    }
  }
}

/** Intents that clear every cell in a rect (formats on free cells stay). */
export function clearIntents(sheet: SheetModel, rect: Rect): EditIntent[] {
  const out: EditIntent[] = []
  for (let row = rect.row; row < rect.row + rect.rows; row++)
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      const info = cellAt(sheet, row, col)
      if (info.kind === "free") out.push({ type: "setFreeCell", sheet: sheet.name, address: info.address, value: null })
      else if (info.kind === "table" && info.region.kind === "data" && info.column && info.table.source === "table") {
        if (info.column.computed) {
          if (info.overridden) out.push({ type: "setOverride", table: info.table.name, row: info.region.index, column: info.column.key, value: undefined })
        } else if (info.value !== null) out.push({ type: "setCell", table: info.table.name, row: info.region.index, column: info.column.key, value: null })
      }
    }
  return out
}

/** One pasted cell: raw text, plus the formula and origin when copied inside the app. */
export interface ClipCell {
  text: string
  formula?: string
}

/**
 * Intents for pasting a block of cells with its top-left at (row, col).
 * Formulas copied inside the app shift their relative references. Rows that
 * land on a table's "add" row (and rows below it) are appended to the table.
 */
export function pasteIntents(
  sheet: SheetModel,
  row: number,
  col: number,
  clip: ClipCell[][],
  from?: { row: number; col: number },
): IntentsResult {
  const intents: EditIntent[] = []
  let appending: { table: TableModel; startRow: number } | null = null
  for (let r = 0; r < clip.length; r++) {
    const rowValues = new Map<TableModel, Record<string, Literal>>()
    for (let c = 0; c < clip[r].length; c++) {
      const cell = clip[r][c]
      const tr = row + r
      const tc = col + c
      let text = cell.text
      if (cell.formula && from) text = shiftFormula(cell.formula, tr - (from.row + r), tc - (from.col + c))
      else if (cell.formula) text = cell.formula
      const info = cellAt(sheet, tr, tc)
      // rows below an append keep appending to the same table
      const t: TableModel | null =
        info.kind === "table" && info.region.kind === "add"
          ? info.table
          : appending && tr > appending.startRow && tc >= appending.table.rect.col && tc < appending.table.rect.col + appending.table.rect.cols
            ? appending.table
            : null
      if (t) {
        const column = t.columns[tc - t.rect.col]
        if (!column || column.computed) continue
        const v = coerceInput(text, column.kind, column.options)
        if (!v.ok) return v
        const vals = rowValues.get(t) ?? {}
        vals[column.key] = v.value
        rowValues.set(t, vals)
        if (!appending || appending.table !== t) appending = { table: t, startRow: tr }
        continue
      }
      if (info.kind === "overlay" || (info.kind === "table" && (info.region.kind === "totals" || info.table.source === "query"))) continue
      if (info.kind === "param" && info.part === "label") continue
      const res = inputIntents(sheet, info, text)
      if (!res.ok) return res
      intents.push(...res.intents)
    }
    for (const [t, values] of rowValues) intents.push({ type: "addRow", table: t.name, values })
  }
  return { ok: true, intents }
}

/** Copy the cells of `source` to fill `target` (which extends it down or right), shifting formulas. */
export function fillIntents(sheet: SheetModel, source: Rect, target: Rect): IntentsResult {
  const clip: ClipCell[][] = []
  for (let r = 0; r < target.rows; r++) {
    const line: ClipCell[] = []
    for (let c = 0; c < target.cols; c++) {
      const sr = source.row + (r % source.rows)
      const sc = source.col + (c % source.cols)
      line.push(clipCell(sheet, sr, sc))
    }
    clip.push(line)
  }
  // shift relative to each source cell, not the paste origin
  const intents: EditIntent[] = []
  for (let r = 0; r < target.rows; r++)
    for (let c = 0; c < target.cols; c++) {
      const tr = target.row + r
      const tc = target.col + c
      if (contains(source, tr, tc)) continue
      const sr = source.row + (r % source.rows)
      const sc = source.col + (c % source.cols)
      const res = pasteIntents(sheet, tr, tc, [[clip[r][c]]], { row: sr, col: sc })
      if (!res.ok) return res
      intents.push(...res.intents)
    }
  return { ok: true, intents }
}

/** What copying a cell puts on the clipboard. */
export function clipCell(sheet: SheetModel, row: number, col: number): ClipCell {
  const info = cellAt(sheet, row, col)
  if (info.kind === "free" && info.cell.formula) return { text: displayText(info), formula: info.cell.formula }
  return { text: editTextFor(info) }
}

function displayText(info: CellInfo): string {
  if (info.kind === "free") return isCellError(info.cell.value) ? "#ERR" : String(info.cell.value ?? "")
  return editTextFor(info)
}

/** Parse tab-separated clipboard text into cells. */
export function parseTsv(text: string): ClipCell[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")
  return lines.map((l) => l.split("\t").map((t) => ({ text: t })))
}

/** The last non-empty cell from (row, col) moving in a direction, Excel's Cmd+arrow. */
export function jump(sheet: SheetModel, row: number, col: number, dRow: number, dCol: number, limit: { rows: number; cols: number }) {
  const filled = (r: number, c: number) => {
    const i = cellAt(sheet, r, c)
    return i.kind !== "empty" && !(i.kind === "free" && i.cell.value === null)
  }
  const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < limit.rows && c < limit.cols
  let r = row
  let c = col
  const next = () => [r + dRow, c + dCol] as const
  const [nr, nc] = next()
  if (!inBounds(nr, nc)) return { row, col }
  if (filled(r, c) && filled(nr, nc)) {
    // run to the end of this block of filled cells
    while (inBounds(...next()) && filled(...next())) [r, c] = next()
    return { row: r, col: c }
  }
  // skip blanks to the next filled cell, or the edge
  ;[r, c] = next()
  while (inBounds(...next()) && !filled(r, c)) [r, c] = next()
  return { row: r, col: c }
}

/**
 * Style edits for a range: free and empty cells get cell styles; a number
 * format on table cells sets the column's format instead (once per column).
 */
export function styleIntents(sheet: SheetModel, rect: Rect, patch: StylePatch): EditIntent[] {
  const out: EditIntent[] = []
  const columns = new Set<string>()
  for (let row = rect.row; row < rect.row + rect.rows; row++)
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      const info = cellAt(sheet, row, col)
      if (info.kind === "free" || info.kind === "empty") out.push({ type: "setCellStyle", sheet: sheet.name, address: info.address, style: patch })
      else if (info.kind === "table" && info.table.source === "table" && info.column && "format" in patch) {
        const key = `${info.table.name}.${info.column.key}`
        if (columns.has(key)) continue
        columns.add(key)
        out.push({ type: "setColumnFormat", table: info.table.name, column: info.column.key, format: patch.format ?? null })
      }
    }
  return out
}
