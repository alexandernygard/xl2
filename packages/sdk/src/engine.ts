import { RowList, aggregate } from "./rows"
import type {
  Aggregate,
  BlockDef,
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
  TableDef,
  WorkbookDef,
} from "./types"

// Evaluation: turns a WorkbookDef (code) into a WorkbookModel (values),
// which is all a renderer needs. Formulas are computed lazily so they can
// reference other columns, rows and tables in any order.

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
  /** Computed by a formula (read-only in the grid). */
  computed: boolean
}

export interface TableModel {
  type: "table"
  /** "table" holds literal rows (editable); "query" is derived. */
  source: "table" | "query"
  id: string
  name: string
  title: string
  columns: ColumnModel[]
  rows: CellValue[][]
  totals?: (CellValue | null)[]
  span: number
  error?: string
}

export interface ChartModel {
  type: "chart"
  id: string
  kind: ChartKind
  title: string
  x: string
  series: { key: string; label: string }[]
  data: Row[]
  stacked: boolean
  format: Format
  span: number
  error?: string
}

export interface MetricModel {
  type: "metric"
  id: string
  title: string
  value: CellValue
  format: Format
  decimals?: number
  caption?: string
  span: number
  error?: string
}

export interface ParamModel {
  type: "param"
  id: string
  name: string
  label: string
  value: Literal
  format: Format
  min?: number
  max?: number
  step?: number
  options?: string[]
  span: number
}

export interface TextModel {
  type: "text"
  id: string
  content: string
  span: number
}

export type BlockModel = TableModel | ChartModel | MetricModel | ParamModel | TextModel

export interface SheetModel {
  name: string
  blocks: BlockModel[]
}

