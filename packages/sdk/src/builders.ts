import type {
  BlockDef,
  ChartDef,
  ChartKind,
  ColumnDef,
  DataRef,
  EvalContext,
  FormulaFn,
  Literal,
  MetricDef,
  ParamDef,
  QueryDef,
  SheetDef,
  SheetOptions,
  TableDef,
  TextDef,
  WorkbookDef,
  WorkbookOptions,
} from "./types"

// The authoring API. Workbook code imports these from "@xl2/sdk".

export function workbook(name: string, sheets: SheetDef[], options: WorkbookOptions = {}): WorkbookDef {
  return { type: "workbook", name, sheets, ...options }
}

export function sheet(name: string, blocks: BlockDef[] = [], options: SheetOptions = {}): SheetDef {
  return { type: "sheet", name, blocks, cells: options.cells ?? {}, widths: options.widths ?? {} }
}

/** Rows read from a CSV data file in the workbook bundle. The first line holds column keys. */
export function data(file: string): DataRef {
  return { type: "data", file }
}

export function table(
  name: string,
  def: Omit<TableDef, "type" | "name" | "rows"> & { rows?: TableDef["rows"] },
): TableDef {
  return { type: "table", name, ...def, rows: def.rows ?? [] }
}

export function query(
  name: string,
  fn: QueryDef["fn"],
  options: Omit<QueryDef, "type" | "name" | "fn"> = {},
): QueryDef {
  return { type: "query", name, fn, ...options }
}

export function param(
  name: string,
  value: Literal,
  options: Omit<ParamDef, "type" | "name" | "value"> = {},
): ParamDef {
  return { type: "param", name, value, ...options }
}

export function metric(
  title: string,
  value: (ctx: EvalContext) => any,
  options: Omit<MetricDef, "type" | "title" | "value"> = {},
): MetricDef {
  return { type: "metric", title, value, ...options }
}

export function text(content: string, options: Omit<TextDef, "type" | "content"> = {}): TextDef {
  return { type: "text", content, ...options }
}

type ColOptions = Omit<ColumnDef, "kind" | "fn">

export const col = {
  text: (o: ColOptions = {}): ColumnDef => ({ kind: "text", ...o }),
  number: (o: ColOptions = {}): ColumnDef => ({ kind: "number", ...o }),
  currency: (o: ColOptions = {}): ColumnDef => ({ kind: "currency", ...o }),
  percent: (o: ColOptions = {}): ColumnDef => ({ kind: "percent", ...o }),
  date: (o: ColOptions = {}): ColumnDef => ({ kind: "date", ...o }),
  boolean: (o: ColOptions = {}): ColumnDef => ({ kind: "boolean", ...o }),
  select: (options: string[], o: ColOptions = {}): ColumnDef => ({ kind: "select", options, ...o }),
  formula: (fn: FormulaFn, o: ColOptions = {}): ColumnDef => ({ kind: "formula", fn, ...o }),
}

type ChartOptions = Omit<ChartDef, "type" | "kind" | "title">

function chartOf(kind: ChartKind) {
  return (title: string, options: ChartOptions): ChartDef => ({ type: "chart", kind, title, ...options })
}

export const chart = {
  bar: chartOf("bar"),
  line: chartOf("line"),
  area: chartOf("area"),
  pie: chartOf("pie"),
  scatter: chartOf("scatter"),
}


export * from "./functions"
