// Reference for language models (and people) writing workbook code.
// The app puts this in Claude's system prompt; keep it accurate and short.

export const SDK_REFERENCE = `# xl2 workbook SDK

A workbook is one TypeScript module that default-exports \`workbook(...)\`, plus optional CSV data files. The code IS the
spreadsheet: each sheet is an infinite grid (A1 addressing, like Excel). Blocks are placed on it with \`at\`; free cells
hold literals or formulas. The only importable module is "@xl2/sdk".

\`\`\`ts
import { workbook, sheet, table, query, col, chart, metric, param, text, data } from "@xl2/sdk"

export default workbook("Name", [
  sheet("Sheet name", [ /* blocks */ ], {
    cells: { A1: "Title", B3: 0.08, C3: "=B3 * 2", D3: { value: "=SUM(B5:B9)", format: "currency", bold: true } },
    widths: { A: 160 },          // column widths in px (optional)
  }),
], { locale: "en-US", currency: "USD" })   // options optional
\`\`\`

## Placing blocks: \`at\`
Every block takes \`at\`: a cell ("B4", the top-left corner) or a range ("H2:M14", corner plus size).
- Tables and queries use their natural size: 1 title row + 1 header row + one row per record (+ 1 empty "add row" for
  tables, which the user types into to append) + 1 totals row if \`totals\`. One grid column per table column.
- Params take 2 cells in a row: label, then value (\`at\` is the label cell).
- Charts default to 6 columns × 13 rows, metrics 2 × 3, text 6 columns × its lines. Give a range to size them.
- Blocks must not overlap each other or free cells (overlaps are reported as issues). Leave a blank row/column between.
- Blocks without \`at\` stack down column A (avoid this; always set \`at\`).

## Blocks
- \`table(name, { at, title?, columns, rows, totals?, overrides? })\` – editable data.
  - \`columns\`: object of column key -> column type (order = display order).
  - \`rows\`: literal objects \`{ key: value }\` OR tuples \`[v1, v2]\` in the order of the NON-formula columns, OR
    \`data("file.csv")\` to read a CSV data file (header line = column keys). Use a data file for more than ~30 rows.
  - \`totals\`: \`{ columnKey: "sum" | "avg" | "min" | "max" | "count" }\` footer row.
  - \`overrides\`: \`[{ row: 2, column: "revenue", value: 1200, note?: "why" }]\` hand-typed values over formula cells.
- \`query(name, (ctx) => Rows | object[], { at, title?, columns? })\` – derived, read-only table. \`columns\` optionally sets
  labels/formats per key: \`{ revenue: { label: "Revenue", format: "currency" } }\`.
- \`chart.bar | chart.line | chart.area | chart.pie | chart.scatter(title, { data, x, y, aggregate?, stacked?, format?, at })\`
  - \`data\`: a table/query name, or \`(ctx) => Rows | object[]\`. \`x\`: key for the category axis. \`y\`: key or keys.
  - \`aggregate: "sum" | ...\` groups rows by x first.
- \`metric(title, (ctx) => value, { at, format?, decimals?, caption?: string | (ctx) => string })\` – KPI tile.
- \`param(name, literal, { at, label?, format?, min?, max?, step?, options? })\` – an input cell. Read with \`ctx.param(name)\`.
- \`text(markdown, { at })\` – headings (#), **bold**, lists (- ), paragraphs.

## Free cells and cell formulas
\`cells\` maps A1 addresses to a literal, a formula string starting with "=", or \`{ value, format?, decimals?, bold?,
italic?, align?: "left"|"center"|"right", tone?: "muted"|"positive"|"negative"|"accent" }\`.
A cell formula is a JavaScript expression with spreadsheet conveniences:
- References: \`B3\`, \`$B$3\`, ranges \`B2:B9\` (an array), other sheets \`Inputs!B3\`, \`'My sheet'!A1:A4\`. A reference can point
  into a table (header, data or totals cells), a param's value cell, or another free cell.
- Table names are Rows objects and param names are values: \`=sales.sum("revenue") * (1 + growth)\`.
- Functions: SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT MEDIAN ROUND ROUNDUP ROUNDDOWN ABS SQRT POWER MOD IF IFERROR AND OR
  NOT SUMIF COUNTIF AVERAGEIF XLOOKUP CONCAT LEN UPPER LOWER TRIM TODAY DATE YEAR MONTH DAY EOMONTH DAYS PMT FV NPV IRR.
  Criteria are Excel-style strings (">10") or functions. Use JS operators (== / && / ||); \`<>\` also works for "not equal".
- Code can read cells too: \`ctx.cell("B3")\`, \`ctx.cell("Inputs!B3")\`, \`ctx.range("B2:B9")\`. The functions above are also
  exported from "@xl2/sdk" for use in code.

## Column types (all take \`{ label?, format?, decimals? }\`)
\`col.text()\`, \`col.number()\`, \`col.currency({ currency?: "EUR" })\`, \`col.percent()\` (stored as a fraction, 0.25 = 25%),
\`col.date()\` (ISO "2026-01-31" strings), \`col.boolean()\`, \`col.select(["A","B"])\`,
\`col.formula((row, ctx) => value, { format? })\` – computed per row.
Formats: "text" | "number" | "integer" | "currency" | "percent" | "date" | "boolean".

## Formula context (table formulas, queries, metrics)
- \`row.someColumn\` – any column of the same row, including other formulas.
- \`ctx.table(name)\` – Rows of any table or query (a formula may read its own table, e.g. share of total).
- \`ctx.param(name)\`, \`ctx.cell(ref)\`, \`ctx.range(ref)\`, \`ctx.index\`, \`ctx.rows\` (records of this table), \`ctx.prev\`
  (previous row or undefined, for running totals: \`col.formula((r, ctx) => (ctx.prev?.balance ?? 0) + r.amount)\`).

## Rows API (returned by ctx.table and accepted from queries)
\`length, toArray(), column(key), sum(key), avg(key), min(key), max(key), count(key?), first(), last(), at(i),
filter((row, i) => bool), map((row, i) => row), sortBy(key | fn, "asc" | "desc"), take(n),
groupBy(key | fn, { outKey: "sum" | "avg" | ... | [sourceKey, agg] | (rows) => value }), lookup(keyCol, keyValue, returnCol?)\`
groupBy output has the group key under the same key name (or "key" when grouped by a function) plus each aggregate.

## Rules
- Table, query and param names are global across sheets and must be unique. Use camelCase keys. Sheet names are unique.
- Keep data in literal \`rows\` or data files so the grid stays editable; the app edits those in place when a user types.
- Errors show in the cell only (#ERR, #DIV/0, #REF, #CYCLE). Circular references are detected.
- No network, DOM or async in workbook code. Keep it deterministic. Code runs in a sandboxed worker with a time limit.
`
