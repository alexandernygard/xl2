import { formatCell, formatValue, isCellError, type CellInfo, type CellValue, type Format } from "@xl2/sdk"
import type { ViewContext } from "./types"

// How a grid cell looks: display text, alignment and classes. Pure, so the
// grid can call it for every visible cell on every scroll frame.

export interface CellLook {
  text: string
  align: "left" | "center" | "right"
  className: string
  title?: string
  /** Small corner marker: an override or a formula. */
  marker?: "override" | "formula"
  /** Boolean cells render a checkbox glyph. */
  check?: boolean
}

const TONE: Record<string, string> = {
  muted: "text-muted-foreground",
  positive: "text-positive",
  negative: "text-destructive",
  accent: "text-highlight-foreground bg-highlight/15",
}

function errorText(v: { error: string }) {
  const m = /^#[A-Z/0-9]+/.exec(v.error)
  return m ? m[0] : "#ERR"
}

function inferFormat(v: CellValue): Format {
  if (typeof v === "number") return "number"
  if (typeof v === "boolean") return "boolean"
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date"
  return "text"
}

const alignFor = (v: CellValue): CellLook["align"] => (typeof v === "number" ? "right" : typeof v === "boolean" ? "center" : "left")

export function cellLook(info: CellInfo, ctx: ViewContext): CellLook | null {
  switch (info.kind) {
    case "empty":
    case "overlay":
      return null
    case "free": {
      const { value, style, formula } = info.cell
      if (isCellError(value))
        return { text: errorText(value), align: "left", className: "text-destructive", title: value.error, marker: formula ? "formula" : undefined }
      const text = formatValue(value, style?.format ?? inferFormat(value), { ...ctx, decimals: style?.decimals })
      return {
        text,
        align: style?.align ?? alignFor(value),
        className: [style?.bold && "font-semibold", style?.italic && "italic", style?.tone && TONE[style.tone]].filter(Boolean).join(" "),
        title: formula ? `${formula}` : undefined,
        marker: formula ? "formula" : undefined,
      }
    }
    case "param": {
      const p = info.param
      if (info.part === "label") return { text: p.label, align: "left", className: "text-muted-foreground" }
      return {
        text: formatValue(p.value, p.format, ctx),
        align: typeof p.value === "number" ? "right" : "left",
        className: "bg-highlight/10 font-medium",
        title: `param "${p.name}"`,
      }
    }
    case "table": {
      const { region, column, value } = info
      if (region.kind === "title") return null
      if (region.kind === "header")
        return {
          text: column?.label ?? "",
          align: column && ["number", "currency", "percent", "formula"].includes(column.kind) ? "right" : "left",
          className: "bg-muted font-medium text-foreground",
        }
      if (!column) return null
      if (region.kind === "add") return { text: "", align: "left", className: "bg-muted/30" }
      const total = region.kind === "totals"
      if (isCellError(value))
        return { text: errorText(value), align: "left", className: "text-destructive", title: value.error }
      const look: CellLook = {
        text: column.kind === "boolean" && typeof value === "boolean" ? "" : formatCell(value, column, ctx),
        align: column.kind === "boolean" ? "center" : typeof value === "number" ? "right" : "left",
        className: [
          total && "bg-muted/60 font-semibold",
          column.computed && !info.overridden && !total && "text-info",
          info.table.source === "query" && !total && "text-foreground",
        ]
          .filter(Boolean)
          .join(" "),
        marker: info.overridden ? "override" : undefined,
        title: info.overridden ? "Typed over the formula. Clear the cell to restore it." : undefined,
      }
      if (column.kind === "boolean" && typeof value === "boolean") look.check = value
      return look
    }
  }
}
