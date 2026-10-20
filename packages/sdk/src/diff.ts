import { address, contains, parseAddress, type Rect } from "./address"
import { blockLabel, isCellError, type BlockModel, type CellModel, type CellValue, type SheetModel, type TableModel, type WorkbookModel } from "./engine"
import { formatCell, formatValue } from "./format"
import { replaceOnce, applyEdits, type Bundle, type EditIntent } from "./source"
import type { Format } from "./types"

// Reviewing changes: what differs between two evaluated workbooks, cell by
// cell, and a list of recorded edits ("steps") that can be replayed onto a
// base bundle with some of them left out.

/**
 * - edited: its input changed (a literal, a formula, a label, a style)
 * - computed: only its computed value changed, as a consequence of other edits
 * - added / removed: the cell gained or lost content
 */
export type ChangeKind = "edited" | "computed" | "added" | "removed"

export interface CellChange {
  kind: ChangeKind
  /** The old value as displayed, for "edited", "computed" and "removed". */
  was?: string
}

export interface BlockChange {
  kind: ChangeKind | "moved"
  /** Block index on the new sheet (absent when removed). */
  index?: number
  label: string
  /** Where it was, for moved and removed blocks. */
  from?: Rect
  note?: string
}

export interface SheetDiff {
  /** Sheet name in the new model. */
  sheet: string
  added: boolean
  cells: Record<string, CellChange>
  blocks: BlockChange[]
}

export interface Impact {
  label: string
  before: string
  after: string
}

export interface WorkbookDiff {
  sheets: SheetDiff[]
  removedSheets: string[]
  /** Headline numbers that moved: metrics and table totals. */
  impact: Impact[]
  /** Structural changes worth a line of text (rows removed, blocks added...). */
  notes: string[]
  /** Counts by kind over all cells. */
  counts: Record<ChangeKind, number>
}

const same = (a: CellValue | undefined, b: CellValue | undefined) =>
  a === b || (isCellError(a) && isCellError(b) && a.error === b.error) || (Number.isNaN(a) && Number.isNaN(b))

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Blocks match across versions by name (tables, queries, params) or by kind and title. */
function blockKey(b: BlockModel): string {
  switch (b.type) {
    case "table":
    case "param":
      return `${b.type}:${b.name}`
    case "chart":
    case "metric":
      return `${b.type}:${b.title}`
    case "text":
      return `text:${b.content.split("\n")[0]}`
  }
}

function matchBlocks(before: BlockModel[], after: BlockModel[]) {
  const pairs: [BlockModel | undefined, BlockModel | undefined][] = []
  const left = new Map<string, BlockModel[]>()
  for (const b of before) left.set(blockKey(b), [...(left.get(blockKey(b)) ?? []), b])
  const unmatched: BlockModel[] = []
  for (const b of after) {
    const list = left.get(blockKey(b))
    const m = list?.shift()
    if (m) pairs.push([m, b])
    else unmatched.push(b)
  }
  // text blocks whose first line changed: pair leftovers of the same type in order
  const rest = [...left.values()].flat()
  for (const b of unmatched) {
    const i = rest.findIndex((r) => r.type === b.type && b.type === "text")
    pairs.push([i >= 0 ? rest.splice(i, 1)[0] : undefined, b])
  }
  for (const r of rest) pairs.push([r, undefined])
  return pairs
}

const sameRect = (a: Rect, b: Rect) => a.row === b.row && a.col === b.col && a.rows === b.rows && a.cols === b.cols

