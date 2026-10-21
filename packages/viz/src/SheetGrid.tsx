import * as React from "react"
import {
  address,
  blockLabel,
  cellAt,
  contains,
  intersects,
  parseAddress,
  cellLabel,
  clearIntents,
  clipCell,
  colName,
  editTextFor,
  fillIntents,
  inputIntents,
  isEditable,
  isOverlay,
  jump,
  parseTsv,
  pasteIntents,
  rangeName,
  styleIntents,
  type BlockModel,
  type CellInfo,
  type ClipCell,
  type EditIntent,
  type Format,
  type ParamModel,
  type Rect,
  type SheetDiff,
  type SheetModel,
  type TableModel,
} from "@xl2/sdk"
import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Slider,
  cn,
} from "@alexandernygard/components"
import { ArrowDownIcon, ArrowUpIcon, ChartBarIcon, CheckIcon, CodeIcon, DatabaseIcon, EllipsisIcon, FileSpreadsheetIcon, GripVerticalIcon, PlusIcon, TableIcon, Trash2Icon } from "lucide-react"
import { cellLook } from "./cellView"
import { Columns, HEADER_H, MAX_COLS, MAX_ROWS, MIN_W, ROW_H, ROW_HEADER_W, autoWidths } from "./geometry"
import { OverlayContent } from "./overlays"
import { AddColumn } from "./AddColumn"
import type { GridSelection, IntentHandler, ViewContext } from "./types"

export type GridAction =
  | { type: "reveal"; block: number }
  | { type: "chartFromTable"; table: string; kind: "bar" | "line" | "pie" }

export interface SheetGridProps {
  sheet: SheetModel
  ctx: ViewContext
  selection: GridSelection | null
  selectedBlock: number | null
  onSelect: (sel: GridSelection | null) => void
  onSelectBlock: (index: number | null) => void
  onIntent: IntentHandler
  onError?: (message: string) => void
  onAction?: (action: GridAction) => void
  /** Changes under review, highlighted cell by cell. */
  changes?: SheetDiff | null
  className?: string
  ref?: React.Ref<SheetGridHandle>
}

export interface SheetGridHandle {
  focus(): void
  scrollTo(row: number, col: number): void
  /** Start editing the focused cell with this text (e.g. from a formula bar). */
  edit(text?: string): void
}

type Editing = { row: number; col: number; text: string; original: string; mode: "enter" | "edit" }

type Drag =
  | { kind: "select" }
  | { kind: "fill"; source: Rect; target: Rect }
  | { kind: "move"; block: BlockModel; origin: Rect; rect: Rect; x: number; y: number; moved: boolean }
  | { kind: "resize"; block: BlockModel; origin: Rect; rect: Rect }
  | { kind: "width"; col: number; startX: number; startW: number; w: number }

const FORMATS: { format: Format | null; label: string }[] = [
  { format: null, label: "Automatic" },
  { format: "number", label: "Number" },
  { format: "integer", label: "Integer" },
  { format: "currency", label: "Currency" },
  { format: "percent", label: "Percent" },
  { format: "date", label: "Date" },
  { format: "text", label: "Text" },
]

export const selectionRect = (s: GridSelection): Rect => ({
  row: Math.min(s.anchor.row, s.focus.row),
  col: Math.min(s.anchor.col, s.focus.col),
  rows: Math.abs(s.anchor.row - s.focus.row) + 1,
  cols: Math.abs(s.anchor.col - s.focus.col) + 1,
})

const one = (row: number, col: number): GridSelection => ({ anchor: { row, col }, focus: { row, col } })

let internalClip: { text: string; cells: ClipCell[][]; from: { row: number; col: number } } | null = null

