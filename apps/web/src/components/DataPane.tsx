import * as React from "react"
import { coerceInput, editText, formulaSource, type BlockModel, type TableModel } from "@xl2/sdk"
import { SheetTabs, SheetView } from "@xl2/viz"
import { Button, toast } from "@alexandernygard/components"
import { CircleAlertIcon, SigmaIcon } from "lucide-react"
import { useStore } from "../store"

function useSelectedCell() {
  const model = useStore((s) => s.model)
  const selection = useStore((s) => s.selection)
  if (!model || !selection) return null
  const table = model.sheets.flatMap((s) => s.blocks).find((b): b is TableModel => b.type === "table" && b.name === selection.table)
  if (!table) return null
  const ci = table.columns.findIndex((c) => c.key === selection.column)
  if (ci < 0 || !table.rows[selection.row]) return null
  return { ...selection, table, column: table.columns[ci], value: table.rows[selection.row][ci] }
}

/** Shows what's behind the selected cell: its literal, or the formula code that computes it. */
function FormulaBar() {
  const cell = useSelectedCell()
  const source = useStore((s) => s.files[s.activeId]?.source ?? "")
  const applyIntent = useStore((s) => s.applyIntent)
  const [draft, setDraft] = React.useState("")
  const display = cell ? editText(cell.value, cell.column.kind) : ""
  React.useEffect(() => setDraft(display), [display, cell?.row, cell?.column.key, cell?.table.name])

  const formula = cell?.column.computed ? (cell.table.source === "query" ? `query("${cell.table.name}")` : formulaSource(source, cell.table.name, cell.column.key)) : null
  const commit = () => {
    if (!cell || formula || draft === display) return
    const parsed = coerceInput(draft, cell.column.kind, cell.column.options)
    if (!parsed.ok) return toast.error(parsed.error)
    const err = applyIntent({ type: "setCell", table: cell.table.name, row: cell.row, column: cell.column.key, value: parsed.value })
    if (err) toast.error(err)
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card px-3 text-sm">
      <code className="w-44 shrink-0 truncate text-xs text-muted-foreground">
        {cell ? `${cell.table.name}[${cell.row}].${cell.column.key}` : "No cell selected"}
      </code>
      <SigmaIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {formula ? (
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-info" title={formula}>
          {formula}
        </code>
      ) : (
        <input
          aria-label="Cell value"
          className="h-7 min-w-0 flex-1 bg-transparent outline-none disabled:opacity-50"
          disabled={!cell || cell.table.source !== "table"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") setDraft(display)
          }}
        />
      )}
    </div>
  )
}

export function DataPane() {
  const model = useStore((s) => s.model)
  const error = useStore((s) => s.error)
  const activeSheet = useStore((s) => s.activeSheet)
  const selection = useStore((s) => s.selection)
  const view = useStore((s) => s.view)
  const { select, applyIntent, setActiveSheet, revealTarget, setView } = useStore.getState()

  const onIntent = React.useCallback((intent: Parameters<typeof applyIntent>[0]) => {
    const err = useStore.getState().applyIntent(intent)
    if (err) toast.error(err)
  }, [])
  const onError = React.useCallback((m: string) => toast.error(m), [])
  const onReveal = React.useCallback(
    (b: BlockModel) => {
      if (useStore.getState().view === "data") setView("split")
      if (b.type === "table") revealTarget({ type: "table", table: b.name })
    },
    [revealTarget, setView],
  )

  const sheet = model?.sheets[activeSheet] ?? model?.sheets[0]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FormulaBar />
      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">The code has an error{model ? ", showing the last working version" : ""}.</span>{" "}
            {error.message}
          </span>
          {view === "data" && (
            <Button size="xs" variant="outline" onClick={() => setView("split")}>
              Show code
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4" onMouseDown={(e) => e.target === e.currentTarget && select(null)}>
        {sheet ? (
          <SheetView
            sheet={sheet}
            workbook={model!}
            selection={selection}
            onSelect={select}
            onIntent={onIntent}
            onError={onError}
            onRevealBlock={onReveal}
          />
        ) : (
          !error && <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
        )}
        {model && model.issues.length > 0 && (
          <ul className="mt-4 text-sm text-warning">
            {model.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
      {model && (
        <SheetTabs
          className="shrink-0 border-t bg-muted/40 px-2 py-1.5"
          sheets={model.sheets}
          active={Math.min(activeSheet, model.sheets.length - 1)}
          onChange={setActiveSheet}
          onAdd={(name) => {
            const err = applyIntent({ type: "addSheet", name })
            if (err) toast.error(err)
            else setActiveSheet(model.sheets.length)
          }}
        />
      )}
    </div>
  )
}
