// A1-style addressing. Rows and columns are 0-based internally; "A1" is (0, 0).

export interface Cell {
  row: number
  col: number
}

/** A rectangle of cells: top-left corner plus size. */
export interface Rect {
  row: number
  col: number
  rows: number
  cols: number
}

export function colName(col: number): string {
  let s = ""
  let n = col + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export function colIndex(name: string): number {
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function address(row: number, col: number): string {
  return `${colName(col)}${row + 1}`
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d+)$/

export function parseAddress(a: string): Cell | null {
  const m = CELL.exec(a.trim())
  if (!m || +m[2] < 1) return null
  return { row: +m[2] - 1, col: colIndex(m[1]) }
}

/** "B2" or "B2:D9" (either corner order). */
export function parseRange(r: string): Rect | null {
  const [a, b] = r.split(":")
  const p = parseAddress(a)
  if (!p) return null
  const q = b === undefined ? p : parseAddress(b)
  if (!q) return null
  const row = Math.min(p.row, q.row)
  const col = Math.min(p.col, q.col)
  return { row, col, rows: Math.abs(p.row - q.row) + 1, cols: Math.abs(p.col - q.col) + 1 }
}

export function rangeName(r: Rect): string {
  const a = address(r.row, r.col)
  if (r.rows === 1 && r.cols === 1) return a
  return `${a}:${address(r.row + r.rows - 1, r.col + r.cols - 1)}`
}

export function contains(r: Rect, row: number, col: number) {
  return row >= r.row && row < r.row + r.rows && col >= r.col && col < r.col + r.cols
}

export function intersects(a: Rect, b: Rect) {
  return a.row < b.row + b.rows && b.row < a.row + a.rows && a.col < b.col + b.cols && b.col < a.col + a.cols
}