/** One sheet as an infinite, virtualized grid. Tables, params and free cells sit in cells; charts, metrics and text float over them. */
export function SheetGrid({ sheet, ctx, selection, selectedBlock, onSelect, onSelectBlock, onIntent, onError, onAction, changes, className, ref }: SheetGridProps) {
  const scroller = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const [view, setView] = React.useState({ top: 0, left: 0, w: 1200, h: 800 })
  const [editing, setEditing] = React.useState<Editing | null>(null)
  const [drag, setDrag] = React.useState<Drag | null>(null)
  const dragRef = React.useRef<Drag | null>(null)
  dragRef.current = drag
  // the editor's blur fires after Enter/Tab already committed; only the live edit may commit
  const live = React.useRef<Editing | null>(null)
  live.current = editing

  const changed = React.useMemo(
    () =>
      Object.entries(changes?.cells ?? {}).flatMap(([a, c]) => {
        const p = parseAddress(a)
        return p ? [{ ...p, ...c }] : []
      }),
    [changes],
  )
  const blockChanges = React.useMemo(() => {
    const m = new Map<number, string>()
    for (const b of changes?.blocks ?? []) {
      if (b.index === undefined) continue
      const kind = b.kind === "moved" ? "edited" : b.kind
      if (!m.has(b.index) || kind === "edited") m.set(b.index, kind)
    }
    return m
  }, [changes])

  const widths = React.useMemo(() => autoWidths(sheet, ctx), [sheet, ctx])
  const columns = React.useMemo(
    () => new Columns(drag?.kind === "width" ? { ...widths, [drag.col]: drag.w } : widths),
    [widths, drag],
  )

  // the grid grows as you scroll: always some room past the content and the viewport
  const [limit, setLimit] = React.useState({ rows: 200, cols: 40 })
  const r0 = Math.max(0, Math.floor(view.top / ROW_H) - 2)
  const r1 = Math.min(MAX_ROWS - 1, Math.ceil((view.top + view.h) / ROW_H) + 2)
  const c0 = Math.max(0, columns.indexAt(view.left) - 1)
  const c1 = Math.min(MAX_COLS - 1, columns.indexAt(view.left + view.w) + 1)
  const rows = Math.min(MAX_ROWS, Math.max(limit.rows, sheet.extent.rows + 100, r1 + 60))
  const cols = Math.min(MAX_COLS, Math.max(limit.cols, sheet.extent.cols + 20, c1 + 12))
  React.useEffect(() => {
    if (rows > limit.rows || cols > limit.cols) setLimit({ rows, cols })
  }, [rows, cols, limit])

  const totalW = columns.offset(cols)
  const totalH = rows * ROW_H

  // --- viewport tracking -------------------------------------------------------
  React.useLayoutEffect(() => {
    const el = scroller.current!
    let raf = 0
    const update = () => {
      raf = 0
      setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth - ROW_HEADER_W, h: el.clientHeight - HEADER_H })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    el.addEventListener("scroll", schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", schedule)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  const cellBox = React.useCallback(
    (row: number, col: number, rowsN = 1, colsN = 1) => ({
      left: columns.offset(col),
      top: row * ROW_H,
      width: columns.offset(col + colsN) - columns.offset(col),
      height: rowsN * ROW_H,
    }),
    [columns],
  )

  const ensureVisible = React.useCallback(
    (row: number, col: number) => {
      const el = scroller.current
      if (!el) return
      const b = cellBox(row, col)
      const vw = el.clientWidth - ROW_HEADER_W
      const vh = el.clientHeight - HEADER_H
      if (b.top < el.scrollTop) el.scrollTop = b.top
      else if (b.top + b.height > el.scrollTop + vh) el.scrollTop = b.top + b.height - vh
      if (b.left < el.scrollLeft) el.scrollLeft = b.left
      else if (b.left + b.width > el.scrollLeft + vw) el.scrollLeft = Math.min(b.left, b.left + b.width - vw)
    },
    [cellBox],
  )

  const pointToCell = React.useCallback(
    (clientX: number, clientY: number) => {
      const el = scroller.current!
      const r = el.getBoundingClientRect()
      const x = clientX - r.left + el.scrollLeft - ROW_HEADER_W
      const y = clientY - r.top + el.scrollTop - HEADER_H
      return {
        row: Math.max(0, Math.min(rows - 1, Math.floor(y / ROW_H))),
        col: Math.max(0, Math.min(cols - 1, columns.indexAt(x))),
      }
    },
    [rows, cols, columns],
  )

  const focus = selection?.focus
  const focusInfo = focus ? cellAt(sheet, focus.row, focus.col) : null

  // --- edits -------------------------------------------------------------------
  const emit = React.useCallback(
    (intents: EditIntent[]) => {
      if (intents.length) onIntent(intents)
    },
    [onIntent],
  )

  const move = React.useCallback(
    (row: number, col: number, extend = false) => {
      const r = Math.max(0, Math.min(MAX_ROWS - 1, row))
      const c = Math.max(0, Math.min(MAX_COLS - 1, col))
      onSelect(extend && selection ? { anchor: selection.anchor, focus: { row: r, col: c } } : one(r, c))
      ensureVisible(r, c)
    },
    [onSelect, selection, ensureVisible],
  )

  const startEdit = React.useCallback(
    (text?: string) => {
      if (!focus) return
      const info = cellAt(sheet, focus.row, focus.col)
      if (!isEditable(info)) {
        if (info.kind === "table" && info.table.source === "query") onError?.(`"${info.table.name}" is a query, so its cells are computed`)
        else if (info.kind === "table" && info.region.kind === "totals") onError?.("Totals are computed")
        return
      }
      const original = editTextFor(info)
      setEditing({ row: focus.row, col: focus.col, original, text: text ?? original, mode: text === undefined ? "edit" : "enter" })
      ensureVisible(focus.row, focus.col)
    },
    [focus, sheet, onError, ensureVisible],
  )

  const commit = React.useCallback(
    (e: Editing, then?: [number, number]) => {
      if (live.current !== e) return
      live.current = null
      setEditing(null)
      if (e.text !== e.original) {
        const res = inputIntents(sheet, cellAt(sheet, e.row, e.col), e.text)
        if (!res.ok) onError?.(res.error)
        else emit(res.intents)
      }
      if (then) move(e.row + then[0], e.col + then[1])
      scroller.current?.focus({ preventScroll: true })
    },
    [sheet, onError, emit, move],
  )

  React.useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus({ preventScroll: true }),
    scrollTo: (row, col) => ensureVisible(row, col),
    edit: (text) => startEdit(text),
  }))

  // keep the editor's caret at the end when typing starts it
  React.useEffect(() => {
    if (editing && input.current && document.activeElement !== input.current) {
      input.current.focus()
      const n = input.current.value.length
      input.current.setSelectionRange(n, n)
    }
  }, [editing])

  // an edit in progress is dropped if the sheet changes under it from elsewhere
  React.useEffect(() => setEditing(null), [sheet.name])

  // --- clipboard -----------------------------------------------------------------
  const copy = (e: React.ClipboardEvent, cut: boolean) => {
    if (editing || !selection) return
    e.preventDefault()
    const rect = selectionRect(selection)
    const cells: ClipCell[][] = []
    for (let r = 0; r < rect.rows; r++) {
      const line: ClipCell[] = []
      for (let c = 0; c < rect.cols; c++) line.push(clipCell(sheet, rect.row + r, rect.col + c))
      cells.push(line)
    }
    const text = cells.map((l) => l.map((c) => c.text.replace(/[\t\n]/g, " ")).join("\t")).join("\n")
    e.clipboardData.setData("text/plain", text)
    internalClip = { text, cells, from: { row: rect.row, col: rect.col } }
    if (cut) emit(clearIntents(sheet, rect))
  }

  const paste = (e: React.ClipboardEvent) => {
    if (editing || !selection) return
    e.preventDefault()
    const text = e.clipboardData.getData("text/plain")
    if (!text) return
    const internal = internalClip && internalClip.text === text ? internalClip : null
    const cells = internal ? internal.cells : parseTsv(text)
    const rect = selectionRect(selection)
    let res: ReturnType<typeof pasteIntents>
    if (cells.length === 1 && cells[0].length === 1 && (rect.rows > 1 || rect.cols > 1)) {
      // one copied cell pasted onto a range fills the range, each copy shifted from the source
      const intents: EditIntent[] = []
      res = { ok: true, intents }
      for (let r = 0; r < rect.rows && res.ok; r++)
        for (let c = 0; c < rect.cols && res.ok; c++) {
          const one = pasteIntents(sheet, rect.row + r, rect.col + c, cells, internal?.from)
          if (one.ok) intents.push(...one.intents)
          else res = one
        }
    } else {
      res = pasteIntents(sheet, rect.row, rect.col, cells, internal?.from)
      onSelect({ anchor: { row: rect.row, col: rect.col }, focus: { row: rect.row + cells.length - 1, col: rect.col + (cells[0]?.length ?? 1) - 1 } })
    }
    if (!res.ok) onError?.(res.error)
    else emit(res.intents)
  }

  // --- keyboard --------------------------------------------------------------------
  const style = (patch: Parameters<typeof styleIntents>[2]) => selection && emit(styleIntents(sheet, selectionRect(selection), patch))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    const mod = e.metaKey || e.ctrlKey
    const block = selectedBlock !== null ? sheet.blocks[selectedBlock] : undefined
    if (block) {
      const nudge: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        onIntent({ type: "deleteBlock", sheet: sheet.name, index: block.index })
        onSelectBlock(null)
      } else if (nudge[e.key]) {
        e.preventDefault()
        const [dr, dc] = nudge[e.key]
        const r = { ...block.rect, row: Math.max(0, block.rect.row + dr), col: Math.max(0, block.rect.col + dc) }
        const hit = blocked(sheet, block, r)
        if (hit) return onError?.(`That spot overlaps ${hit}`)
        onIntent({ type: "moveBlock", sheet: sheet.name, index: block.index, at: isOverlay(block) ? rangeName(r) : address(r.row, r.col) })
      } else if (e.key === "Escape") onSelectBlock(null)
      else if (e.key === "Enter") onAction?.({ type: "reveal", block: block.index })
      return
    }
    if (!selection) {
      if (/^Arrow|Tab|Enter/.test(e.key)) {
        e.preventDefault()
        move(0, 0)
      }
      return
    }
    const { row, col } = selection.focus
    const limits = { rows: Math.max(sheet.extent.rows, row + 1), cols: Math.max(sheet.extent.cols, col + 1) }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (arrows[e.key]) {
      e.preventDefault()
      const [dr, dc] = arrows[e.key]
      if (mod) {
        const j = jump(sheet, row, col, dr, dc, { rows: Math.max(limits.rows, row + 2), cols: Math.max(limits.cols, col + 2) })
        move(j.row, j.col, e.shiftKey)
      } else move(row + dr, col + dc, e.shiftKey)
      return
    }
    const pageRows = Math.max(1, Math.floor(view.h / ROW_H) - 1)
    switch (e.key) {
      case "Tab":
        e.preventDefault()
        move(row, col + (e.shiftKey ? -1 : 1))
        return
      case "Enter":
        e.preventDefault()
        if (e.shiftKey) move(row - 1, col)
        else startEdit()
        return
      case "F2":
        e.preventDefault()
        startEdit()
        return
      case "PageDown":
      case "PageUp":
        e.preventDefault()
        move(row + (e.key === "PageDown" ? pageRows : -pageRows), col, e.shiftKey)
        return
      case "Home":
        e.preventDefault()
        move(mod ? 0 : row, 0, e.shiftKey)
        return
      case "Escape":
        onSelect(one(row, col))
        return
      case "Delete":
      case "Backspace":
        e.preventDefault()
        emit(clearIntents(sheet, selectionRect(selection)))
        return
      case " ": {
        const info = cellAt(sheet, row, col)
        if (info.kind === "table" && info.region.kind === "data" && info.column?.kind === "boolean" && info.table.source === "table") {
          e.preventDefault()
          onIntent({ type: "setCell", table: info.table.name, row: info.region.index, column: info.column.key, value: !(info.value === true) })
          return
        }
        break
      }
    }
    if (mod) {
      const k = e.key.toLowerCase()
      const s = focusInfo?.kind === "free" ? focusInfo.cell.style : undefined
      if (k === "b") {
        e.preventDefault()
        style({ bold: s?.bold ? null : true })
      } else if (k === "i") {
        e.preventDefault()
        style({ italic: s?.italic ? null : true })
      } else if (k === "a") {
        e.preventDefault()
        onSelect({ anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, sheet.extent.rows - 1), col: Math.max(0, sheet.extent.cols - 1) } })
      } else if (k === "d" || k === "r") {
        e.preventDefault()
        const rect = selectionRect(selection)
        const source = k === "d" ? { ...rect, rows: 1 } : { ...rect, cols: 1 }
        if ((k === "d" && rect.rows < 2) || (k === "r" && rect.cols < 2)) return
        const res = fillIntents(sheet, source, rect)
        if (!res.ok) onError?.(res.error)
        else emit(res.intents)
      }
      return
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault()
      startEdit(e.key)
    }
  }

  // --- pointer -----------------------------------------------------------------------
  React.useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.kind === "width") {
        setDrag({ ...d, w: Math.max(MIN_W, d.startW + e.clientX - d.startX) })
        return
      }
      const cell = pointToCell(e.clientX, e.clientY)
      if (d.kind === "select" && selection) {
        if (cell.row !== selection.focus.row || cell.col !== selection.focus.col) onSelect({ anchor: selection.anchor, focus: cell })
      } else if (d.kind === "fill") {
        const s = d.source
        const down = cell.row - (s.row + s.rows - 1)
        const right = cell.col - (s.col + s.cols - 1)
        const target =
          down >= right && down > 0
            ? { ...s, rows: s.rows + down }
            : right > 0
              ? { ...s, cols: s.cols + right }
              : s
        setDrag({ ...d, target })
      } else if (d.kind === "move") {
        const start = pointToCell(d.x, d.y)
        const dr = cell.row - start.row
        const dc = cell.col - start.col
        const moved = d.moved || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4
        setDrag({ ...d, moved, rect: { ...d.origin, row: Math.max(0, d.origin.row + dr), col: Math.max(0, d.origin.col + dc) } })
      } else if (d.kind === "resize") {
        setDrag({
          ...d,
          rect: { ...d.origin, rows: Math.max(1, cell.row - d.origin.row + 1), cols: Math.max(1, cell.col - d.origin.col + 1) },
        })
      }
    }
    const onUp = () => {
      const d = dragRef.current
      setDrag(null)
      if (!d) return
      if (d.kind === "width") {
        if (d.w !== d.startW) onIntent({ type: "setWidth", sheet: sheet.name, column: colName(d.col), width: d.w })
      } else if (d.kind === "fill") {
        if (d.target.rows !== d.source.rows || d.target.cols !== d.source.cols) {
          const res = fillIntents(sheet, d.source, d.target)
          if (!res.ok) onError?.(res.error)
          else emit(res.intents)
          onSelect({ anchor: { row: d.target.row, col: d.target.col }, focus: { row: d.target.row + d.target.rows - 1, col: d.target.col + d.target.cols - 1 } })
        }
      } else if ((d.kind === "move" && d.moved) || d.kind === "resize") {
        const r = d.rect
        const hit = blocked(sheet, d.block, r)
        if (hit) onError?.(`That spot overlaps ${hit}`)
        else if (r.row !== d.origin.row || r.col !== d.origin.col || r.rows !== d.origin.rows || r.cols !== d.origin.cols) {
          const at = isOverlay(d.block) ? rangeName(r) : address(r.row, r.col)
          onIntent({ type: "moveBlock", sheet: sheet.name, index: d.block.index, at })
        }
      }
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [drag !== null, pointToCell, selection, onSelect, onIntent, sheet, emit, onError]) // eslint-disable-line react-hooks/exhaustive-deps

  const onCellsMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const cell = pointToCell(e.clientX, e.clientY)
    if (editing) {
      // pointing at cells while typing a formula inserts references
      const el = input.current
      const caret = el?.selectionStart ?? editing.text.length
      if (editing.text.startsWith("=") && /[=+\-*/(,<>&^:\s]$/.test(editing.text.slice(0, caret))) {
        e.preventDefault()
        const ref = address(cell.row, cell.col)
        const text = editing.text.slice(0, caret) + ref + editing.text.slice(caret)
        setEditing({ ...editing, text, mode: "edit" })
        requestAnimationFrame(() => {
          el?.focus()
          el?.setSelectionRange(caret + ref.length, caret + ref.length)
        })
        return
      }
      commit(editing)
    }
    e.preventDefault()
    scroller.current?.focus({ preventScroll: true })
    if (e.shiftKey && selection) onSelect({ anchor: selection.anchor, focus: cell })
    else onSelect(one(cell.row, cell.col))
    setDrag({ kind: "select" })
  }

  const startBlockDrag = (e: React.MouseEvent, block: BlockModel, kind: "move" | "resize") => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (editing) commit(editing)
    scroller.current?.focus({ preventScroll: true })
    onSelectBlock(block.index)
    setDrag(
      kind === "move"
        ? { kind: "move", block, origin: block.rect, rect: block.rect, x: e.clientX, y: e.clientY, moved: false }
        : { kind: "resize", block, origin: block.rect, rect: block.rect },
    )
  }

  // --- render ----------------------------------------------------------------------
  const visible: Rect = { row: r0, col: c0, rows: r1 - r0 + 1, cols: c1 - c0 + 1 }
  const near = (r: Rect) =>
    r.row < visible.row + visible.rows + 4 && r.row + r.rows > visible.row - 4 && r.col < visible.col + visible.cols + 2 && r.col + r.cols > visible.col - 2

  const cellsOut: React.ReactNode[] = []
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const info = cellAt(sheet, row, col)
      if (info.kind === "empty" || info.kind === "overlay") continue
      if (info.kind === "table" && info.region.kind === "title") continue
      if (editing && editing.row === row && editing.col === col) continue
      const look = cellLook(info, ctx)
      const was = changes?.cells[info.address]?.was
      const inTable = info.kind === "table" || info.kind === "param"
      if (!look && !inTable) continue
      const b = cellBox(row, col)
      cellsOut.push(
        <div
          key={`${row}:${col}`}
          className={cn(
            "absolute truncate px-2 text-[13px] leading-[27px] tabular-nums",
            inTable && "border-r border-b border-border bg-card",
            look?.className,
          )}
          style={{ left: b.left, top: b.top, width: b.width, height: b.height, textAlign: look?.align }}
          title={was !== undefined ? [look?.title, `Was: ${was}`].filter(Boolean).join("\n") : look?.title}
        >
          {look?.check !== undefined ? (
            look.check ? <CheckIcon className="inline size-3.5 text-positive" /> : <span className="inline-block size-3 rounded-sm border align-middle" />
          ) : (
            look?.text
          )}
          {look?.marker === "override" && <span className="absolute top-0 right-0 size-0 border-t-[7px] border-l-[7px] border-t-highlight border-l-transparent" />}
          {look?.marker === "formula" && <span className="absolute top-0 right-0 size-0 border-t-[5px] border-l-[5px] border-t-info/60 border-l-transparent" />}
        </div>,
      )
    }
  }

  const colLines: React.ReactNode[] = []
  for (let col = c0; col <= c1 + 1; col++) {
    colLines.push(<div key={col} className="absolute top-0 bottom-0 w-px bg-border/60" style={{ left: columns.offset(col) - 1 }} />)
  }

  const sel = selection ? selectionRect(selection) : null
  const selBox = sel && cellBox(sel.row, sel.col, sel.rows, sel.cols)
  const focusBox = focus && cellBox(focus.row, focus.col)
  const fillTarget = drag?.kind === "fill" ? cellBox(drag.target.row, drag.target.col, drag.target.rows, drag.target.cols) : null
  const ghost = drag && (drag.kind === "move" ? (drag.moved ? drag.rect : null) : drag.kind === "resize" ? drag.rect : null)
  const ghostBox = ghost && cellBox(ghost.row, ghost.col, ghost.rows, ghost.cols)
  const ghostBad = !!ghost && !!drag && (drag.kind === "move" || drag.kind === "resize") && !!blocked(sheet, drag.block, ghost)

  const selCols = sel ? [sel.col, sel.col + sel.cols - 1] : [-1, -1]
  const selRows = sel ? [sel.row, sel.row + sel.rows - 1] : [-1, -1]

  const paramSlider =
    focusInfo?.kind === "param" && focusInfo.part === "value" && focusInfo.param.min !== undefined && focusInfo.param.max !== undefined && !editing
      ? focusInfo.param
      : null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={scroller}
          tabIndex={0}
          role="grid"
          aria-label={`Sheet ${sheet.name}`}
          aria-rowcount={rows}
          aria-colcount={cols}
          data-slot="sheet-grid"
          className={cn("relative overflow-auto bg-background text-foreground outline-none select-none", className)}
          onKeyDown={onKeyDown}
          onCopy={(e) => copy(e, false)}
          onCut={(e) => copy(e, true)}
          onPaste={paste}
          onContextMenu={(e) => {
            const cell = pointToCell(e.clientX, e.clientY)
            const inside = sel && cell.row >= sel.row && cell.row < sel.row + sel.rows && cell.col >= sel.col && cell.col < sel.col + sel.cols
            if (!inside && (e.target as HTMLElement).closest("[data-cells]")) onSelect(one(cell.row, cell.col))
          }}
        >
          <div style={{ width: totalW + ROW_HEADER_W, height: totalH + HEADER_H }} className="relative">
            {/* column headers */}
            <div className="sticky top-0 z-30 flex" style={{ height: HEADER_H, width: totalW + ROW_HEADER_W }}>
              <button
                type="button"
                aria-label="Select all"
                className="sticky left-0 z-10 shrink-0 border-r border-b bg-muted hover:bg-accent"
                style={{ width: ROW_HEADER_W, height: HEADER_H }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelect({ anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, sheet.extent.rows - 1), col: Math.max(0, sheet.extent.cols - 1) } })
                }}
              />
              <div className="relative flex-1 border-b bg-muted">
                {Array.from({ length: c1 - c0 + 1 }, (_, i) => {
                  const col = c0 + i
                  const b = cellBox(0, col)
                  const on = col >= selCols[0] && col <= selCols[1]
                  return (
                    <div
                      key={col}
                      className={cn(
                        "absolute top-0 flex h-full items-center justify-center border-r text-[11px] font-medium text-muted-foreground",
                        on && "bg-highlight/20 text-foreground",
                      )}
                      style={{ left: b.left, width: b.width }}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        scroller.current?.focus({ preventScroll: true })
                        const last = Math.max(0, sheet.extent.rows - 1, view.top / ROW_H + view.h / ROW_H)
                        if (e.shiftKey && selection) onSelect({ anchor: { row: 0, col: selection.anchor.col }, focus: { row: Math.floor(last), col } })
                        else onSelect({ anchor: { row: 0, col }, focus: { row: Math.floor(last), col } })
                      }}
                    >
                      {colName(col)}
                      <span
                        role="separator"
                        aria-label={`Resize column ${colName(col)}`}
                        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-highlight/60"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          setDrag({ kind: "width", col, startX: e.clientX, startW: b.width, w: b.width })
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          onIntent({ type: "setWidth", sheet: sheet.name, column: colName(col), width: null })
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="flex" style={{ height: totalH }}>
              {/* row headers */}
              <div className="sticky left-0 z-20 shrink-0 border-r bg-muted" style={{ width: ROW_HEADER_W, height: totalH }}>
                {Array.from({ length: r1 - r0 + 1 }, (_, i) => {
                  const row = r0 + i
                  const on = row >= selRows[0] && row <= selRows[1]
                  return (
                    <div
                      key={row}
                      className={cn(
                        "absolute right-0 left-0 flex items-center justify-end border-b pr-2 text-[11px] text-muted-foreground tabular-nums",
                        on && "bg-highlight/20 text-foreground",
                      )}
                      style={{ top: row * ROW_H, height: ROW_H }}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        scroller.current?.focus({ preventScroll: true })
                        const last = Math.max(0, sheet.extent.cols - 1)
                        onSelect({ anchor: { row, col: 0 }, focus: { row, col: last } })
                      }}
                    >
                      {row + 1}
                    </div>
                  )
                })}
              </div>

              {/* cells */}
              <div
                data-cells
                className="relative flex-1"
                style={{
                  backgroundImage: "linear-gradient(to bottom, transparent calc(100% - 1px), color-mix(in oklab, var(--border) 60%, transparent) 1px)",
                  backgroundSize: `100% ${ROW_H}px`,
                }}
                onMouseDown={onCellsMouseDown}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest("[data-block]")) return
                  startEdit()
                }}
              >
                {colLines}
                {cellsOut}

                {/* table chrome: outline and title strip */}
                {sheet.blocks.map((b) => {
                  if ((b.type !== "table" && b.type !== "param") || !near(b.rect)) return null
                  const box = cellBox(b.rect.row, b.rect.col, b.rect.rows, b.rect.cols)
                  const chosen = selectedBlock === b.index
                  return (
                    <React.Fragment key={b.id}>
                      <div
                        className={cn("pointer-events-none absolute z-[1] rounded-[3px] ring-1 ring-foreground/15", chosen && "ring-2 ring-highlight")}
                        style={box}
                      />
                      {b.type === "table" ? (
                        <TableTitle
                          table={b}
                          sheet={sheet.name}
                          style={cellBox(b.rect.row, b.rect.col, 1, b.rect.cols)}
                          onGrip={(e) => startBlockDrag(e, b, "move")}
                          onIntent={onIntent}
                          onAction={onAction}
                          onSelect={() => onSelect(one(b.rect.row, b.rect.col))}
                          onEdit={() => {
                            onSelect(one(b.rect.row, b.rect.col))
                            requestAnimationFrame(() => setEditing({ row: b.rect.row, col: b.rect.col, text: b.title, original: b.title, mode: "edit" }))
                          }}
                        />
                      ) : (
                        <ParamGrip param={b} style={cellBox(b.rect.row, b.rect.col)} onGrip={(e) => startBlockDrag(e, b, "move")} />
                      )}
                    </React.Fragment>
                  )
                })}

                {/* changes under review */}
                {changed.map((c) => {
                  if (c.row < r0 || c.row > r1 || c.col < c0 || c.col > c1) return null
                  const b = cellBox(c.row, c.col)
                  return (
                    <div
                      key={`chg:${c.row}:${c.col}`}
                      className={cn(
                        "pointer-events-none absolute z-[4] truncate px-2 text-[13px] leading-[27px]",
                        c.kind === "edited" && "bg-highlight/25 ring-1 ring-highlight/80 ring-inset",
                        c.kind === "added" && "bg-positive/15 ring-1 ring-positive/50 ring-inset",
                        c.kind === "computed" && "border border-dashed border-info/50 bg-info/5",
                        c.kind === "removed" && "bg-destructive/5 text-destructive/70 line-through",
                      )}
                      style={b}
                    >
                      {c.kind === "removed" ? c.was : null}
                    </div>
                  )
                })}
                {changes?.blocks.map((c, i) => {
                  if ((c.kind !== "moved" && c.kind !== "removed") || !c.from || !near(c.from)) return null
                  const box = cellBox(c.from.row, c.from.col, c.from.rows, c.from.cols)
                  return (
                    <div
                      key={`was:${i}`}
                      className={cn(
                        "pointer-events-none absolute z-[3] flex items-start rounded-md border border-dashed p-1.5 text-xs",
                        c.kind === "removed" ? "border-destructive/50 bg-destructive/5 text-destructive/80" : "border-foreground/25 text-muted-foreground",
                      )}
                      style={box}
                    >
                      {c.kind === "removed" ? `Removed ${c.label}` : `${c.label} was here`}
                    </div>
                  )
                })}

                {/* selection */}
                {selBox && sel && (sel.rows > 1 || sel.cols > 1) && (
                  <div className="pointer-events-none absolute z-[5] bg-highlight/10 ring-1 ring-highlight-edge" style={selBox} />
                )}
                {focusBox && selectedBlock === null && (
                  <div className="pointer-events-none absolute z-[6] ring-2 ring-highlight" style={focusBox} />
                )}
                {selBox && selectedBlock === null && !editing && (
                  <div
                    aria-label="Fill handle"
                    className="absolute z-[7] size-2 cursor-crosshair border border-card bg-highlight"
                    style={{ left: selBox.left + selBox.width - 5, top: selBox.top + selBox.height - 5 }}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      setDrag({ kind: "fill", source: sel!, target: sel! })
                    }}
                  />
                )}
                {fillTarget && <div className="pointer-events-none absolute z-[6] border-2 border-dashed border-highlight" style={fillTarget} />}

                {/* charts, metrics and text float over cells */}
                {sheet.blocks.map((b) => {
                  if (!isOverlay(b) || !near(b.rect)) return null
                  const box = cellBox(b.rect.row, b.rect.col, b.rect.rows, b.rect.cols)
                  const chosen = selectedBlock === b.index
                  const card = b.type !== "text"
                  const change = blockChanges.get(b.index)
                  return (
                    <div
                      key={b.id}
                      data-block={b.index}
                      className={cn(
                        "group/block absolute z-[8] overflow-hidden rounded-md",
                        card ? "bg-card shadow-xs ring-1 ring-foreground/10" : "bg-background/90 hover:ring-1 hover:ring-foreground/10",
                        change === "computed" && "outline-2 outline-offset-1 outline-info/50 outline-dashed",
                        (change === "edited" || change === "added") && "outline-2 outline-offset-1 outline-highlight",
                        chosen && "ring-2 ring-highlight",
                      )}
                      title={change ? (change === "computed" ? "Recalculated by the changes under review" : "Changed by the changes under review") : undefined}
                      style={{ left: box.left + 2, top: box.top + 2, width: box.width - 4, height: box.height - 4 }}
                      onMouseDown={(e) => {
                        if ((e.target as HTMLElement).closest("[data-drag-handle]") || b.type !== "chart") startBlockDrag(e, b, "move")
                        else {
                          e.stopPropagation()
                          if (editing) commit(editing)
                          scroller.current?.focus({ preventScroll: true })
                          onSelectBlock(b.index)
                        }
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        onAction?.({ type: "reveal", block: b.index })
                      }}
                      onContextMenu={() => onSelectBlock(b.index)}
                    >
                      <OverlayContent block={b} ctx={ctx} />
                      <div
                        aria-label="Resize"
                        className={cn(
                          "absolute right-0 bottom-0 size-3 cursor-nwse-resize rounded-tl-sm bg-highlight opacity-0 group-hover/block:opacity-70",
                          chosen && "opacity-100",
                        )}
                        onMouseDown={(e) => startBlockDrag(e, b, "resize")}
                      />
                    </div>
                  )
                })}

                {ghostBox && (
                  <div
                    className={cn(
                      "pointer-events-none absolute z-[9] rounded-md border-2 border-dashed",
                      ghostBad ? "border-destructive bg-destructive/10" : "border-highlight bg-highlight/10",
                    )}
                    style={ghostBox}
                  />
                )}

                {/* editor */}
                {editing && (
                  <CellEditor
                    ref={input}
                    editing={editing}
                    info={cellAt(sheet, editing.row, editing.col)}
                    box={cellBox(editing.row, editing.col)}
                    onChange={(text) => setEditing((e) => e && { ...e, text })}
                    onCommit={(then) => commit(editing, then)}
                    onCancel={() => {
                      setEditing(null)
                      scroller.current?.focus({ preventScroll: true })
                    }}
                  />
                )}

                {paramSlider && focusBox && (
                  <ParamSlider param={paramSlider} box={focusBox} onCommit={(v) => onIntent({ type: "setParam", name: paramSlider.name, value: v })} />
                )}
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <GridMenu
        sheet={sheet}
        info={focusInfo}
        selection={selection}
        block={selectedBlock !== null ? sheet.blocks[selectedBlock] : undefined}
        emit={emit}
        onIntent={onIntent}
        onAction={onAction}
        onEdit={() => startEdit()}
        onSelectBlock={onSelectBlock}
      />
    </ContextMenu>
  )
}

