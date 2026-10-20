import type { ColumnKind, Literal } from "./types"

// Data files: CSV text that a table reads with `rows: data("sales.csv")`.
// The first line holds column keys. Parsing keeps offsets so edits can
// replace a single cell's text and leave the rest of the file alone.

export interface CsvCell {
  text: string
  start: number
  end: number
}
export interface CsvRecord {
  cells: CsvCell[]
  start: number
  /** End of the record, before its line break. */
  end: number
  /** End including the line break. */
  next: number
}

export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const rec: CsvRecord = { cells: [], start: i, end: i, next: i }
    for (;;) {
      const start = i
      let value = ""
      if (text[i] === '"') {
        i++
        for (;;) {
          if (i >= n) break
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              value += '"'
              i += 2
              continue
            }
            i++
            break
          }
          value += text[i++]
        }
        // tolerate junk after a closing quote
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") value += text[i++]
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") value += text[i++]
      }
      rec.cells.push({ text: value, start, end: i })
      if (text[i] === ",") {
        i++
        continue
      }
      break
    }
    rec.end = i
    if (text[i] === "\r") i++
    if (text[i] === "\n") i++
    rec.next = i
    records.push(rec)
  }
  return records
}

export function encodeCsvValue(v: Literal): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function encodeCsvRow(values: Literal[]): string {
  return values.map(encodeCsvValue).join(",")
}

export function coerceCsvValue(raw: string, kind: ColumnKind): Literal {
  if (raw === "") return null
  switch (kind) {
    case "number":
    case "currency":
    case "percent": {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    case "boolean":
      return /^(true|1|yes)$/i.test(raw) ? true : /^(false|0|no)$/i.test(raw) ? false : raw
    default:
      return raw
  }
}

/** Records keyed by header, coerced by column kind. */
export function readDataFile(text: string, kinds: Record<string, ColumnKind>): Record<string, Literal>[] {
  const [header, ...body] = parseCsvRecords(text)
  if (!header) return []
  const keys = header.cells.map((c) => c.text.trim())
  return body.map((r) => {
    const rec: Record<string, Literal> = {}
    keys.forEach((k, i) => {
      if (k in kinds) rec[k] = coerceCsvValue(r.cells[i]?.text ?? "", kinds[k])
    })
    return rec
  })
}

export function dataRowCount(text: string): number {
  return Math.max(0, parseCsvRecords(text).length - 1)
}
