// Reference for language models (and people) writing workbook code.
// The app puts this in Claude's system prompt; keep it accurate and short.

export const SDK_REFERENCE = `# xl2 workbook SDK

A workbook is one TypeScript module that default-exports \`workbook(...)\`. The code IS the spreadsheet:
data lives in literal rows, computation lives in formula functions, and the UI renders the evaluated result.
The only importable module is "@xl2/sdk".

\`\`\`ts
import { workbook, sheet, table, query, col, chart, metric, param, text } from "@xl2/sdk"

export default workbook("Name", [
  sheet("Sheet name", [ /* blocks, rendered top-to-bottom in a 4-column grid */ ]),
], { locale: "en-US", currency: "USD" })   // options optional
\`\`\`

## Blocks (every block accepts \`span: 1 | 2 | 3 | 4\`, grid columns out of 4)

- \`table(name, { title?, columns, rows, totals? })\` – editable data. Default span 4.
  - \`columns\`: object of column key -> column type (order = display order).
  - \`rows\`: literal objects \`{ key: value }\` OR tuples \`[v1, v2]\` in the order of the NON-formula columns.
    Prefer tuples for more than ~10 rows. Values are only string | number | boolean | null literals.
  - \`totals\`: \`{ columnKey: "sum" | "avg" | "min" | "max" | "count" }\` footer row.
- \`query(name, (ctx) => Rows | object[], { title?, columns? })\` – derived, read-only table. \`columns\` optionally sets
  labels/formats per key: \`{ revenue: { label: "Revenue", format: "currency" } }\`.
- \`chart.bar | chart.line | chart.area | chart.pie | chart.scatter(title, { data, x, y, aggregate?, stacked?, format? })\`
  - \`data\`: a table/query name, or \`(ctx) => Rows | object[]\`. \`x\`: key for the category axis. \`y\`: key or keys.
  - \`aggregate: "sum" | ...\` groups rows by x first. Default span 2.
- \`metric(title, (ctx) => value, { format?, decimals?, caption?: string | (ctx) => string })\` – KPI tile. Span 1.
- \`param(name, literal, { label?, format?, min?, max?, step?, options? })\` – an editable input value. Read with \`ctx.param(name)\`.
- \`text(markdown)\` – headings (#), **bold**, lists (- ), paragraphs.

## Column types (all take \`{ label?, format?, decimals? }\`)
\`col.text()\`, \`col.number()\`, \`col.currency({ currency?: "EUR" })\`, \`col.percent()\` (stored as a fraction, 0.25 = 25%),
\`col.date()\` (ISO "2026-01-31" strings), \`col.boolean()\`, \`col.select(["A","B"])\`,
\`col.formula((row, ctx) => value, { format? })\` – computed per row; read-only in the grid.
Formats: "text" | "number" | "integer" | "currency" | "percent" | "date" | "boolean".

## Formula context
- \`row.someColumn\` – any column of the same row, including other formulas.
- \`ctx.table(name)\` – Rows of any table or query (a formula may read its own table, e.g. share of total).
- \`ctx.param(name)\`, \`ctx.index\`, \`ctx.rows\` (records of this table), \`ctx.prev\` (previous row or undefined, for running totals:
  \`col.formula((r, ctx) => (ctx.prev?.balance ?? 0) + r.amount)\`).

## Rows API (returned by ctx.table and accepted from queries)
\`length, toArray(), column(key), sum(key), avg(key), min(key), max(key), count(key?), first(), last(), at(i),
filter((row, i) => bool), map((row, i) => row), sortBy(key | fn, "asc" | "desc"), take(n),
groupBy(key | fn, { outKey: "sum" | "avg" | ... | [sourceKey, agg] | (rows) => value }), lookup(keyCol, keyValue, returnCol?)\`
groupBy output has the group key under the same key name (or "key" when grouped by a function) plus each aggregate.

## Rules
- Table and query names are global across sheets and must be unique. Use camelCase keys.
- Keep data in \`rows\` literals so the grid stays editable; the app edits those literals in place when a user types in a cell.
- Errors in a formula show as #ERR in that cell only. Division by zero shows #DIV/0.
- No network, DOM or async in workbook code. Keep it deterministic.
`
