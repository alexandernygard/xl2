import * as React from "react"
import {
  coerceInput,
  editText,
  formatCell,
  isCellError,
  type CellValue,
  type ColumnKind,
  type ColumnModel,
  type EditIntent,
  type Literal,
  type TableModel,
} from "@xl2/sdk"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@alexandernygard/components"
import {
  CalendarIcon,
  ChevronDownIcon,
  HashIcon,
  ListIcon,
  PercentIcon,
  PlusIcon,
  SigmaIcon,
  ToggleLeftIcon,
  Trash2Icon,
  TypeIcon,
  WalletIcon,
} from "lucide-react"
import type { GridSelection, IntentHandler, ViewContext } from "./types"

const KIND_ICON: Record<ColumnKind, React.ComponentType<{ className?: string }>> = {
  text: TypeIcon,
  number: HashIcon,
  currency: WalletIcon,
  percent: PercentIcon,
  date: CalendarIcon,
  boolean: ToggleLeftIcon,
  select: ListIcon,
  formula: SigmaIcon,
}

const NEW_KINDS: ColumnKind[] = ["text", "number", "currency", "percent", "date", "boolean"]

const isNumeric = (c: ColumnModel) =>
  ["number", "integer", "currency", "percent"].includes(c.format) && c.kind !== "text"

export interface DataGridProps {
  table: TableModel
  ctx: ViewContext
  selection: GridSelection | null
  onSelect: (sel: GridSelection | null) => void
  onIntent: IntentHandler
  onError?: (message: string) => void
  className?: string
}

interface Editing {
  row: number
  col: number
  draft: string
}

