import * as React from "react"
import { Button, Input, cn } from "@alexandernygard/components"
import { PlusIcon } from "lucide-react"

export interface SheetTabsProps {
  sheets: { name: string }[]
  active: number
  onChange: (index: number) => void
  onAdd?: (name: string) => void
  onRename?: (index: number, name: string) => void
  /** Sheets with changes under review get a dot. */
  marked?: number[]
  className?: string
}

/** Excel-style sheet tabs. */
export function SheetTabs({ sheets, active, onChange, onAdd, onRename, marked, className }: SheetTabsProps) {
  const [adding, setAdding] = React.useState(false)
  const [name, setName] = React.useState("")
  const [renaming, setRenaming] = React.useState<number | null>(null)
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto", className)} role="tablist">
      {sheets.map((s, i) =>
        renaming === i ? (
          <form
            key={s.name + i}
            onSubmit={(e) => {
              e.preventDefault()
              const v = new FormData(e.currentTarget).get("name")?.toString().trim()
              if (v && v !== s.name) onRename?.(i, v)
              setRenaming(null)
            }}
          >
            <Input name="name" autoFocus defaultValue={s.name} onBlur={(e) => e.currentTarget.form?.requestSubmit()} className="h-7 w-32" />
          </form>
        ) : (
        <button
          key={s.name + i}
          role="tab"
          aria-selected={i === active}
          onClick={() => onChange(i)}
          onDoubleClick={() => onRename && setRenaming(i)}
          title={onRename ? "Double-click to rename" : undefined}
          className={cn(
            "rounded-md px-3 py-1 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
            i === active && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
          )}
        >
          {s.name}
          {marked?.includes(i) && <span aria-label="has changes" className="ml-1.5 inline-block size-1.5 rounded-full bg-highlight align-middle" />}
        </button>
        ),
      )}
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