export interface WorkbookModel {
  name: string
  locale: string
  currency: string
  sheets: SheetModel[]
  /** Definition problems (duplicate names etc.), not per-cell errors. */
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

export function dataColumns(def: TableDef): string[] {
  return Object.entries(def.columns)
    .filter(([, c]) => c.kind !== "formula")
    .map(([k]) => k)
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

class CycleError extends Error {}

export function evaluate(wb: WorkbookDef): WorkbookModel {
  const issues: string[] = []
  const tables = new Map<string, TableDef | QueryDef>()
  const params = new Map<string, ParamDef>()

  for (const s of wb.sheets) {
    for (const b of s.blocks) {
      if (b.type === "table" || b.type === "query") {
        if (tables.has(b.name)) issues.push(`Duplicate table name "${b.name}"`)
        tables.set(b.name, b)
      } else if (b.type === "param") {
        if (params.has(b.name)) issues.push(`Duplicate param name "${b.name}"`)
        params.set(b.name, b)
      }
    }
  }

  const cache = new Map<string, Row[]>()
  const building = new Set<string>()

  const ctx: EvalContext = {
    table(name) {
      return new RowList(records(name))
    },
    param(name) {
      const p = params.get(name)
      if (!p) throw new Error(`Unknown param "${name}"`)
      return p.value
    },
  }

  function records(name: string): Row[] {
    const hit = cache.get(name)
    if (hit) return hit
    const def = tables.get(name)
    if (!def) throw new Error(`Unknown table "${name}"`)
    if (def.type === "table") {
      const rows = tableRecords(def)
      cache.set(name, rows)
      return rows
    }
    if (building.has(name)) throw new CycleError(`Circular reference through query "${name}"`)
    building.add(name)
    try {
      const out = def.fn(ctx)
      const rows = out instanceof RowList ? out.toArray() : Array.isArray(out) ? out : (out as Rows).toArray()
      cache.set(name, rows)
      return rows
    } finally {
      building.delete(name)
    }
  }

  // Records with formula columns as memoized getters. Registered in the cache
  // before any formula runs, so a formula may read its own table.
  function tableRecords(def: TableDef): Row[] {
    const order = dataColumns(def)
    const formulas = Object.entries(def.columns).filter(([, c]) => c.kind === "formula")
    const rows: Row[] = []
    cache.set(def.name, rows)
    def.rows.forEach((lit, index) => {
      const rec: Row = {}
      if (Array.isArray(lit)) order.forEach((k, i) => (rec[k] = lit[i] ?? null))
      else order.forEach((k) => (rec[k] = lit?.[k] ?? null))
      for (const [key, c] of formulas) {
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

  const safe = (fn: () => any): CellValue => {
    try {
      return normalize(fn())
    } catch (e) {
      return { error: message(e) }
    }
  }

  let seq = 0
  const sheets = wb.sheets.map((s) => ({
    name: s.name,
    blocks: s.blocks.map((b) => evalBlock(b, `${s.name}:${seq++}`)),
  }))

  function evalBlock(b: BlockDef, id: string): BlockModel {
    switch (b.type) {
      case "table":
        return evalTable(b, id)
      case "query":
        return evalQuery(b, id)
      case "chart":
        return evalChart(b, id)
      case "metric": {
        const value = safe(() => b.value(ctx))
        let caption: string | undefined
        try {
          caption = typeof b.caption === "function" ? b.caption(ctx) : b.caption
        } catch (e) {
          caption = `Error: ${message(e)}`
        }
        return {
          type: "metric",
          id,
          title: b.title,
          value,
          format: b.format ?? (typeof value === "number" ? "number" : "text"),
          decimals: b.decimals,
          caption,
          span: b.span ?? 1,
          error: isCellError(value) ? value.error : undefined,
        }
      }
      case "param":
        return {
          type: "param",
          id,
          name: b.name,
          label: b.label ?? b.name,
          value: b.value,
          format: b.format ?? (typeof b.value === "number" ? "number" : typeof b.value === "boolean" ? "boolean" : "text"),
          min: b.min,
          max: b.max,
          step: b.step,
          options: b.options,
          span: b.span ?? 1,
        }
      case "text":
        return { type: "text", id, content: b.content, span: b.span ?? 4 }
    }
  }

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

  function evalTable(def: TableDef, id: string): TableModel {
    const columns = Object.entries(def.columns).map(([k, c]) => columnModel(k, c))
    const base = {
      type: "table" as const,
      source: "table" as const,
      id,
      name: def.name,
      title: def.title ?? def.name,
      columns,
      span: def.span ?? 4,
    }
    try {
      const recs = records(def.name)
      const rows = recs.map((r) => columns.map((c) => safe(() => r[c.key])))
      return { ...base, rows, totals: totalsFor(columns, rows, def.totals) }
    } catch (e) {
      return { ...base, rows: [], error: message(e) }
    }
  }

  function evalQuery(def: QueryDef, id: string): TableModel {
    const base = {
      type: "table" as const,
      source: "query" as const,
      id,
      name: def.name,
      title: def.title ?? def.name,
      span: def.span ?? 4,
    }
    try {
      const recs = records(def.name)
      const keys = def.columns ? Object.keys(def.columns) : Object.keys(recs[0] ?? {})
      const columns = keys.map((k) => {
        const spec = def.columns?.[k]
        const sample = recs.find((r) => r[k] !== null && r[k] !== undefined)?.[k]
        const kind: ColumnKind = spec?.kind ?? (typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "text")
        return { ...columnModel(k, { ...spec, kind }), computed: true }
      })
      const rows = recs.map((r) => columns.map((c) => safe(() => r[c.key])))
      return { ...base, columns, rows }
    } catch (e) {
      return { ...base, columns: [], rows: [], error: message(e) }
    }
  }

  function evalChart(def: ChartDef, id: string): ChartModel {
    const ys = Array.isArray(def.y) ? def.y : [def.y]
    const labelFor = (key: string) => {
      const t = typeof def.data === "string" ? tables.get(def.data) : undefined
      if (t?.type === "table") return t.columns[key]?.label ?? key
      return t?.columns?.[key]?.label ?? key
    }
    const model: ChartModel = {
      type: "chart",
      id,
      kind: def.kind,
      title: def.title,
      x: def.x,
      series: ys.map((k) => ({ key: k, label: labelFor(k) })),
      data: [],
      stacked: def.stacked ?? false,
      format: def.format ?? "number",
      span: def.span ?? 2,
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

  return {
    name: wb.name,
    locale: wb.locale ?? "en-US",
    currency: wb.currency ?? "USD",
    sheets,
    issues,
  }
}

function normalize(v: any): CellValue {
  if (v === undefined || v === null) return null
  if (typeof v === "number") return Number.isFinite(v) ? v : { error: v > 0 || v < 0 ? "#DIV/0" : "#NUM" }
  if (typeof v === "string" || typeof v === "boolean") return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (isCellError(v)) return v
  return JSON.stringify(v)
}
