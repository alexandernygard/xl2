// Definitions: what workbook code produces. These are plain data plus
// functions (formulas), built with the helpers in builders.ts.

export type Literal = string | number | boolean | null

export type Format =
  | "text"
  | "number"
  | "integer"
  | "currency"
  | "percent"
  | "date"
  | "boolean"

export type ColumnKind =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "boolean"
  | "select"
  | "formula"

export type Aggregate = "sum" | "avg" | "min" | "max" | "count" | "first" | "last"

/** A record as seen by formulas: column key -> value. */
export type Row = Record<string, any>

export interface ColumnDef {
  kind: ColumnKind
  label?: string
  /** Display format. Defaults from kind (formulas default to "number"). */
  format?: Format
  /** Fraction digits for number/currency/percent display. */
  decimals?: number
  /** ISO 4217 code for currency columns; falls back to the workbook currency. */
  currency?: string
  /** Allowed values for select columns. */
  options?: string[]
  /** Computes the cell from its row. Only for kind "formula". */
  fn?: FormulaFn
}

export interface RowContext extends EvalContext {
  /** Index of the row being computed. */
  index: number
  /** All rows of this table (formula values are computed lazily). */
  rows: Row[]
  /** The previous row, or undefined for the first row. */
  prev: Row | undefined
}

export type FormulaFn = (row: Row, ctx: RowContext) => any

export interface EvalContext {
  /** Rows of a table or query by name. */
  table(name: string): Rows
  /** Current value of a param. */
  param(name: string): any
  /** Value of a grid cell: "B3" (on the block's sheet) or "Sheet 2!B3". */
  cell(ref: string): any
  /** Values of a grid range, row by row, flattened: "B2:B9". */
  range(ref: string): any[]
}

/** Query helper over a list of records. Implemented in rows.ts. */
export interface Rows {
  readonly length: number
  toArray(): Row[]
  column(key: string): any[]
  sum(key: string): number
  avg(key: string): number
  min(key: string): number
  max(key: string): number
  count(key?: string): number
  first(): Row | undefined
  last(): Row | undefined
  at(index: number): Row | undefined
  filter(pred: (row: Row, index: number) => boolean): Rows
  map(fn: (row: Row, index: number) => Row): Rows
  sortBy(key: string | ((row: Row) => any), dir?: "asc" | "desc"): Rows
  take(n: number): Rows
  groupBy(
    key: string | ((row: Row) => any),
    aggregates: Record<string, Aggregate | [string, Aggregate] | ((rows: Rows) => any)>,
  ): Rows
  lookup(keyColumn: string, keyValue: any, returnColumn?: string): any
  [Symbol.iterator](): Iterator<Row>
}

export interface BlockBase {
  /**
   * Where the block sits on the sheet grid. A cell ("B4") anchors the top-left corner
   * and uses the block's natural size; a range ("H2:M14") also sets the size.
   * Blocks without `at` are stacked down column A.
   */
  at?: string
  /** @deprecated Ignored. Use `at`. */
  span?: number
}

/** Rows stored in a CSV data file next to the workbook code. */
export interface DataRef {
  type: "data"
  file: string
}

/** A hand-typed value that replaces one computed cell. */
export interface Override {
  row: number
  column: string
  value: Literal
  note?: string
}

export interface TableDef extends BlockBase {
  type: "table"
  name: string
  title?: string
  columns: Record<string, ColumnDef>
  /** Literal rows (objects keyed by column, or tuples in data-column order), or data("file.csv"). */
  rows: (Record<string, Literal> | Literal[])[] | DataRef
  /** Footer aggregates per column. */
  totals?: Record<string, Aggregate>
  /** Hand-typed values over formula cells. */
  overrides?: Override[]
}

export interface QueryDef extends BlockBase {
  type: "query"
  name: string
  title?: string
  fn: (ctx: EvalContext) => Rows | Row[]
  /** Optional column formats; otherwise inferred from the first row. */
  columns?: Record<string, Partial<ColumnDef>>
}

export type ChartKind = "bar" | "line" | "area" | "pie" | "scatter"

export interface ChartDef extends BlockBase {
  type: "chart"
  kind: ChartKind
  title: string
  /** Table or query name, or a function returning rows. */
  data: string | ((ctx: EvalContext) => Rows | Row[])
  x: string
  y: string | string[]
  /** Group rows by x and combine y values. */
  aggregate?: Aggregate
  stacked?: boolean
  format?: Format
}

export interface MetricDef extends BlockBase {
  type: "metric"
  title: string
  value: (ctx: EvalContext) => any
  format?: Format
  decimals?: number
  caption?: string | ((ctx: EvalContext) => string)
}

export interface ParamDef extends BlockBase {
  type: "param"
  name: string
  value: Literal
  label?: string
  format?: Format
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface TextDef extends BlockBase {
  type: "text"
  content: string
}

export type BlockDef = TableDef | QueryDef | ChartDef | MetricDef | ParamDef | TextDef

export type Tone = "muted" | "positive" | "negative" | "accent"

export interface CellStyle {
  format?: Format
  decimals?: number
  bold?: boolean
  italic?: boolean
  align?: "left" | "center" | "right"
  tone?: Tone
}

/** A free cell: a literal, a formula string starting with "=", or either plus styling. */
export type CellEntry = Literal | (CellStyle & { value: Literal })

export interface SheetOptions {
  /** Free cells by A1 address: `{ A1: "Title", B3: 0.08, C3: "=B3 * 2" }`. */
  cells?: Record<string, CellEntry>
  /** Column widths in pixels by column letter: `{ A: 160 }`. */
  widths?: Record<string, number>
}

export interface SheetDef {
  type: "sheet"
  name: string
  blocks: BlockDef[]
  cells: Record<string, CellEntry>
  widths: Record<string, number>
}

export interface WorkbookOptions {
  /** BCP 47 locale for number and date display. */
  locale?: string
  /** Default ISO 4217 currency. */
  currency?: string
}

export interface WorkbookDef extends WorkbookOptions {
  type: "workbook"
  name: string
  sheets: SheetDef[]
}
