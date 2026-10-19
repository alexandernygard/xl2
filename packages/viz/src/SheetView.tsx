import * as React from "react"
import type { BlockModel, SheetModel, WorkbookModel } from "@xl2/sdk"
import { Badge, Button, Input, cn } from "@alexandernygard/components"
import { ChartBarIcon, DatabaseIcon, PlusIcon, SigmaIcon, TableIcon } from "lucide-react"
import { DataGrid } from "./DataGrid"
import { ChartView } from "./ChartBlock"
import { MetricView, ParamView, TextView } from "./blocks"
import type { GridSelection, IntentHandler, ViewContext } from "./types"

const SPAN: Record<number, string> = {
  1: "@3xl/sheet:col-span-1",
  2: "@3xl/sheet:col-span-2",
  3: "@3xl/sheet:col-span-3",
  4: "@3xl/sheet:col-span-4",
}

export interface SheetViewProps {
  sheet: SheetModel
  workbook: WorkbookModel
  selection: GridSelection | null
  onSelect: (sel: GridSelection | null) => void
  onIntent: IntentHandler
  onError?: (message: string) => void
  /** Called when a block's title is clicked, e.g. to reveal it in code. */
  onRevealBlock?: (block: BlockModel) => void
  className?: string
}

/** One sheet: its blocks laid out on a 4-column grid that collapses on narrow containers. */
export function SheetView({ sheet, workbook, selection, onSelect, onIntent, onError, onRevealBlock, className }: SheetViewProps) {
  const ctx: ViewContext = { locale: workbook.locale, currency: workbook.currency }
  const props = { ctx, selection, onSelect, onIntent, onError }
  return (
    <div className={cn("@container/sheet", className)}>
      <div className="grid grid-cols-1 gap-4 @xl/sheet:grid-cols-2 @3xl/sheet:grid-cols-4">
        {sheet.blocks.map((b) => (
          <div key={b.id} className={cn("min-w-0", b.span >= 2 && "@xl/sheet:col-span-2", SPAN[b.span])}>
            <Block block={b} {...props} onReveal={onRevealBlock} />
          </div>
        ))}
        {sheet.blocks.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            This sheet is empty. Ask the assistant to add something, or add blocks in code.
          </div>
        )}
      </div>
    </div>
  )
}

function Block({
  block,
  ctx,
  selection,
  onSelect,
  onIntent,
  onError,
  onReveal,
}: {
  block: BlockModel
  ctx: ViewContext
  selection: GridSelection | null
  onSelect: (sel: GridSelection | null) => void
  onIntent: IntentHandler
  onError?: (message: string) => void
  onReveal?: (block: BlockModel) => void
}) {
  const frame = "h-full rounded-xl bg-card p-4 ring-1 ring-foreground/10"
  switch (block.type) {
    case "text":
      return (
        <div className="px-1 py-2">
          <TextView text={block} />
        </div>
      )
    case "metric":
      return (
        <div className={frame}>
          <MetricView metric={block} ctx={ctx} />
        </div>
      )
    case "param":
      return (
        <div className={cn(frame, "bg-highlight/5 ring-highlight/40")}>
          <ParamView param={block} ctx={ctx} onIntent={onIntent} onError={onError} />
        </div>
      )
    case "chart":
      return (
        <div className={cn(frame, "flex flex-col gap-3")}>
          <BlockTitle icon={ChartBarIcon} title={block.title} onClick={onReveal && (() => onReveal(block))} />
          <ChartView chart={block} ctx={ctx} />
        </div>
      )
    case "table":
      return (
        <div className="flex h-full flex-col gap-2">
          <div className="flex items-center gap-2 px-1">
            <BlockTitle
              icon={block.source === "query" ? DatabaseIcon : TableIcon}
              title={block.title}
              onClick={onReveal && (() => onReveal(block))}
            />
            <code className="text-xs text-muted-foreground">{block.name}</code>
            {block.source === "query" && (
              <Badge variant="info" className="gap-1">
                <SigmaIcon /> query
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{block.rows.length} rows</span>
          </div>
          {block.error && block.rows.length > 0 && <p className="px-1 text-sm text-destructive">{block.error}</p>}
          <DataGrid table={block} ctx={ctx} selection={selection} onSelect={onSelect} onIntent={onIntent} onError={onError} className="max-h-[32rem]" />
        </div>
      )
  }
}

function BlockTitle({
  icon: Icon,
  title,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center gap-2 text-left font-heading text-base enabled:hover:underline"
      title={onClick ? "Show in code" : undefined}
    >
      <Icon className="size-4 text-muted-foreground" />
      {title}
    </button>
  )
}

export interface SheetTabsProps {
  sheets: { name: string }[]
  active: number
  onChange: (index: number) => void
  onAdd?: (name: string) => void
  className?: string
}

/** Excel-style sheet tabs. */
export function SheetTabs({ sheets, active, onChange, onAdd, className }: SheetTabsProps) {
  const [adding, setAdding] = React.useState(false)
  const [name, setName] = React.useState("")
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto", className)} role="tablist">
      {sheets.map((s, i) => (
        <button
          key={s.name + i}
          role="tab"
          aria-selected={i === active}
          onClick={() => onChange(i)}
          className={cn(
            "rounded-md px-3 py-1 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
            i === active && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
          )}
        >
          {s.name}
        </button>
      ))}
      {onAdd &&
        (adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) onAdd(name.trim())
              setName("")
              setAdding(false)
            }}
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setAdding(false)}
              placeholder="Sheet name"
              className="h-7 w-32"
            />
          </form>
        ) : (
          <Button size="icon-xs" variant="ghost" aria-label="Add sheet" onClick={() => setAdding(true)}>
            <PlusIcon />
          </Button>
        ))}
    </div>
  )
}
