import { formatCell, isCellError, type SheetModel } from "@xl2/sdk"
import type { ViewContext } from "./types"

export const ROW_H = 28
export const HEADER_H = 24
export const ROW_HEADER_W = 48
export const DEFAULT_W = 100
export const MIN_W = 36
export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

/** Column offsets with a few custom widths among many default ones. */
export class Columns {
  private readonly custom: [number, number][]

  constructor(widths: Record<number, number>) {
    this.custom = Object.entries(widths)
      .map(([c, w]) => [+c, Math.max(MIN_W, w)] as [number, number])
      .sort((a, b) => a[0] - b[0])
  }

  width(c: number): number {
    for (const [i, w] of this.custom) if (i === c) return w
    return DEFAULT_W
  }

  /** Left edge of column c. */
  offset(c: number): number {
    let x = c * DEFAULT_W
    for (const [i, w] of this.custom) {
      if (i >= c) break
      x += w - DEFAULT_W
    }
    return x
  }

  /** Column containing x (clamped at 0). */
  indexAt(x: number): number {
    if (x <= 0) return 0
    let start = 0
    let col = 0
    for (const [i, w] of this.custom) {
      const before = start + (i - col) * DEFAULT_W
      if (x < before) return col + Math.floor((x - start) / DEFAULT_W)
      if (x < before + w) return i
      start = before + w
      col = i + 1
    }
    return col + Math.floor((x - start) / DEFAULT_W)
  }
}

/**
 * Widths for columns without an explicit width: tables widen their columns to
 * fit labels and values (sampled), never narrower than the default.
 */
export function autoWidths(sheet: SheetModel, ctx: ViewContext): Record<number, number> {
  const out: Record<number, number> = {}
  const fit = (c: number, chars: number) => {
    const w = Math.min(280, Math.max(DEFAULT_W, Math.round(chars * 7.4 + 24)))
    out[c] = Math.max(out[c] ?? 0, w)
  }
  for (const b of sheet.blocks) {
    if (b.type === "table") {
      b.columns.forEach((col, i) => {
        let chars = col.label.length + 2
        for (const row of b.rows.slice(0, 60)) {
          const v = row[i]
          if (v === null || isCellError(v)) continue
          chars = Math.max(chars, formatCell(v, col, ctx).length)
        }
        const t = b.totals?.[i]
        if (t !== undefined && t !== null && !isCellError(t)) chars = Math.max(chars, formatCell(t, col, ctx).length + 1)
        fit(b.rect.col + i, chars)
      })
    } else if (b.type === "param") {
      fit(b.rect.col, b.label.length)
      fit(b.rect.col + 1, 10)
    }
  }
  for (const [c, w] of Object.entries(out)) if (w === DEFAULT_W) delete out[+c]
  return { ...out, ...sheet.widths }
}
