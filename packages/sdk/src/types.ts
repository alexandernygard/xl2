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
  /** Grid columns this block spans, out of 4. */
  span?: 1 | 2 | 3 | 4
}

export interface TableDef extends BlockBase {
  type: "table"
  name: string
  title?: string
  columns: Record<string, ColumnDef>
  /** Literal rows: objects keyed by column, or tuples in data-column order. */
  rows: (Record<string, Literal> | Literal[])[]
  /** Footer aggregates per column. */
  totals?: Record<string, Aggregate>
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

export interface SheetDef {
  type: "sheet"
  name: string
  blocks: BlockDef[]
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