export function DataGrid({ table, ctx, selection, onSelect, onIntent, onError, className }: DataGridProps) {
  const editable = table.source === "table"
  const ref = React.useRef<HTMLDivElement>(null)
  const [editing, setEditing] = React.useState<Editing | null>(null)
  const sel = selection && selection.table === table.name ? selection : null
  const selCol = sel ? table.columns.findIndex((c) => c.key === sel.column) : -1
  const rowCount = table.rows.length

  // keep focus on the grid while a cell here is selected, so keys work
  React.useEffect(() => {
    if (sel && !editing && ref.current && !ref.current.contains(document.activeElement)) ref.current.focus()
  }, [sel?.row, sel?.column, editing])

  const select = (row: number, col: number) => {
    const r = Math.max(0, Math.min(rowCount - 1, row))
    const c = Math.max(0, Math.min(table.columns.length - 1, col))
    if (rowCount === 0) return
    onSelect({ table: table.name, row: r, column: table.columns[c].key })
  }

  const canEdit = (col: number) => editable && !table.columns[col]?.computed

  const startEdit = (row: number, col: number, draft?: string) => {
    if (!canEdit(col)) {
      if (table.columns[col]?.computed) onError?.("This value is computed by code. Edit the formula in the code view.")
      return
    }
    const column = table.columns[col]
    if (column.kind === "boolean" && draft === undefined) {
      const cur = table.rows[row]?.[col]
      onIntent({ type: "setCell", table: table.name, row, column: column.key, value: !(cur === true) })
      return
    }
    setEditing({ row, col, draft: draft ?? editText(table.rows[row]?.[col] ?? null, column.kind) })
  }

  const commit = (e: Editing, move?: [number, number]) => {
    const column = table.columns[e.col]
    const parsed = coerceInput(e.draft, column.kind, column.options)
    setEditing(null)
    if (!parsed.ok) {
      onError?.(parsed.error)
    } else if (parsed.value !== (table.rows[e.row]?.[e.col] ?? null)) {
      onIntent({ type: "setCell", table: table.name, row: e.row, column: column.key, value: parsed.value })
    }
    if (move) select(e.row + move[0], e.col + move[1])
    requestAnimationFrame(() => ref.current?.focus())
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !sel || selCol < 0) return
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (moves[e.key]) {
      e.preventDefault()
      const [dr, dc] = moves[e.key]
      if (e.metaKey || e.ctrlKey) select(dr ? (dr < 0 ? 0 : rowCount - 1) : sel.row, dc ? (dc < 0 ? 0 : table.columns.length - 1) : selCol)
      else select(sel.row + dr, selCol + dc)
    } else if (e.key === "Tab") {
      e.preventDefault()
      select(sel.row, selCol + (e.shiftKey ? -1 : 1))
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault()
      startEdit(sel.row, selCol)
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      if (canEdit(selCol)) onIntent({ type: "setCell", table: table.name, row: sel.row, column: sel.column, value: null })
    } else if (e.key === "Escape") {
      onSelect(null)
    } else if (e.key === " " && table.columns[selCol].kind === "boolean") {
      e.preventDefault()
      startEdit(sel.row, selCol)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      startEdit(sel.row, selCol, e.key)
    }
  }

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing || !sel || selCol < 0) return
    e.preventDefault()
    const v = table.rows[sel.row]?.[selCol] ?? null
    e.clipboardData.setData("text/plain", editText(v, table.columns[selCol].kind))
  }

  // Paste a TSV block (from Excel, Sheets, or anywhere) starting at the selection.
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || !sel || selCol < 0 || !editable) return
    e.preventDefault()
    const text = e.clipboardData.getData("text/plain").replace(/\r?\n$/, "")
    const grid = text.split(/\r?\n/).map((l) => l.split("\t"))
    const intents: EditIntent[] = []
    const errors: string[] = []
    grid.forEach((cells, dr) => {
      const row = sel.row + dr
      const values: Record<string, Literal> = {}
      cells.forEach((raw, dc) => {
        const column = table.columns[selCol + dc]
        if (!column || column.computed) return
        const parsed = coerceInput(raw, column.kind, column.options)
        if (!parsed.ok) errors.push(parsed.error)
        else values[column.key] = parsed.value
      })
      if (row < rowCount) {
        for (const [column, value] of Object.entries(values)) intents.push({ type: "setCell", table: table.name, row, column, value })
      } else intents.push({ type: "addRow", table: table.name, values })
    })
    if (errors.length) onError?.(errors[0])
    if (intents.length) onIntent(intents)
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border bg-card", className)} data-slot="data-grid">
      <div
        ref={ref}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
      >
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-r px-2 py-1.5 text-right text-xs font-normal text-muted-foreground">#</th>
              {table.columns.map((c, i) => (
                <ColumnHeader
                  key={c.key}
                  column={c}
                  active={i === selCol}
                  editable={editable}
                  onDelete={() => onIntent({ type: "deleteColumn", table: table.name, column: c.key })}
                />
              ))}
              {editable && (
                <th className="w-8 border-b px-1">
                  <AddColumn onAdd={(column, kind, label) => onIntent({ type: "addColumn", table: table.name, column, kind, label })} />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="group/row">
                <td
                  className={cn(
                    "relative border-b border-r px-2 py-1 text-right text-xs text-muted-foreground",
                    sel?.row === r && "bg-highlight/15 text-foreground",
                  )}
                >
                  <span className={cn(editable && "group-hover/row:invisible")}>{r + 1}</span>
                  {editable && (
                    <button
                      type="button"
                      aria-label={`Delete row ${r + 1}`}
                      className="absolute inset-0 hidden items-center justify-center text-muted-foreground hover:text-destructive group-hover/row:flex"
                      onClick={() => onIntent({ type: "deleteRow", table: table.name, row: r })}
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  )}
                </td>
                {table.columns.map((c, ci) => {
                  const selected = sel?.row === r && selCol === ci
                  const isEditing = editing?.row === r && editing.col === ci
                  return (
                    <td
                      key={c.key}
                      data-cell={`${r}:${c.key}`}
                      onMouseDown={(e) => {
                        if (isEditing) return
                        e.preventDefault()
                        ref.current?.focus()
                        onSelect({ table: table.name, row: r, column: c.key })
                      }}
                      onDoubleClick={() => startEdit(r, ci)}
                      className={cn(
                        "relative h-8 max-w-72 border-b border-r px-2 py-1 whitespace-nowrap",
                        c.computed && "bg-muted/40",
                        isNumeric(c) && "text-right",
                        selected && "outline-2 -outline-offset-2 outline-highlight",
                      )}
                    >
                      {isEditing ? (
                        <CellEditor
                          column={c}
                          editing={editing}
                          onChange={(draft) => setEditing({ ...editing, draft })}
                          onCommit={(move) => commit(editing, move)}
                          onCancel={() => {
                            setEditing(null)
                            ref.current?.focus()
                          }}
                        />
                      ) : (
                        <CellView value={row[ci]} column={c} ctx={ctx} />
                      )}
                    </td>
                  )
                })}
                {editable && <td className="border-b" />}
              </tr>
            ))}
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length + 2} className="px-3 py-6 text-center text-muted-foreground">
                  {table.error ? <span className="text-destructive">{table.error}</span> : "No rows yet"}
                </td>
              </tr>
            )}
          </tbody>
          {table.totals && table.rows.length > 0 && (
            <tfoot className="sticky bottom-0 bg-muted/80 font-medium backdrop-blur">
              <tr>
                <td className="border-r border-t px-2 py-1 text-right text-xs text-muted-foreground">Σ</td>
                {table.columns.map((c, i) => (
                  <td key={c.key} className={cn("border-r border-t px-2 py-1 whitespace-nowrap", isNumeric(c) && "text-right")}>
                    {table.totals![i] !== null && <CellView value={table.totals![i]} column={c} ctx={ctx} />}
                  </td>
                ))}
                {editable && <td className="border-t" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {editable && (
        <button
          type="button"
          onClick={() => {
            onIntent({ type: "addRow", table: table.name })
            onSelect({ table: table.name, row: rowCount, column: table.columns.find((c) => !c.computed)?.key ?? table.columns[0].key })
          }}
          className="flex w-full shrink-0 items-center gap-1.5 border-t px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <PlusIcon className="size-3.5" /> Add row
        </button>
      )}
    </div>
  )
}

function CellView({ value, column, ctx }: { value: CellValue; column: ColumnModel; ctx: ViewContext }) {
  if (isCellError(value)) {
    return (
      <span className="font-medium text-destructive" title={value.error}>
        {value.error.startsWith("#") ? value.error : "#ERR"}
      </span>
    )
  }
  if (column.kind === "boolean" || column.format === "boolean") {
    return (
      <span
        aria-label={value ? "true" : "false"}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded border align-middle text-[10px]",
          value ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {value ? "✓" : ""}
      </span>
    )
  }
  if (column.kind === "select" && value !== null) {
    return <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">{String(value)}</span>
  }
  return <>{formatCell(value, column, ctx)}</>
}

function CellEditor({
  column,
  editing,
  onChange,
  onCommit,
  onCancel,
}: {
  column: ColumnModel
  editing: Editing
  onChange: (draft: string) => void
  onCommit: (move?: [number, number]) => void
  onCancel: () => void
}) {
  const done = React.useRef(false)
  const finish = (move?: [number, number]) => {
    if (done.current) return
    done.current = true
    onCommit(move)
  }
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Enter") {
      e.preventDefault()
      finish([e.shiftKey ? -1 : 1, 0])
    } else if (e.key === "Tab") {
      e.preventDefault()
      finish([0, e.shiftKey ? -1 : 1])
    } else if (e.key === "Escape") {
      done.current = true
      onCancel()
    }
  }
  const cls = "absolute inset-0 w-full bg-background px-2 text-sm outline-2 -outline-offset-2 outline-highlight"
  if (column.kind === "select" && column.options) {
    return (
      <select
        autoFocus
        className={cls}
        value={editing.draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keys}
        onBlur={() => finish()}
      >
        <option value="" />
        {column.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    )
  }
  return (
    <input
      autoFocus
      className={cn(cls, isNumeric(column) && "text-right")}
      value={editing.draft}
      type={column.kind === "date" ? "date" : "text"}
      onFocus={(e) => {
        // typing replaces; Enter/F2 keeps and puts the caret at the end
        const el = e.currentTarget
        if (el.type === "text") el.setSelectionRange(el.value.length, el.value.length)
      }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={keys}
      onBlur={() => finish()}
    />
  )
}

function ColumnHeader({
  column,
  active,
  editable,
  onDelete,
}: {
  column: ColumnModel
  active: boolean
  editable: boolean
  onDelete: () => void
}) {
  const Icon = KIND_ICON[column.kind]
  return (
    <th
      className={cn(
        "border-b border-r px-2 py-1.5 text-left font-medium whitespace-nowrap",
        isNumeric(column) && "text-right",
        active && "bg-highlight/15",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn("inline-flex items-center gap-1.5 rounded outline-none", isNumeric(column) && "flex-row-reverse")}
        >
          <Icon className={cn("size-3.5 shrink-0", column.computed ? "text-info" : "text-muted-foreground")} />
          <span>{column.label}</span>
          <ChevronDownIcon className="size-3 text-muted-foreground opacity-0 [th:hover_&]:opacity-100" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="font-mono text-xs">{column.key}</DropdownMenuLabel>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {column.computed ? "Computed by code" : `${column.kind} column`}
          </DropdownMenuLabel>
          {editable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2Icon /> Delete column
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </th>
  )
}

function AddColumn({ onAdd }: { onAdd: (key: string, kind: ColumnKind, label: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("")
  const [kind, setKind] = React.useState<ColumnKind>("text")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const words = label.trim().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean)
    if (!words.length) return
    const key = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("")
    onAdd(/^\d/.test(key) ? `c${key}` : key, kind, label.trim())
    setLabel("")
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label="Add column">
          <PlusIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <form onSubmit={submit} className="grid gap-3">
          <Input autoFocus placeholder="Column name" value={label} onChange={(e) => setLabel(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {NEW_KINDS.map((k) => {
              const Icon = KIND_ICON[k]
              return (
                <Button key={k} type="button" size="xs" variant={k === kind ? "default" : "outline"} onClick={() => setKind(k)}>
                  <Icon /> {k}
                </Button>
              )
            })}
          </div>
          <Button type="submit" size="sm" disabled={!label.trim()}>
            Add column
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