function diffSheet(before: SheetModel | undefined, after: SheetModel, opts: { locale?: string; currency?: string }): SheetDiff {
  const out: SheetDiff = { sheet: after.name, added: !before, cells: {}, blocks: [] }
  const put = (a: string, c: CellChange) => {
    // an input change wins over a consequence at the same cell
    if (!out.cells[a] || c.kind === "edited") out.cells[a] = c
  }
  const fmt = (v: CellValue | undefined, format: Format = "number", decimals?: number) =>
    v === undefined || v === null ? "(empty)" : formatValue(v, format, { ...opts, decimals })

  for (const [b0, b1] of matchBlocks(before?.blocks ?? [], after.blocks)) {
    if (!b1) {
      out.blocks.push({ kind: "removed", label: blockLabel(b0!), from: b0!.rect })
      continue
    }
    if (!b0) {
      out.blocks.push({ kind: "added", index: b1.index, label: blockLabel(b1) })
      forEachCell(b1, (a) => put(a, { kind: "added" }))
      continue
    }
    if (!sameRect(b0.rect, b1.rect) && (b0.rect.row !== b1.rect.row || b0.rect.col !== b1.rect.col))
      out.blocks.push({ kind: "moved", index: b1.index, label: blockLabel(b1), from: b0.rect })

    if (b1.type === "table" && b0.type === "table") diffTable(b0, b1, put, opts, out)
    else if (b1.type === "param" && b0.type === "param") {
      const a = address(b1.rect.row, b1.rect.col + 1)
      if (!same(b0.value, b1.value)) put(a, { kind: "edited", was: fmt(b0.value, b0.format) })
      if (b0.label !== b1.label) put(address(b1.rect.row, b1.rect.col), { kind: "edited", was: b0.label })
    } else if (b1.type === "metric" && b0.type === "metric") {
      if (!same(b0.value, b1.value) || b0.caption !== b1.caption)
        out.blocks.push({ kind: "computed", index: b1.index, label: blockLabel(b1), note: `was ${fmt(b0.value, b0.format, b0.decimals)}` })
      else if (b0.format !== b1.format || b0.decimals !== b1.decimals) out.blocks.push({ kind: "edited", index: b1.index, label: blockLabel(b1) })
    } else if (b1.type === "chart" && b0.type === "chart") {
      const config = b0.kind !== b1.kind || b0.x !== b1.x || !sameJson(b0.series, b1.series) || b0.stacked !== b1.stacked || b0.format !== b1.format
      if (config) out.blocks.push({ kind: "edited", index: b1.index, label: blockLabel(b1) })
      else if (!sameJson(b0.data, b1.data)) out.blocks.push({ kind: "computed", index: b1.index, label: blockLabel(b1) })
    } else if (b1.type === "text" && b0.type === "text") {
      if (b0.content !== b1.content) out.blocks.push({ kind: "edited", index: b1.index, label: blockLabel(b1) })
    }
    if (!sameRect(b0.rect, b1.rect) && b0.rect.row === b1.rect.row && b0.rect.col === b1.rect.col && b1.type !== "table")
      out.blocks.push({ kind: "edited", index: b1.index, label: blockLabel(b1), note: "resized" })
  }

  // free cells
  const cells0 = before?.cells ?? {}
  for (const [a, c1] of Object.entries(after.cells)) {
    const c0 = cells0[a]
    if (!c0) put(a, { kind: "added" })
    else {
      const kind = freeCellChange(c0, c1)
      if (kind) put(a, { kind, was: fmt(c0.value, c0.style?.format ?? "number", c0.style?.decimals) })
    }
  }
  for (const [a, c0] of Object.entries(cells0))
    if (!after.cells[a] && !coveredByBlock(after, a)) put(a, { kind: "removed", was: fmt(c0.value, c0.style?.format ?? "number", c0.style?.decimals) })
  return out
}

function freeCellChange(c0: CellModel, c1: CellModel): ChangeKind | null {
  if ((c0.formula ?? null) !== (c1.formula ?? null)) return "edited"
  if (!sameJson(c0.style ?? {}, c1.style ?? {})) return "edited"
  if (same(c0.value, c1.value)) return null
  return c1.formula ? "computed" : "edited"
}

function coveredByBlock(sheet: SheetModel, a: string) {
  const p = parseAddress(a)
  return !!p && sheet.blocks.some((b) => contains(b.rect, p.row, p.col))
}

/** Every content cell of a table or param (overlays have no cells of their own). */
function forEachCell(b: BlockModel, fn: (a: string) => void) {
  if (b.type !== "table" && b.type !== "param") return
  for (let r = b.rect.row; r < b.rect.row + b.rect.rows; r++) {
    if (b.type === "table" && b.source === "table" && r === b.rect.row + 2 + b.rows.length) continue // the empty add row
    for (let c = b.rect.col; c < b.rect.col + b.rect.cols; c++) fn(address(r, c))
  }
}