/** What a block moved to `rect` would overlap: another block or a free cell with content. */
function blocked(sheet: SheetModel, block: BlockModel, rect: Rect): string | null {
  for (const b of sheet.blocks) {
    if (b === block) continue
    if (intersects(b.rect, rect)) return blockLabel(b)
  }
  for (const [a, c] of Object.entries(sheet.cells)) {
    if (c.value === null && !c.formula) continue
    const p = parseAddress(a)!
    if (contains(rect, p.row, p.col)) return `cell ${a}`
  }
  return null
}

// --- pieces ----------------------------------------------------------------------------

function CellEditor({
  ref,
  editing,
  info,
  box,
  onChange,
  onCommit,
  onCancel,
}: {
  ref: React.Ref<HTMLInputElement>
  editing: Editing
  info: CellInfo
  box: { left: number; top: number; width: number; height: number }
  onChange: (text: string) => void
  onCommit: (then?: [number, number]) => void
  onCancel: () => void
}) {
  const options = info.kind === "table" ? info.column?.options : info.kind === "param" ? info.param.options : undefined
  const listId = options ? `opts-${info.address}` : undefined
  const width = Math.max(box.width, Math.min(480, editing.text.length * 7.6 + 24))
  return (
    <>
      <input
        ref={ref}
        aria-label={`Edit ${cellLabel(info)}`}
        list={listId}
        value={editing.text}
        spellCheck={false}
        className={cn(
          "absolute z-[20] bg-card px-2 text-[13px] shadow-md ring-2 ring-highlight outline-none",
          editing.text.startsWith("=") && "font-mono text-[12px]",
        )}
        style={{ left: box.left, top: box.top, width, height: box.height }}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            onCommit(e.shiftKey ? [-1, 0] : [1, 0])
          } else if (e.key === "Tab") {
            e.preventDefault()
            onCommit(e.shiftKey ? [0, -1] : [0, 1])
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          } else if (editing.mode === "enter" && !editing.text.startsWith("=")) {
            const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
            if (arrows[e.key]) {
              e.preventDefault()
              onCommit(arrows[e.key])
            }
          }
        }}
      />
      {options && (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </>
  )
}

