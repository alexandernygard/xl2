import * as React from "react"
import {
  address,
  cellAt,
  cellLabel,
  colName,
  editTextFor,
  formulaSource,
  inputIntents,
  isEditable,
  parseAddress,
  rangeName,
  styleIntents,
  type CellInfo,
  type Format,
  type SheetModel,
  type TableModel,
} from "@xl2/sdk"
import { SheetGrid, SheetTabs, selectionRect, type GridAction, type SheetGridHandle } from "@xl2/viz"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  Spinner,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  toast,
} from "@alexandernygard/components"
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ChartBarIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  GaugeIcon,
  ItalicIcon,
  PlusIcon,
  RotateCcwIcon,
  SigmaIcon,
  SlidersHorizontalIcon,
  TableIcon,
  TypeIcon,
} from "lucide-react"
import { useStore } from "../store"

const FORMATS: { format: Format | null; label: string; example: string }[] = [
  { format: null, label: "Automatic", example: "" },
  { format: "number", label: "Number", example: "1,234.5" },
  { format: "integer", label: "Integer", example: "1,235" },
  { format: "currency", label: "Currency", example: "$1,234.50" },
  { format: "percent", label: "Percent", example: "12.5%" },
  { format: "date", label: "Date", example: "Jan 31, 2026" },
  { format: "text", label: "Text", example: "abc" },
]

function useActiveSheet(): SheetModel | null {
  const model = useStore((s) => s.model)
  const i = useStore((s) => s.activeSheet)
  return model?.sheets[Math.min(i, model.sheets.length - 1)] ?? null
}

function useFocusInfo(sheet: SheetModel | null): CellInfo | null {
  const selection = useStore((s) => s.selection)
  if (!sheet || !selection) return null
  return cellAt(sheet, selection.focus.row, selection.focus.col)
}

const report = (err: string | null) => err && toast.error(err)

// --- code generation for inserts ------------------------------------------------

function uniqueName(sheetNames: string[], base: string) {
  let n = 1
  while (sheetNames.includes(`${base}${n}`)) n++
  return `${base}${n}`
}

function tableNames() {
  return (useStore.getState().model?.sheets ?? []).flatMap((s) => s.blocks.map((b) => ("name" in b ? b.name : "")))
}

function chartCode(t: TableModel, kind: "bar" | "line" | "pie", at: string) {
  const x = t.columns.find((c) => c.kind === "text" || c.kind === "select" || c.kind === "date") ?? t.columns[0]
  const ys = t.columns.filter((c) => c !== x && ["number", "currency", "percent", "formula"].includes(c.kind) && c.format !== "text").slice(0, kind === "pie" ? 1 : 2)
  if (!x || !ys.length) return null
  const y = ys.length === 1 ? JSON.stringify(ys[0].key) : `[${ys.map((c) => JSON.stringify(c.key)).join(", ")}]`
  const agg = kind === "pie" || kind === "bar" ? `, aggregate: "sum"` : ""
  return `chart.${kind}(${JSON.stringify(`${ys[0].label} by ${x.label.toLowerCase()}`)}, { data: ${JSON.stringify(t.name)}, x: ${JSON.stringify(x.key)}, y: ${y}${agg}, at: ${JSON.stringify(at)} })`
}

/** Room for a w×h block to the right of a table, else below the used area. */
function placeNear(sheet: SheetModel, t: TableModel | null, w: number, h: number) {
  if (t) {
    const col = t.rect.col + t.rect.cols + 1
    return rangeName({ row: t.rect.row, col, rows: h, cols: w })
  }
  return rangeName({ row: sheet.extent.rows + 1, col: 0, rows: h, cols: w })
}

