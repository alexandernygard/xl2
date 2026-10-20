import * as React from "react"
import type { ColumnKind } from "@xl2/sdk"
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@alexandernygard/components"
import { CalendarIcon, HashIcon, ListIcon, PercentIcon, PlusIcon, SigmaIcon, ToggleLeftIcon, TypeIcon, WalletIcon } from "lucide-react"

export const KIND_ICON: Record<ColumnKind, React.ComponentType<{ className?: string }>> = {
  text: TypeIcon,
  number: HashIcon,
  currency: WalletIcon,
  percent: PercentIcon,
  date: CalendarIcon,
  boolean: ToggleLeftIcon,
  select: ListIcon,
  formula: SigmaIcon,
}

const NEW_KINDS: ColumnKind[] = ["text", "number", "currency", "percent", "date", "boolean", "formula"]

/** "+" button with a popover to name a new column and pick its type. */
export function AddColumn({ onAdd }: { onAdd: (key: string, kind: ColumnKind, label: string) => void }) {
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
