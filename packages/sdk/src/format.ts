import { isCellError, type CellValue, type ColumnModel } from "./engine"
import type { ColumnKind, Format, Literal } from "./types"

export interface FormatOptions {
  locale?: string
  currency?: string
  decimals?: number
}

const nf = new Map<string, Intl.NumberFormat>()
function numberFormat(locale: string, opts: Intl.NumberFormatOptions) {
  const key = locale + JSON.stringify(opts)
  let f = nf.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, opts)
    nf.set(key, f)
  }
  return f
}

/** Display string for a value. */
export function formatValue(value: CellValue | undefined, format: Format, o: FormatOptions = {}): string {
  if (value === null || value === undefined) return ""
  if (isCellError(value)) return "#ERR"
  const locale = o.locale ?? "en-US"
  if (typeof value === "boolean") return value ? "✓" : "✗"
  if (typeof value === "number") {
    switch (format) {
      case "currency":
        return numberFormat(locale, {
          style: "currency",
          currency: o.currency ?? "USD",
          minimumFractionDigits: o.decimals ?? 2,
          maximumFractionDigits: o.decimals ?? 2,
        }).format(value)
      case "percent":
        return numberFormat(locale, {
          style: "percent",
          minimumFractionDigits: o.decimals ?? 1,
          maximumFractionDigits: o.decimals ?? 1,
        }).format(value)
      case "integer":
        return numberFormat(locale, { maximumFractionDigits: 0 }).format(value)
      case "text":
        return String(value)
      default:
        return numberFormat(locale, {
          minimumFractionDigits: o.decimals ?? 0,
          maximumFractionDigits: o.decimals ?? 2,
        }).format(value)
    }
  }
  if (format === "date") {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    }
  }
  return String(value)
}

export function formatCell(value: CellValue, column: ColumnModel, o: FormatOptions = {}) {
  return formatValue(value, column.format, {
    ...o,
    currency: column.currency ?? o.currency,
    decimals: column.decimals ?? o.decimals,
  })
}

/** Raw text to show in an editor for a value. */
export function editText(value: CellValue, kind: ColumnKind): string {
  if (value === null || isCellError(value)) return ""
  if (kind === "percent" && typeof value === "number") return `${+(value * 100).toFixed(10)}%`
  return String(value)
}

export type Coerced = { ok: true; value: Literal } | { ok: false; error: string }

/** Parse what a user typed into a typed literal for the column. */
export function coerceInput(raw: string, kind: ColumnKind, options?: string[]): Coerced {
  const s = raw.trim()
  if (s === "") return { ok: true, value: null }
  switch (kind) {
    case "number":
    case "currency":
    case "percent": {
      const pct = s.endsWith("%")
      const cleaned = s.replace(/[%\s,$€£¥]|kr|NOK|USD|EUR/gi, "")
      const n = Number(cleaned)
      if (!Number.isFinite(n)) return { ok: false, error: `"${raw}" is not a number` }
      if (pct || kind === "percent") return { ok: true, value: +(n / 100).toPrecision(12) }
      return { ok: true, value: n }
    }
    case "boolean": {
      if (/^(true|yes|y|1|x|✓)$/i.test(s)) return { ok: true, value: true }
      if (/^(false|no|n|0|✗)$/i.test(s)) return { ok: true, value: false }
      return { ok: false, error: `"${raw}" is not true/false` }
    }
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, value: s }
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return { ok: false, error: `"${raw}" is not a date` }
      const iso = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
      return { ok: true, value: iso }
    }
    case "select":
      if (options && !options.includes(s)) return { ok: false, error: `Pick one of: ${options.join(", ")}` }
      return { ok: true, value: s }
    case "formula":
      return { ok: false, error: "Computed cells are defined in code" }
    default:
      return { ok: true, value: s }
  }
}

export function kindForFormat(format: Format): ColumnKind {
  switch (format) {
    case "currency":
    case "percent":
    case "date":
    case "boolean":
      return format
    case "text":
      return "text"
    default:
      return "number"
  }
}