export function insertBlock(kind: "table" | "chart" | "metric" | "text" | "param", opts: { table?: TableModel; chart?: "bar" | "line" | "pie" } = {}) {
  const s = useStore.getState()
  const sheet = s.model?.sheets[s.activeSheet]
  if (!sheet) return
  const sel = s.selection
  const rect = sel ? selectionRect(sel) : { row: sheet.extent.rows + 1, col: 0, rows: 1, cols: 1 }
  const anchor = address(rect.row, rect.col)
  const info = sel ? cellAt(sheet, sel.focus.row, sel.focus.col) : null
  const free = (r: number, c: number) => cellAt(sheet, r, c).kind === "empty"
  if (kind !== "chart" && !free(rect.row, rect.col)) return void toast.error("Pick an empty cell first")
  let code: string | null = null
  switch (kind) {
    case "table": {
      const name = uniqueName(tableNames(), "table")
      code = `table(${JSON.stringify(name)}, {\n      at: ${JSON.stringify(anchor)},\n      columns: {\n        name: col.text({ label: "Name" }),\n        value: col.number({ label: "Value" }),\n      },\n      rows: [],\n    })`
      break
    }
    case "chart": {
      const t = opts.table ?? (info?.kind === "table" ? info.table : null)
      if (!t) return void toast.error("Select a cell in a table to chart it")
      code = chartCode(t, opts.chart ?? "bar", placeNear(sheet, t, 6, 13))
      if (!code) return void toast.error(`"${t.name}" needs a label column and a number column to chart`)
      break
    }
    case "metric": {
      const src = rect.rows * rect.cols > 1 ? `SUM(ctx.range(${JSON.stringify(rangeName(rect))}))` : null
      const at = rangeName({ row: rect.row, col: rect.col + (src ? rect.cols + 1 : 0), rows: 3, cols: 2 })
      code = src
        ? `metric("Total", (ctx) => ctx.range(${JSON.stringify(rangeName(rect))}).reduce((a, b) => a + (Number(b) || 0), 0), { at: ${JSON.stringify(at)} })`
        : `metric("Metric", (ctx) => 0, { at: ${JSON.stringify(at)} })`
      break
    }
    case "text":
      code = `text("## Notes\\nWrite **markdown** here.", { at: ${JSON.stringify(rangeName({ row: rect.row, col: rect.col, rows: 3, cols: 5 }))} })`
      break
    case "param": {
      const name = uniqueName(tableNames(), "input")
      code = `param(${JSON.stringify(name)}, 0, { at: ${JSON.stringify(anchor)}, label: "Input" })`
      break
    }
  }
  if (!code) return
  report(s.applyIntent({ type: "addBlock", sheet: sheet.name, code }))
}

// --- toolbar ------------------------------------------------------------------------

