import { address, colIndex, intersects, parseAddress, parseRange, type Rect } from "./address"
import { dataRowCount, readDataFile } from "./datafile"
import { compileFormula, isFormula } from "./formula"
import { functions } from "./functions"
import { RowList, aggregate } from "./rows"
import type {
  Aggregate,
  BlockDef,
  CellEntry,
  CellStyle,
  ChartDef,
  ChartKind,
  ColumnDef,
  ColumnKind,
  EvalContext,
  Format,
  Literal,
  ParamDef,
  QueryDef,
  Row,
  Rows,
  SheetDef,
  TableDef,
  WorkbookDef,
} from "./types"

// Evaluation: turns a WorkbookDef (code) plus its data files into a
// WorkbookModel (values placed on each sheet's grid), which is all a renderer
// needs. Everything is lazy and memoized, so formulas, cells, tables and
// queries can reference each other in any order; cycles become errors.

export type CellError = { error: string }
export type CellValue = Literal | CellError

export const isCellError = (v: unknown): v is CellError =>
  typeof v === "object" && v !== null && "error" in v

export interface ColumnModel {
  key: string
  label: string
  kind: ColumnKind
  format: Format
  decimals?: number
  currency?: string
  options?: string[]
  /** Computed by a formula (typing over it creates an override). */
  computed: boolean
}

interface BlockModelBase {
  id: string
  /** Position in the sheet's block list (in code). */
  index: number
  /** Cells the block covers on the sheet grid. */
  rect: Rect
  /** The block's `at` came from code (false: auto-placed). */
  placed: boolean
}

export interface TableModel extends BlockModelBase {
  type: "table"
  /** "table" holds literal or file rows (editable); "query" is derived. */
  source: "table" | "query"
  name: string
  title: string
  columns: ColumnModel[]
  rows: CellValue[][]
  totals?: (CellValue | null)[]
  /** Set when rows come from data("file.csv"). */
  dataFile?: string
  /** "row:column" keys of overridden formula cells. */
  overridden: string[]
  error?: string
}

export interface ChartModel extends BlockModelBase {
  type: "chart"
  kind: ChartKind
  title: string
  x: string
  series: { key: string; label: string }[]
  data: Row[]
  stacked: boolean
  format: Format
  error?: string
}

export interface MetricModel extends BlockModelBase {
  type: "metric"
  title: string
  value: CellValue
  format: Format
  decimals?: number
  caption?: string
  error?: string
}