function diffTable(
  t0: TableModel,
  t1: TableModel,
  put: (a: string, c: CellChange) => void,
  opts: { locale?: string; currency?: string },
  out: SheetDiff,
) {
  const at = (row: number, col: number) => address(t1.rect.row + row, t1.rect.col + col)
  if (t0.title !== t1.title) put(at(0, 0), { kind: "edited", was: t0.title })
  const notes: string[] = []
  t1.columns.forEach((c1, j) => {
    const j0 = t0.columns.findIndex((c) => c.key === c1.key)
    const c0 = t0.columns[j0]
    if (!c0) {
      for (let r = 1; r < 2 + t1.rows.length; r++) put(at(r, j), { kind: "added" })
      if (t1.totals?.[j] != null) put(at(2 + t1.rows.length + (t1.source === "table" ? 1 : 0), j), { kind: "added" })
      return
    }
    if (c0.label !== c1.label) put(at(1, j), { kind: "edited", was: c0.label })
    // a new formula or format on a column: the whole column was edited
    const columnEdited = c0.computed !== c1.computed || c0.format !== c1.format || c0.decimals !== c1.decimals || c0.kind !== c1.kind
    t1.rows.forEach((row, i) => {
      if (i >= t0.rows.length) {
        put(at(2 + i, j), { kind: "added" })
        return
      }
      const v0 = t0.rows[i][j0]
      const v1 = row[j]
      const o0 = t0.overridden.includes(`${i}:${c1.key}`)
      const o1 = t1.overridden.includes(`${i}:${c1.key}`)
      if (same(v0, v1) && o0 === o1 && !columnEdited) return
      const was = v0 === null ? "(empty)" : formatCell(v0, c0, opts)
      // literal cells changed by edits; formula cells by consequence, unless overridden
      put(at(2 + i, j), { kind: columnEdited || o0 !== o1 || o1 || !c1.computed ? "edited" : "computed", was })
    })
    const totals1 = t1.totals?.[j]
    const totals0 = t0.totals?.[j0]
    if (totals1 != null || totals0 != null) {
      const r = 2 + t1.rows.length + (t1.source === "table" ? 1 : 0)
      if (totals0 == null) put(at(r, j), { kind: "added" })
      else if (!same(totals0, totals1 ?? null)) put(at(r, j), { kind: "computed", was: formatCell(totals0, c0, opts) })
    }
  })
  const removedCols = t0.columns.filter((c) => !t1.columns.some((x) => x.key === c.key)).map((c) => c.label)
  if (removedCols.length) notes.push(`removed column${removedCols.length > 1 ? "s" : ""} ${removedCols.join(", ")}`)
  if (t0.rows.length > t1.rows.length) {
    const n = t0.rows.length - t1.rows.length
    notes.push(`${n} row${n > 1 ? "s" : ""} removed`)
  }
  if (notes.length) out.blocks.push({ kind: "edited", index: t1.index, label: blockLabel(t1), note: notes.join("; ") })
}

/** Cell-level differences between two evaluations of a workbook. */
export function diffModels(before: WorkbookModel, after: WorkbookModel): WorkbookDiff {
  const opts = { locale: after.locale, currency: after.currency }
  const sheets = after.sheets.map((s1, i) => {
    // match sheets by name, falling back to position (a renamed sheet)
    const s0 = before.sheets.find((s) => s.name === s1.name) ?? (before.sheets[i] && !after.sheets.some((s) => s.name === before.sheets[i].name) ? before.sheets[i] : undefined)
    return diffSheet(s0, s1, opts)
  })
  const removedSheets = before.sheets.filter((s0, i) => !after.sheets.some((s) => s.name === s0.name) && !(after.sheets[i] && !before.sheets.some((s) => s.name === after.sheets[i].name))).map((s) => s.name)

  const counts: Record<ChangeKind, number> = { edited: 0, computed: 0, added: 0, removed: 0 }
  for (const s of sheets) for (const c of Object.values(s.cells)) counts[c.kind]++

  const notes: string[] = []
  for (const s of sheets) {
    if (s.added) notes.push(`New sheet ${s.sheet}`)
    for (const b of s.blocks) {
      if (b.kind === "added") notes.push(`Added ${b.label}`)
      else if (b.kind === "removed") notes.push(`Removed ${b.label}`)
      else if (b.kind === "moved") notes.push(`Moved ${b.label}`)
      else if (b.note && b.kind === "edited") notes.push(`${b.label}: ${b.note}`)
    }
  }
  for (const s of removedSheets) notes.push(`Removed sheet ${s}`)

  return { sheets, removedSheets, impact: impact(before, after), notes, counts }
}

function impact(before: WorkbookModel, after: WorkbookModel): Impact[] {
  const metrics: Impact[] = []
  const totals: Impact[] = []
  const opts = { locale: after.locale, currency: after.currency }
  const blocks0 = before.sheets.flatMap((s) => s.blocks)
  for (const b1 of after.sheets.flatMap((s) => s.blocks)) {
    if (b1.type === "metric") {
      const b0 = blocks0.find((b) => b.type === "metric" && b.title === b1.title)
      if (b0?.type === "metric" && !same(b0.value, b1.value))
        metrics.push({ label: b1.title, before: formatValue(b0.value, b0.format, { ...opts, decimals: b0.decimals }), after: formatValue(b1.value, b1.format, { ...opts, decimals: b1.decimals }) })
    } else if (b1.type === "table" && b1.totals) {
      const b0 = blocks0.find((b) => b.type === "table" && b.name === b1.name)
      if (b0?.type !== "table" || !b0.totals) continue
      b1.columns.forEach((c, j) => {
        const j0 = b0.columns.findIndex((x) => x.key === c.key)
        const v0 = j0 >= 0 ? b0.totals![j0] : null
        const v1 = b1.totals![j]
        if (v1 == null || v0 == null || same(v0, v1)) return
        totals.push({ label: `${b1.title} · ${c.label}`, before: formatCell(v0, b0.columns[j0], opts), after: formatCell(v1, c, opts) })
      })
    }
  }
  // metrics are the numbers the author chose to headline; a total that repeats one adds nothing
  const seen = new Set(metrics.map((m) => `${m.before}→${m.after}`))
  return [...metrics, ...totals.filter((t) => !seen.has(`${t.before}→${t.after}`))].filter((i) => i.before !== i.after).slice(0, 4)
}