function ToolButton({ label, shortcut, children, ...props }: React.ComponentProps<typeof Toggle> & { label: string; shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle size="sm" aria-label={label} {...props}>
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function Toolbar({ sheet }: { sheet: SheetModel | null }) {
  const selection = useStore((s) => s.selection)
  const evaluating = useStore((s) => s.evaluating)
  const info = useFocusInfo(sheet)
  const styled = info?.kind === "free" ? info.cell.style : undefined
  const format = info?.kind === "free" ? info.cell.style?.format : info?.kind === "table" ? info.column?.format : undefined
  const canStyle = !!sheet && !!selection
  const apply = (patch: Parameters<typeof styleIntents>[2]) => {
    if (!sheet || !selection) return
    const intents = styleIntents(sheet, selectionRect(selection), patch)
    if (!intents.length) return void toast.error("Styles apply to free cells; table formats apply per column")
    report(useStore.getState().applyIntent(intents))
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-card px-2">
      <ToolButton label="Bold" shortcut="⌘B" disabled={!canStyle} pressed={!!styled?.bold} onPressedChange={(p) => apply({ bold: p ? true : null })}>
        <BoldIcon />
      </ToolButton>
      <ToolButton label="Italic" shortcut="⌘I" disabled={!canStyle} pressed={!!styled?.italic} onPressedChange={(p) => apply({ italic: p ? true : null })}>
        <ItalicIcon />
      </ToolButton>
      <Separator orientation="vertical" className="mx-1 h-5!" />
      {(
        [
          ["left", AlignLeftIcon],
          ["center", AlignCenterIcon],
          ["right", AlignRightIcon],
        ] as const
      ).map(([a, Icon]) => (
        <ToolButton key={a} label={`Align ${a}`} disabled={!canStyle} pressed={styled?.align === a} onPressedChange={(p) => apply({ align: p ? a : null })}>
          <Icon />
        </ToolButton>
      ))}
      <Separator orientation="vertical" className="mx-1 h-5!" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={!canStyle} className="w-32 justify-between">
            {FORMATS.find((f) => f.format === (format ?? null))?.label ?? "Automatic"}
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Number format</DropdownMenuLabel>
          {FORMATS.map((f) => (
            <DropdownMenuItem key={f.label} onSelect={() => apply({ format: f.format })}>
              {f.label}
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{f.example}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator orientation="vertical" className="mx-1 h-5!" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={!sheet}>
            <PlusIcon /> Insert <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => insertBlock("table")}>
            <TableIcon /> Table
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => insertBlock("param")}>
            <SlidersHorizontalIcon /> Input (param)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => insertBlock("metric")}>
            <GaugeIcon /> Metric {selection && selectionRect(selection).rows * selectionRect(selection).cols > 1 ? "of selection" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => insertBlock("text")}>
            <TypeIcon /> Text
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Chart from {info?.kind === "table" ? `“${info.table.name}”` : "the selected table"}</DropdownMenuLabel>
          {(["bar", "line", "pie"] as const).map((k) => (
            <DropdownMenuItem key={k} disabled={info?.kind !== "table"} onSelect={() => insertBlock("chart", { chart: k })}>
              <ChartBarIcon /> {k[0].toUpperCase() + k.slice(1)} chart
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex items-center gap-2 pr-1 text-xs text-muted-foreground">{evaluating && <Spinner className="size-3.5" />}</div>
    </div>
  )
}

// --- formula bar ------------------------------------------------------------------------

function FormulaBar({ sheet, grid }: { sheet: SheetModel | null; grid: React.RefObject<SheetGridHandle | null> }) {
  const info = useFocusInfo(sheet)
  const selection = useStore((s) => s.selection)
  const source = useStore((s) => s.files[s.activeId]?.source ?? "")
  const [draft, setDraft] = React.useState("")
  const [name, setName] = React.useState("")
  const display = info ? editTextFor(info) : ""
  const key = info ? `${sheet?.name}:${info.address}` : ""
  React.useEffect(() => setDraft(display), [display, key])
  const rect = selection ? selectionRect(selection) : null
  const addr = rect ? rangeName(rect) : ""
  React.useEffect(() => setName(addr), [addr])

  const computed = info?.kind === "table" && info.column?.computed && info.region.kind === "data"
  const formula = computed
    ? info.table.source === "query"
      ? `query("${info.table.name}")`
      : formulaSource(source, info.table.name, info.column!.key)
    : null
  const editable = !!info && isEditable(info)

  const commit = () => {
    if (!sheet || !info || draft === display) return
    const res = inputIntents(sheet, info, draft)
    if (!res.ok) {
      toast.error(res.error)
      setDraft(display)
    } else if (res.intents.length) report(useStore.getState().applyIntent(res.intents))
  }

  const goTo = () => {
    const [a, b] = name.trim().toUpperCase().split(":")
    const p = parseAddress(a ?? "")
    const q = b ? parseAddress(b) : p
    if (!p || !q) return void setName(addr)
    useStore.getState().select({ anchor: p, focus: q })
    grid.current?.scrollTo(q.row, q.col)
    grid.current?.focus()
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card px-2 text-sm">
      <input
        aria-label="Name box"
        className="h-7 w-24 shrink-0 rounded-md border bg-background px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        value={name}
        placeholder="A1"
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") goTo()
          if (e.key === "Escape") setName(addr)
        }}
        onBlur={() => setName(addr)}
      />
      <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground" title={info ? cellLabel(info) : undefined}>
        {info && info.kind !== "empty" && info.kind !== "free" ? cellLabel(info) : ""}
      </span>
      <SigmaIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {formula && !(info?.kind === "table" && info.overridden) ? (
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-info" title={`${formula}\nType in the cell to override this value.`}>
          {formula}
        </code>
      ) : (
        <input
          aria-label="Cell contents"
          className={cn("h-7 min-w-0 flex-1 bg-transparent outline-none disabled:opacity-50", draft.startsWith("=") && "font-mono text-xs")}
          disabled={!editable}
          value={draft}
          placeholder={info?.kind === "empty" ? "Type a value or =formula" : ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit()
              grid.current?.focus()
            }
            if (e.key === "Escape") {
              setDraft(display)
              grid.current?.focus()
            }
          }}
        />
      )}
      {info?.kind === "table" && info.overridden && info.column && info.region.kind === "data" && (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            report(
              useStore.getState().applyIntent({
                type: "setOverride",
                table: info.table.name,
                row: (info.region as { index: number }).index,
                column: info.column!.key,
                value: undefined,
              }),
            )
          }
        >
          <RotateCcwIcon /> Restore formula
        </Button>
      )}
    </div>
  )
}