export interface ParamModel extends BlockModelBase {
  type: "param"
  name: string
  label: string
  value: Literal
  format: Format
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface TextModel extends BlockModelBase {
  type: "text"
  content: string
}

export type BlockModel = TableModel | ChartModel | MetricModel | ParamModel | TextModel

export interface CellModel {
  value: CellValue
  /** The formula text ("=B3*2") when the cell is computed. */
  formula?: string
  style?: CellStyle
}

export interface SheetModel {
  name: string
  index: number
  blocks: BlockModel[]
  /** Free cells by A1 address. */
  cells: Record<string, CellModel>
  /** Explicit column widths by column index. */
  widths: Record<number, number>
  /** Rows and columns in use. */
  extent: { rows: number; cols: number }
}

export interface WorkbookModel {
  name: string
  locale: string
  currency: string
  sheets: SheetModel[]
  /** Definition problems (duplicate names, overlaps etc.), not per-cell errors. */
  issues: string[]
}

const DEFAULT_FORMAT: Record<ColumnKind, Format> = {
  text: "text",
  number: "number",
  currency: "currency",
  percent: "percent",
  date: "date",
  boolean: "boolean",
  select: "text",
  formula: "number",
}

/** Natural block sizes in grid cells. */
export const BLOCK_SIZE = {
  chart: { rows: 13, cols: 6 },
  metric: { rows: 3, cols: 2 },
  param: { rows: 1, cols: 2 },
  text: { cols: 6 },
}

export function dataColumns(def: TableDef): string[] {
  return Object.entries(def.columns)
    .filter(([, c]) => c.kind !== "formula")
    .map(([k]) => k)
}

/** What a grid row inside a table's rect shows. */
export type TableRegion =
  | { kind: "title" }
  | { kind: "header" }
  | { kind: "data"; index: number }
  | { kind: "add" }
  | { kind: "totals" }

/** Layout of a table on the grid: title row, header row, data rows, an "add" row (editable tables), totals. */
export function tableRegion(t: { rect: Rect; source: "table" | "query"; rows: unknown[]; totals?: unknown }, row: number): TableRegion | null {
  const r = row - t.rect.row
  if (r < 0 || r >= t.rect.rows) return null
  if (r === 0) return { kind: "title" }
  if (r === 1) return { kind: "header" }
  const i = r - 2
  if (i < t.rows.length) return { kind: "data", index: i }
  if (t.source === "table" && i === t.rows.length) return { kind: "add" }
  return t.totals ? { kind: "totals" } : null
}

function tableHeight(source: "table" | "query", rows: number, totals: boolean) {
  return 2 + rows + (source === "table" ? 1 : 0) + (totals ? 1 : 0)
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

class CycleError extends Error {}

type CellState = { state: "busy" } | { state: "done"; value: CellValue }

export function evaluate(wb: WorkbookDef, files: Record<string, string> = {}): WorkbookModel {
  const issues: string[] = []
  const sheets: SheetDef[] = wb.sheets.map((s) => ({ ...s, blocks: s.blocks ?? [], cells: s.cells ?? {}, widths: s.widths ?? {} }))
  const tables = new Map<string, { def: TableDef | QueryDef; sheet: number }>()
  const params = new Map<string, { def: ParamDef; sheet: number }>()
  const sheetIndex = new Map<string, number>()

  sheets.forEach((s, si) => {
    if (sheetIndex.has(s.name)) issues.push(`Duplicate sheet name "${s.name}"`)
    sheetIndex.set(s.name, si)
    for (const b of s.blocks) {
      if (b.type === "table" || b.type === "query") {
        if (tables.has(b.name)) issues.push(`Duplicate table name "${b.name}"`)
        tables.set(b.name, { def: b, sheet: si })
      } else if (b.type === "param") {
        if (params.has(b.name)) issues.push(`Duplicate param name "${b.name}"`)
        params.set(b.name, { def: b, sheet: si })
      }
    }
  })

  const cache = new Map<string, Row[]>()
  const building = new Set<string>()
  const contexts: EvalContext[] = sheets.map((_, si) => makeContext(si))

  function makeContext(si: number): EvalContext {
    return {
      table: (name) => new RowList(records(name)),
      param(name) {
        const p = params.get(name)
        if (!p) throw new Error(`Unknown param "${name}"`)
        return p.def.value
      },
      cell: (ref) => {
        const { sheet, rest } = splitSheet(ref, si)
        const a = parseAddress(rest)
        if (!a) throw new Error(`#REF: "${ref}" is not a cell address`)
        return unwrap(cellValue(sheet, a.row, a.col))
      },
      range: (ref) => {
        const { sheet, rest } = splitSheet(ref, si)
        const r = parseRange(rest)
        if (!r) throw new Error(`#REF: "${ref}" is not a range`)
        return rangeValues(sheet, r)
      },
    }
  }

  function splitSheet(ref: string, si: number) {
    const bang = ref.lastIndexOf("!")
    if (bang < 0) return { sheet: si, rest: ref }
    const name = ref.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'")
    return { sheet: resolveSheet(name), rest: ref.slice(bang + 1) }
  }

  function resolveSheet(name: string | null | undefined, fallback?: number): number {
    if (name === null || name === undefined) return fallback!
    const i = sheetIndex.get(name)
    if (i === undefined) throw new Error(`#REF: no sheet named "${name}"`)
    return i
  }

  const unwrap = (v: CellValue) => {
    if (isCellError(v)) throw new Error(v.error)
    return v
  }

  // --- tables and queries ----------------------------------------------------

  function literalRows(def: TableDef): (Record<string, Literal> | Literal[])[] {
    if (Array.isArray(def.rows)) return def.rows
    if (def.rows?.type === "data") {
      const text = files[def.rows.file]
      if (text === undefined) throw new Error(`Missing data file "${def.rows.file}"`)
      const kinds = Object.fromEntries(Object.entries(def.columns).map(([k, c]) => [k, c.kind]))
      return readDataFile(text, kinds)
    }
    return []
  }

  function records(name: string): Row[] {
    const hit = cache.get(name)
    if (hit) return hit
    const entry = tables.get(name)
    if (!entry) throw new Error(`Unknown table "${name}"`)
    const def = entry.def
    if (def.type === "table") return tableRecords(def, contexts[entry.sheet])
    if (building.has(name)) throw new CycleError(`Circular reference through query "${name}"`)
    building.add(name)
    try {
      const out = def.fn(contexts[entry.sheet])
      const rows = out instanceof RowList ? out.toArray() : Array.isArray(out) ? out : (out as Rows).toArray()
      cache.set(name, rows)
      return rows
    } finally {
      building.delete(name)
    }
  }

  // Records with formula columns as memoized getters. Registered in the cache
  // before any formula runs, so a formula may read its own table.
  function tableRecords(def: TableDef, ctx: EvalContext): Row[] {
    const order = dataColumns(def)
    const formulas = Object.entries(def.columns).filter(([, c]) => c.kind === "formula")
    const overrides = new Map((def.overrides ?? []).map((o) => [`${o.row}:${o.column}`, o.value]))
    const rows: Row[] = []
    cache.set(def.name, rows)
    literalRows(def).forEach((lit, index) => {
      const rec: Row = {}
      if (Array.isArray(lit)) order.forEach((k, i) => (rec[k] = lit[i] ?? null))
      else order.forEach((k) => (rec[k] = lit?.[k] ?? null))
      for (const [key, c] of formulas) {
        const ov = `${index}:${key}`
        if (overrides.has(ov)) {
          rec[key] = overrides.get(ov)
          continue
        }
        let state: "idle" | "busy" | "done" | "err" = "idle"
        let value: any
        let err: unknown
        Object.defineProperty(rec, key, {
          enumerable: true,
          get() {
            if (state === "done") return value
            if (state === "err") throw err
            if (state === "busy") throw new CycleError(`Circular reference in ${def.name}.${key}`)
            state = "busy"
            try {
              value = c.fn!(rec, { ...ctx, index, rows, prev: rows[index - 1] })
              if (value === undefined || Number.isNaN(value)) value = null
              state = "done"
              return value
            } catch (e) {
              err = e
              state = "err"
              throw e
            }
          },
        })
      }
      rows.push(rec)
    })
    return rows
  }

  function queryKeys(def: QueryDef): string[] {
    return def.columns ? Object.keys(def.columns) : Object.keys(records(def.name)[0] ?? {})
  }

  // --- layout ------------------------------------------------------------------

  const layouts = new Map<number, { rects: Rect[]; placed: boolean[] }>()
  const laying = new Set<number>()

  function naturalSize(b: BlockDef): { rows: number; cols: number } {
    switch (b.type) {
      case "table": {
        let n = 0
        try {
          n = Array.isArray(b.rows)
            ? b.rows.length
            : b.rows?.type === "data" && files[b.rows.file] !== undefined
              ? dataRowCount(files[b.rows.file])
              : 0
        } catch {
          n = 0
        }
        return { rows: tableHeight("table", n, !!b.totals), cols: Math.max(1, Object.keys(b.columns).length) }
      }
      case "query": {
        try {
          return { rows: tableHeight("query", records(b.name).length, false), cols: Math.max(1, queryKeys(b).length) }
        } catch (e) {
          if (e instanceof CycleError) throw e
          return { rows: 3, cols: 3 }
        }
      }
      case "chart":
        return BLOCK_SIZE.chart
      case "metric":
        return BLOCK_SIZE.metric
      case "param":
        return BLOCK_SIZE.param
      case "text": {
        const lines = b.content.split("\n").reduce((n, l) => n + (/^# /.test(l.trim()) ? 2 : 1), 0)
        return { rows: Math.max(1, lines), cols: BLOCK_SIZE.text.cols }
      }
    }
  }

  /**
   * Resolve overlaps from the top down: a block that collides with one above it
   * (a table that grew, or an auto-placed block) moves below it, leaving a gap row.
   * Blocks with an `at` claim their spot first; auto-placed ones fit in after.
   */
  function settle(rects: Rect[], placed: boolean[]): Rect[] {
    const order = rects
      .map((_, i) => i)
      .sort((a, b) => +placed[b] - +placed[a] || rects[a].row - rects[b].row || rects[a].col - rects[b].col || a - b)
    const out = rects.slice()
    const done: Rect[] = []
    for (const i of order) {
      let r = out[i]
      for (let hit = done.find((d) => intersects(d, r)); hit; hit = done.find((d) => intersects(d, r)))
        r = { ...r, row: hit.row + hit.rows + 1 }
      out[i] = r
      done.push(r)
    }
    return out
  }

  function layout(si: number) {
    const hit = layouts.get(si)
    if (hit) return hit
    if (laying.has(si)) throw new CycleError(`The layout of sheet "${sheets[si].name}" depends on its own cells`)
    laying.add(si)
    try {
      let cursor = 0
      const rects: Rect[] = []
      const placed: boolean[] = []
      for (const b of sheets[si].blocks) {
        const size = naturalSize(b)
        const at = b.at ? parseRange(b.at) : null
        if (b.at && !at) issues.push(`${sheets[si].name}: "${b.at}" is not a cell or range`)
        let rect: Rect
        if (at) {
          const sized = b.at!.includes(":") && b.type !== "table" && b.type !== "query" && b.type !== "param"
          rect = sized ? at : { row: at.row, col: at.col, ...size }
        } else {
          rect = { row: cursor, col: 0, ...size }
          cursor += size.rows + 1
        }
        rects.push(rect)
        placed.push(!!at)
      }
      const out = { rects: settle(rects, placed), placed }
      layouts.set(si, out)
      return out
    } finally {
      laying.delete(si)
    }
  }

  // --- cells -------------------------------------------------------------------

  const cellStates = new Map<string, CellState>()
  const freeCells: Map<string, CellEntry>[] = sheets.map((s) => {
    const m = new Map<string, CellEntry>()
    for (const [k, v] of Object.entries(s.cells)) {
      const a = parseAddress(k)
      if (!a) issues.push(`${s.name}: "${k}" is not a cell address`)
      else m.set(address(a.row, a.col), v)
    }
    return m
  })

  const entryValue = (e: CellEntry): Literal =>
    e !== null && typeof e === "object" ? (e as { value: Literal }).value ?? null : (e as Literal)

  function cellValue(si: number, row: number, col: number): CellValue {
    const key = `${si}!${row},${col}`
    const st = cellStates.get(key)
    if (st?.state === "done") return st.value
    if (st?.state === "busy") return { error: `#CYCLE: circular reference at ${sheets[si].name}!${address(row, col)}` }
    cellStates.set(key, { state: "busy" })
    let value: CellValue
    try {
      value = computeCell(si, row, col)
    } catch (e) {
      value = { error: message(e) }
    }
    cellStates.set(key, { state: "done", value })
    return value
  }

  function computeCell(si: number, row: number, col: number): CellValue {
    const entry = freeCells[si].get(address(row, col))
    if (entry !== undefined) {
      const v = entryValue(entry)
      if (isFormula(v)) return normalize(compileFormula(v)(scope(si)))
      return v
    }
    const { rects } = layout(si)
    const blocks = sheets[si].blocks
    for (let i = 0; i < blocks.length; i++) {
      const r = rects[i]
      if (row < r.row || row >= r.row + r.rows || col < r.col || col >= r.col + r.cols) continue
      const b = blocks[i]
      const c = col - r.col
      if (b.type === "param") return c === 0 ? (b.label ?? b.name) : b.value
      if (b.type !== "table" && b.type !== "query") return null
      const keys = b.type === "table" ? Object.keys(b.columns) : queryKeys(b)
      const key = keys[c]
      if (key === undefined) return null
      const recs = records(b.name)
      const region = tableRegion(
        { rect: r, source: b.type === "table" ? "table" : "query", rows: recs, totals: b.type === "table" ? b.totals : undefined },
        row,
      )
      if (!region) return null
      const label = (b.type === "table" ? b.columns[key]?.label : b.columns?.[key]?.label) ?? key
      switch (region.kind) {
        case "title":
          return c === 0 ? (b.title ?? b.name) : null
        case "header":
          return label
        case "data":
          return normalize(recs[region.index][key])
        case "add":
          return null
        case "totals": {
          const agg = b.type === "table" ? b.totals?.[key] : undefined
          return agg ? normalize(aggregate(recs.map((x) => x[key]), agg)) : null
        }
      }
    }
    return null
  }

  function rangeValues(si: number, r: Rect): any[] {
    if (r.rows * r.cols > 1_000_000) throw new Error("#REF: range too large")
    const out: any[] = []
    for (let row = r.row; row < r.row + r.rows; row++)
      for (let col = r.col; col < r.col + r.cols; col++) out.push(unwrap(cellValue(si, row, col)))
    return out
  }

  const scopes = new Map<number, object>()
  function scope(si: number): object {
    const hit = scopes.get(si)
    if (hit) return hit
    const ctx = contexts[si]
    const s = new Proxy(
      {},
      {
        has: (_, k) =>
          typeof k === "string" && (k in functions || k === "__ref" || k === "__range" || k === "ctx" || tables.has(k) || params.has(k)),
        get: (_, k) => {
          if (typeof k !== "string") return undefined
          if (k === "__ref")
            return (sheet: string | null, a: string) => {
              const p = parseAddress(a)!
              return unwrap(cellValue(resolveSheet(sheet, si), p.row, p.col))
            }
          if (k === "__range") return (sheet: string | null, a: string, b: string) => rangeValues(resolveSheet(sheet, si), parseRange(`${a}:${b}`)!)
          if (k === "ctx") return ctx
          if (k in functions) return (functions as Record<string, unknown>)[k]
          if (tables.has(k)) return ctx.table(k)
          if (params.has(k)) return params.get(k)!.def.value
          return undefined
        },
      },
    )
    scopes.set(si, s)
    return s
  }

  const safe = (fn: () => any): CellValue => {
    try {
      return normalize(fn())
    } catch (e) {
      return { error: message(e) }
    }
  }

  // --- block models --------------------------------------------------------------

  function columnModel(key: string, c: Partial<ColumnDef>): ColumnModel {
    const kind = c.kind ?? "number"
    return {
      key,
      label: c.label ?? key,
      kind,
      format: c.format ?? DEFAULT_FORMAT[kind],
      decimals: c.decimals,
      currency: c.currency,
      options: c.options,
      computed: kind === "formula",
    }
  }

  function totalsFor(columns: ColumnModel[], rows: CellValue[][], spec?: Record<string, Aggregate>) {
    if (!spec) return undefined
    return columns.map((c, i) => {
      const agg = spec[c.key]
      if (!agg) return null
      const values = rows.map((r) => r[i])
      const bad = values.find(isCellError)
      if (bad) return bad
      return normalize(aggregate(values, agg))
    })
  }

  function evalTable(def: TableDef, base: BlockModelBase): TableModel {
    const columns = Object.entries(def.columns).map(([k, c]) => columnModel(k, c))
    const model: TableModel = {
      ...base,
      type: "table",
      source: "table",
      name: def.name,
      title: def.title ?? def.name,
      columns,
      rows: [],
      dataFile: !Array.isArray(def.rows) && def.rows?.type === "data" ? def.rows.file : undefined,
      overridden: (def.overrides ?? []).map((o) => `${o.row}:${o.column}`),
    }
    try {
      const recs = records(def.name)
      model.rows = recs.map((r) => columns.map((c) => safe(() => r[c.key])))
      model.totals = totalsFor(columns, model.rows, def.totals)
    } catch (e) {
      model.error = message(e)
    }
    return model
  }

  function evalQuery(def: QueryDef, base: BlockModelBase): TableModel {
    const model: TableModel = {
      ...base,
      type: "table",
      source: "query",
      name: def.name,
      title: def.title ?? def.name,
      columns: [],
      rows: [],
      overridden: [],
    }
    try {
      const recs = records(def.name)
      model.columns = queryKeys(def).map((k) => {
        const spec = def.columns?.[k]
        const sample = recs.find((r) => r[k] !== null && r[k] !== undefined)?.[k]
        const kind: ColumnKind = spec?.kind ?? (typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "text")
        return { ...columnModel(k, { ...spec, kind }), computed: true }
      })
      model.rows = recs.map((r) => model.columns.map((c) => safe(() => r[c.key])))
    } catch (e) {
      model.error = message(e)
    }
    return model
  }

  function evalChart(def: ChartDef, base: BlockModelBase, ctx: EvalContext): ChartModel {
    const ys = Array.isArray(def.y) ? def.y : [def.y]
    const labelFor = (key: string) => {
      const t = typeof def.data === "string" ? tables.get(def.data)?.def : undefined
      if (t?.type === "table") return t.columns[key]?.label ?? key
      return t?.columns?.[key]?.label ?? key
    }
    const model: ChartModel = {
      ...base,
      type: "chart",
      kind: def.kind,
      title: def.title,
      x: def.x,
      series: ys.map((k) => ({ key: k, label: labelFor(k) })),
      data: [],
      stacked: def.stacked ?? false,
      format: def.format ?? "number",
    }
    try {
      let rows: Row[] =
        typeof def.data === "string"
          ? records(def.data)
          : (() => {
              const out = def.data(ctx)
              return Array.isArray(out) ? out : out.toArray()
            })()
      if (def.aggregate) {
        const agg = def.aggregate
        rows = new RowList(rows).groupBy(def.x, Object.fromEntries(ys.map((y) => [y, agg]))).toArray()
      }
      model.data = rows.map((r) => {
        const point: Row = { [def.x]: r[def.x] }
        for (const y of ys) {
          const v = r[y]
          point[y] = typeof v === "number" && Number.isFinite(v) ? v : v === null ? null : Number(v) || 0
        }
        return point
      })
    } catch (e) {
      model.error = message(e)
    }
    return model
  }

  function evalBlock(b: BlockDef, base: BlockModelBase, ctx: EvalContext): BlockModel {
    switch (b.type) {
      case "table":
        return evalTable(b, base)
      case "query":
        return evalQuery(b, base)
      case "chart":
        return evalChart(b, base, ctx)
      case "metric": {
        const value = safe(() => b.value(ctx))
        let caption: string | undefined
        try {
          caption = typeof b.caption === "function" ? b.caption(ctx) : b.caption
        } catch (e) {
          caption = `Error: ${message(e)}`
        }
        return {
          ...base,
          type: "metric",
          title: b.title,
          value,
          format: b.format ?? (typeof value === "number" ? "number" : "text"),
          decimals: b.decimals,
          caption,
          error: isCellError(value) ? value.error : undefined,
        }
      }
      case "param":
        return {
          ...base,
          type: "param",
          name: b.name,
          label: b.label ?? b.name,
          value: b.value,
          format: b.format ?? (typeof b.value === "number" ? "number" : typeof b.value === "boolean" ? "boolean" : "text"),
          min: b.min,
          max: b.max,
          step: b.step,
          options: b.options,
        }
      case "text":
        return { ...base, type: "text", content: b.content }
    }
  }

  const sheetModels: SheetModel[] = sheets.map((s, si) => {
    let lay: { rects: Rect[]; placed: boolean[] }
    try {
      lay = layout(si)
    } catch (e) {
      issues.push(message(e))
      lay = { rects: s.blocks.map((_, i) => ({ row: i * 3, col: 0, rows: 2, cols: 2 })), placed: s.blocks.map(() => false) }
    }
    const blocks = s.blocks.map((b, i) =>
      evalBlock(b, { id: `${si}:${i}`, index: i, rect: lay.rects[i], placed: lay.placed[i] }, contexts[si]),
    )

    // grow table rects that turned out larger than the literal count suggested (file rows etc.)
    for (const b of blocks) {
      if (b.type === "table") b.rect = { ...b.rect, rows: tableHeight(b.source, b.rows.length, !!b.totals) }
    }
    settle(blocks.map((b) => b.rect), blocks.map((b) => b.placed)).forEach((r, i) => (blocks[i].rect = r))
    for (let i = 0; i < blocks.length; i++)
      for (let j = i + 1; j < blocks.length; j++)
        if (intersects(blocks[i].rect, blocks[j].rect))
          issues.push(`${s.name}: ${blockLabel(blocks[i])} overlaps ${blockLabel(blocks[j])}`)

    const cells: Record<string, CellModel> = {}
    for (const [a, entry] of freeCells[si]) {
      const p = parseAddress(a)!
      const covering = blocks.find((b) => p.row >= b.rect.row && p.row < b.rect.row + b.rect.rows && p.col >= b.rect.col && p.col < b.rect.col + b.rect.cols)
      if (covering) issues.push(`${s.name}: cell ${a} is under ${blockLabel(covering)}`)
      const raw = entryValue(entry)
      const style = entry !== null && typeof entry === "object" ? styleOf(entry as CellStyle) : undefined
      cells[a] = { value: cellValue(si, p.row, p.col), formula: isFormula(raw) ? raw : undefined, style }
    }

    let rows = 0
    let cols = 0
    for (const b of blocks) {
      rows = Math.max(rows, b.rect.row + b.rect.rows)
      cols = Math.max(cols, b.rect.col + b.rect.cols)
    }
    for (const a of Object.keys(cells)) {
      const p = parseAddress(a)!
      rows = Math.max(rows, p.row + 1)
      cols = Math.max(cols, p.col + 1)
    }
    const widths: Record<number, number> = {}
    for (const [k, w] of Object.entries(s.widths)) if (/^[A-Z]{1,3}$/i.test(k) && w > 0) widths[colIndex(k)] = w

    return { name: s.name, index: si, blocks, cells, widths, extent: { rows, cols } }
  })

  return {
    name: wb.name,
    locale: wb.locale ?? "en-US",
    currency: wb.currency ?? "USD",
    sheets: sheetModels,
    issues,
  }
}

function styleOf(e: CellStyle): CellStyle | undefined {
  const { format, decimals, bold, italic, align, tone } = e
  const s: CellStyle = { format, decimals, bold, italic, align, tone }
  for (const k of Object.keys(s) as (keyof CellStyle)[]) if (s[k] === undefined) delete s[k]
  return Object.keys(s).length ? s : undefined
}

export function blockLabel(b: BlockModel): string {
  switch (b.type) {
    case "table":
      return `${b.source} "${b.name}"`
    case "param":
      return `param "${b.name}"`
    case "text":
      return "a text block"
    default:
      return `${b.type} "${b.title}"`
  }
}

function normalize(v: any): CellValue {
  if (v === undefined || v === null) return null
  if (typeof v === "number") return Number.isFinite(v) ? v : { error: v > 0 || v < 0 ? "#DIV/0" : "#NUM" }
  if (typeof v === "string" || typeof v === "boolean") return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (isCellError(v)) return v
  if (Array.isArray(v)) return v.length === 1 ? normalize(v[0]) : { error: "#VALUE: a range can't be shown in one cell" }
  return JSON.stringify(v)
}