/** Addresses of cells the user would call "changed by this edit" (inputs and additions), per sheet. */
export function touchedCells(d: WorkbookDiff): { sheet: string; address: string }[] {
  return d.sheets.flatMap((s) =>
    Object.entries(s.cells)
      .filter(([, c]) => c.kind !== "computed")
      .map(([a]) => ({ sheet: s.sheet, address: a })),
  )
}

// --- steps -----------------------------------------------------------------------

/** One recorded change. Text edits carry where they applied, so they replay even when the text isn't unique. */
export type StepOp =
  | { kind: "intents"; intents: EditIntent[] }
  | { kind: "replace"; file: string; old: string; new: string; at?: number }
  | { kind: "write"; file: string; text: string }
  | { kind: "batch"; ops: StepOp[] }

/** The workbook code's name in steps, next to data file names. */
export const CODE_FILE = "main"

const fileText = (b: Bundle, file: string) => (file === CODE_FILE ? b.source : b.files[file])
const withFile = (b: Bundle, file: string, text: string): Bundle =>
  file === CODE_FILE ? { ...b, source: text } : { ...b, files: { ...b.files, [file]: text } }

export type OpResult = { ok: true; bundle: Bundle } | { ok: false; error: string }

export function applyOp(b: Bundle, op: StepOp): OpResult {
  switch (op.kind) {
    case "intents":
      return applyEdits(b, op.intents)
    case "write":
      return { ok: true, bundle: withFile(b, op.file, op.text) }
    case "batch": {
      let out = b
      for (const o of op.ops) {
        const r = applyOp(out, o)
        if (!r.ok) return r
        out = r.bundle
      }
      return { ok: true, bundle: out }
    }
    case "replace": {
      const text = fileText(b, op.file)
      if (text === undefined) return { ok: false, error: `No file ${op.file}` }
      if (op.at !== undefined && text.slice(op.at, op.at + op.old.length) === op.old)
        return { ok: true, bundle: withFile(b, op.file, text.slice(0, op.at) + op.new + text.slice(op.at + op.old.length)) }
      const r = replaceOnce(text, op.old, op.new)
      return r.ok ? { ok: true, bundle: withFile(b, op.file, r.source) } : { ok: false, error: r.error }
    }
  }
}

/** The smallest replace op turning `before` into `after` (plus a little context so it replays elsewhere). */
export function textEdit(file: string, before: string, after: string, context = 24): StepOp | null {
  if (before === after) return null
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const from = Math.max(0, start - context)
  const toBefore = Math.min(before.length, before.length - end + context)
  const toAfter = Math.min(after.length, after.length - end + context)
  return { kind: "replace", file, old: before.slice(from, toBefore), new: after.slice(from, toAfter), at: from }
}

/** Ops that turn bundle a into bundle b, file by file. */
export function bundleOp(a: Bundle, b: Bundle): StepOp | null {
  const ops: StepOp[] = []
  const code = textEdit(CODE_FILE, a.source, b.source)
  if (code) ops.push(code)
  for (const [f, text] of Object.entries(b.files)) {
    if (a.files[f] === text) continue
    ops.push(a.files[f] === undefined ? { kind: "write", file: f, text } : textEdit(f, a.files[f], text)!)
  }
  return ops.length === 0 ? null : ops.length === 1 ? ops[0] : { kind: "batch", ops }
}

export interface ReplayResult {
  bundle: Bundle
  /** Step indexes that no longer apply, with why. */
  failed: Map<number, string>
}

/** Apply every op in order onto base, skipping excluded ones; ops that fail are recorded and skipped. */
export function replay(base: Bundle, ops: (StepOp | null)[]): ReplayResult {
  let bundle = base
  const failed = new Map<number, string>()
  ops.forEach((op, i) => {
    if (!op) return
    const r = applyOp(bundle, op)
    if (r.ok) bundle = r.bundle
    else failed.set(i, r.error)
  })
  return { bundle, failed }
}