// --- pane -------------------------------------------------------------------------------

export function DataPane() {
  const model = useStore((s) => s.model)
  const error = useStore((s) => s.error)
  const activeSheet = useStore((s) => s.activeSheet)
  const selection = useStore((s) => s.selection)
  const selectedBlock = useStore((s) => s.selectedBlock)
  const view = useStore((s) => s.view)
  const { select, selectBlock, applyIntent, setActiveSheet, revealTarget, setView } = useStore.getState()
  const grid = React.useRef<SheetGridHandle>(null)
  const sheet = useActiveSheet()
  const ctx = React.useMemo(() => ({ locale: model?.locale ?? "en-US", currency: model?.currency ?? "USD" }), [model?.locale, model?.currency])

  const onIntent = React.useCallback((intent: Parameters<typeof applyIntent>[0]) => report(useStore.getState().applyIntent(intent)), [])
  const onError = React.useCallback((m: string) => toast.error(m), [])
  const onAction = React.useCallback(
    (a: GridAction) => {
      const s = useStore.getState()
      const sh = s.model?.sheets[s.activeSheet]
      if (!sh) return
      if (a.type === "reveal") {
        if (s.view === "data") setView("split")
        const b = sh.blocks[a.block]
        if (b?.type === "table" && b.source === "table") revealTarget({ type: "table", table: b.name })
        else revealTarget({ type: "block", sheet: sh.name, index: a.block })
      } else if (a.type === "chartFromTable") {
        const t = sh.blocks.find((b): b is TableModel => b.type === "table" && b.name === a.table)
        if (t) insertBlock("chart", { table: t, chart: a.kind })
      }
    },
    [revealTarget, setView],
  )

  // the first cell is selected when a sheet opens, so typing works right away
  React.useEffect(() => {
    if (sheet && !useStore.getState().selection) select({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
  }, [sheet?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar sheet={sheet} />
      <FormulaBar sheet={sheet} grid={grid} />
      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">The code has an error{model ? ", showing the last working version" : ""}.</span> {error.message}
          </span>
          {view === "data" && (
            <Button size="xs" variant="outline" onClick={() => setView("split")}>
              Show code
            </Button>
          )}
        </div>
      )}
      {model && model.issues.length > 0 && (
        <details className="shrink-0 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <summary className="cursor-pointer">
            {model.issues.length} layout or definition {model.issues.length === 1 ? "issue" : "issues"}
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {model.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </details>
      )}
      {sheet ? (
        <SheetGrid
          ref={grid}
          key={`${useStore.getState().activeId}:${sheet.index}`}
          className="min-h-0 flex-1"
          sheet={sheet}
          ctx={ctx}
          selection={selection}
          selectedBlock={selectedBlock}
          onSelect={select}
          onSelectBlock={selectBlock}
          onIntent={onIntent}
          onError={onError}
          onAction={onAction}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{error ? "" : <Spinner />}</div>
      )}
      {model && (
        <SheetTabs
          className="shrink-0 border-t bg-muted/40 px-2 py-1.5"
          sheets={model.sheets}
          active={Math.min(activeSheet, model.sheets.length - 1)}
          onChange={setActiveSheet}
          onRename={(i, name) => report(applyIntent({ type: "renameSheet", sheet: model.sheets[i].name, name }))}
          onAdd={(name) => {
            if (model.sheets.some((s) => s.name === name)) return void toast.error(`A sheet named "${name}" already exists`)
            const err = applyIntent({ type: "addSheet", name })
            if (err) toast.error(err)
            else setActiveSheet(model.sheets.length)
          }}
        />
      )}
    </div>
  )
}