function TableTitle({
  table,
  sheet,
  style,
  onGrip,
  onIntent,
  onAction,
  onSelect,
  onEdit,
}: {
  table: TableModel
  sheet: string
  style: React.CSSProperties
  onGrip: (e: React.MouseEvent) => void
  onIntent: IntentHandler
  onAction?: (a: GridAction) => void
  onSelect: () => void
  onEdit: () => void
}) {
  const query = table.source === "query"
  const Icon = query ? DatabaseIcon : table.dataFile ? FileSpreadsheetIcon : TableIcon
  return (
    <div
      data-block={table.index}
      className="group/title absolute z-[2] flex items-center gap-1.5 rounded-t-[3px] border-b bg-card pr-1 text-[13px]"
      style={style}
      onMouseDown={(e) => {
        e.stopPropagation()
        if (e.button === 0) onSelect()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!query) onEdit()
      }}
    >
      <span
        aria-label={`Move ${table.name}`}
        className="flex h-full w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 hover:text-foreground active:cursor-grabbing"
        onMouseDown={onGrip}
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-heading font-medium">{table.title}</span>
      {table.title !== table.name && <code className="truncate text-[11px] text-muted-foreground">{table.name}</code>}
      {query && (
        <Badge variant="info" className="h-4 px-1.5 text-[10px]">
          query
        </Badge>
      )}
      {table.dataFile && (
        <Badge variant="outline" className="h-4 px-1.5 font-mono text-[10px]">
          {table.dataFile}
        </Badge>
      )}
      {table.error && (
        <span className="truncate text-xs text-destructive" title={table.error}>
          {table.error}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{table.rows.length} rows</span>
      {!query && (
        <span onMouseDown={(e) => e.stopPropagation()} className="opacity-0 group-hover/title:opacity-100 has-[[data-state=open]]:opacity-100">
          <AddColumn onAdd={(key, kind, label) => onIntent({ type: "addColumn", table: table.name, column: key, kind, label })} />
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={`${table.name} menu`} onMouseDown={(e) => e.stopPropagation()}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => onAction?.({ type: "reveal", block: table.index })}>
            <CodeIcon /> Show in code
          </DropdownMenuItem>
          {(["bar", "line", "pie"] as const).map((k) => (
            <DropdownMenuItem key={k} onSelect={() => onAction?.({ type: "chartFromTable", table: table.name, kind: k })}>
              <ChartBarIcon /> Add {k} chart
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onIntent({ type: "deleteBlock", sheet, index: table.index })}>
            <Trash2Icon /> Delete {query ? "query" : "table"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ParamGrip({ param, style, onGrip }: { param: ParamModel; style: React.CSSProperties; onGrip: (e: React.MouseEvent) => void }) {
  return (
    <span
      aria-label={`Move param ${param.name}`}
      className="absolute z-[3] flex w-3 cursor-grab items-center justify-center text-muted-foreground/0 hover:text-muted-foreground active:cursor-grabbing"
      style={{ left: (style.left as number) - 12, top: style.top, height: style.height }}
      onMouseDown={onGrip}
    >
      <GripVerticalIcon className="size-3" />
    </span>
  )
}

function ParamSlider({
  param,
  box,
  onCommit,
}: {
  param: ParamModel
  box: { left: number; top: number; width: number; height: number }
  onCommit: (v: number) => void
}) {
  const [v, setV] = React.useState(param.value as number)
  React.useEffect(() => setV(param.value as number), [param.value])
  return (
    <div
      className="absolute z-[21] rounded-md bg-popover p-2 shadow-md ring-1 ring-foreground/10"
      style={{ left: box.left, top: box.top + box.height + 2, width: Math.max(160, box.width) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Slider
        aria-label={param.label}
        min={param.min}
        max={param.max}
        step={param.step ?? (param.max! - param.min!) / 100}
        value={[v]}
        onValueChange={([x]) => setV(x)}
        onValueCommit={([x]) => onCommit(+x.toPrecision(10))}
      />
    </div>
  )
}

function GridMenu({
  sheet,
  info,
  selection,
  block,
  emit,
  onIntent,
  onAction,
  onEdit,
  onSelectBlock,
}: {
  sheet: SheetModel
  info: CellInfo | null
  selection: GridSelection | null
  block?: BlockModel
  emit: (i: EditIntent[]) => void
  onIntent: IntentHandler
  onAction?: (a: GridAction) => void
  onEdit: () => void
  onSelectBlock: (i: number | null) => void
}) {
  if (block && isOverlay(block)) {
    return (
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onAction?.({ type: "reveal", block: block.index })}>
          <CodeIcon /> Show in code
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => {
            onIntent({ type: "deleteBlock", sheet: sheet.name, index: block.index })
            onSelectBlock(null)
          }}
        >
          <Trash2Icon /> Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    )
  }
  const rect = selection ? selectionRect(selection) : null
  const table = info?.kind === "table" ? info.table : null
  const editableTable = table && table.source === "table"
  const dataRows =
    rect && table
      ? Array.from({ length: rect.rows }, (_, i) => rect.row + i - table.rect.row - 2).filter((i) => i >= 0 && i < table.rows.length)
      : []
  return (
    <ContextMenuContent className="w-56">
      {info && <ContextMenuLabel className="font-mono text-xs">{cellLabel(info)}</ContextMenuLabel>}
      {info && isEditable(info) && (
        <ContextMenuItem onSelect={onEdit}>
          Edit cell <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => document.execCommand("copy")}>
        Copy <ContextMenuShortcut>⌘C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => rect && emit(clearIntents(sheet, rect))}>
        Clear <ContextMenuShortcut>⌫</ContextMenuShortcut>
      </ContextMenuItem>
      {rect && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Format</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {FORMATS.map((f) => (
              <ContextMenuItem key={f.label} onSelect={() => emit(styleIntents(sheet, rect, { format: f.format }))}>
                {f.label}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => emit(styleIntents(sheet, rect, { bold: true }))}>
              Bold <ContextMenuShortcut>⌘B</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => emit(styleIntents(sheet, rect, { bold: null, italic: null, align: null, tone: null, format: null }))}>
              Clear formatting
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {table && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onAction?.({ type: "reveal", block: table.index })}>
            <CodeIcon /> Show {table.name} in code
          </ContextMenuItem>
          {editableTable && dataRows.length > 0 && (
            <>
              <ContextMenuItem onSelect={() => onIntent({ type: "addRow", table: table.name, at: dataRows[0] })}>
                <ArrowUpIcon /> Insert row above
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onIntent({ type: "addRow", table: table.name, at: dataRows[dataRows.length - 1] + 1 })}>
                <ArrowDownIcon /> Insert row below
              </ContextMenuItem>
            </>
          )}
          {editableTable && dataRows.length === 0 && (
            <ContextMenuItem onSelect={() => onIntent({ type: "addRow", table: table.name })}>
              <PlusIcon /> Add row
            </ContextMenuItem>
          )}
          {editableTable && dataRows.length > 0 && (
            <ContextMenuItem
              variant="destructive"
              onSelect={() =>
                // delete from the bottom so indexes stay valid
                onIntent([...dataRows].sort((a, b) => b - a).map((row) => ({ type: "deleteRow" as const, table: table.name, row })))
              }
            >
              <Trash2Icon /> Delete {dataRows.length === 1 ? "row" : `${dataRows.length} rows`}
            </ContextMenuItem>
          )}
          {editableTable && info?.kind === "table" && info.column && (
            <ContextMenuItem variant="destructive" onSelect={() => onIntent({ type: "deleteColumn", table: table.name, column: info.column!.key })}>
              <Trash2Icon /> Delete column “{info.column.label}”
            </ContextMenuItem>
          )}
        </>
      )}
    </ContextMenuContent>
  )
}
