import { encodeCsvRow } from "./datafile"
import { literalCode } from "./source"
import type { Literal } from "./types"

// CSV import: either table code with literal rows, or a data file plus a
// table that reads it with data("file.csv").

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const delim = text.split("\n")[0].includes(";") && !text.split("\n")[0].includes(",") ? ";" : ","
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  if (cell !== "" || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

function toKey(header: string, i: number) {
  const words = header.trim().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean)
  if (!words.length) return `col${i + 1}`
  const key = words.map((w, j) => (j === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("")
  return /^\d/.test(key) ? `c${key}` : key
}

function inferColumns(text: string) {
  const [header, ...body] = parseCsv(text)
  if (!header) throw new Error("The CSV is empty")
  const keys = header.map(toKey)
  const kinds = keys.map((_, i) => {
    const vals = body.map((r) => r[i]?.trim() ?? "").filter((v) => v !== "")
    if (vals.length && vals.every((v) => /^-?[\d.,]+$/.test(v) && Number.isFinite(Number(v.replace(/,/g, ""))))) return "number"
    if (vals.length && vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return "date"
    if (vals.length && vals.every((v) => /^(true|false)$/i.test(v))) return "boolean"
    return "text"
  })
  const value = (raw: string | undefined, kind: string): Literal => {
    const v = (raw ?? "").trim()
    if (v === "") return null
    if (kind === "number") return Number(v.replace(/,/g, ""))
    if (kind === "boolean") return /^true$/i.test(v)
    return v
  }
  return { header, body, keys, kinds, value }
}

function columnsCode(header: string[], keys: string[], kinds: string[], indent: string) {
  return keys
    .map((k, i) => {
      const label = header[i].trim() !== k ? `{ label: ${JSON.stringify(header[i].trim())} }` : ""
      return `${indent}${k}: col.${kinds[i]}(${label}),`
    })
    .join("\n")
}

/** Generate a `table(...)` call with literal rows from CSV text. */
export function csvToTableCode(name: string, text: string, indent = "    "): string {
  const { header, body, keys, kinds, value } = inferColumns(text)
  const i2 = indent + "  "
  const i3 = i2 + "  "
  const cols = columnsCode(header, keys, kinds, i3)
  const rows = body.map((r) => `${i3}[${keys.map((_, i) => literalCode(value(r[i], kinds[i]))).join(", ")}],`).join("\n")
  return `table(${JSON.stringify(name)}, {\n${i2}columns: {\n${cols}\n${i2}},\n${i2}rows: [\n${rows}\n${i2}],\n${indent}})`
}

/** A data file (header rewritten to column keys) plus a table that reads it. */
export function csvToDataTable(
  name: string,
  text: string,
  options: { at?: string; indent?: string } = {},
): { code: string; file: string; data: string } {
  const { header, body, keys, kinds, value } = inferColumns(text)
  const indent = options.indent ?? "    "
  const i2 = indent + "  "
  const file = `${name}.csv`
  const data = [encodeCsvRow(keys), ...body.map((r) => encodeCsvRow(keys.map((_, i) => value(r[i], kinds[i]))))].join("\n") + "\n"
  const at = options.at ? `\n${i2}at: ${JSON.stringify(options.at)},` : ""
  const code = `table(${JSON.stringify(name)}, {${at}\n${i2}columns: {\n${columnsCode(header, keys, kinds, i2 + "  ")}\n${i2}},\n${i2}rows: data(${JSON.stringify(file)}),\n${indent}})`
  return { code, file, data }
}
