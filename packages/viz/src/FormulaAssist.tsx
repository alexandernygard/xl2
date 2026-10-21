import * as React from "react"
import {
  FUNCTION_CATEGORIES,
  FUNCTION_DOCS,
  OPERATOR_DOCS,
  callSignature,
  formulaCaret,
  formulaRefSpans,
  formulaSuggestions,
  type FormulaNames,
  type FormulaRefSpan,
  type FormulaSuggestion,
} from "@xl2/sdk"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@alexandernygard/components"
import { MousePointerClickIcon } from "lucide-react"

// Building cell formulas: references coloured as you type (and outlined on the
// grid), completions for functions and names, the current function's
// arguments, operator chips, and a searchable function palette.

const EMPTY_NAMES: FormulaNames = { tables: [], params: [] }

/** Reference colours, Excel style: each distinct reference gets the next one. */
export const REF_COLORS = ["#2f6fdb", "#d6453d", "#7c4dce", "#1f9d61", "#d9790f", "#0f8f99", "#c23c8f"]

export interface ColoredRef extends FormulaRefSpan {
  color: string
}

/** References in a formula with their colours; the same reference written twice shares a colour. */
export function coloredRefs(text: string): ColoredRef[] {
  if (!text.startsWith("=")) return []
  const keys: string[] = []
  return formulaRefSpans(text).map((s) => {
    const key = `${s.sheet ?? ""}!${s.from}:${s.to ?? s.from}`
    let i = keys.indexOf(key)
    if (i < 0) i = keys.push(key) - 1
    return { ...s, color: REF_COLORS[i % REF_COLORS.length] }
  })
}

/** An input that colours the references of a formula. Plain text shows as usual. */
export function FormulaInput({
  ref,
  value,
  className,
  style,
  inputClassName,
  ...props
}: Omit<React.ComponentProps<"input">, "value"> & { value: string; inputClassName?: string }) {
  const inner = React.useRef<HTMLInputElement>(null)
  const mirror = React.useRef<HTMLSpanElement>(null)
  React.useImperativeHandle(ref, () => inner.current!)
  const formula = value.startsWith("=")
  const refs = React.useMemo(() => coloredRefs(value), [value])
  const sync = () => {
    if (mirror.current && inner.current) mirror.current.style.transform = `translateX(${-inner.current.scrollLeft}px)`
  }
  React.useLayoutEffect(sync)

  const parts: React.ReactNode[] = []
  let at = 0
  for (const r of refs) {
    if (r.start > at) parts.push(value.slice(at, r.start))
    parts.push(
      <span key={r.start} style={{ color: r.color }} className="font-semibold">
        {value.slice(r.start, r.end)}
      </span>,
    )
    at = r.end
  }
  parts.push(value.slice(at))

  return (
    <div className={cn("relative", className)} style={style}>
      {formula && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-2 whitespace-pre">
          <span ref={mirror}>{parts}</span>
        </div>
      )}
      <input
        ref={inner}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "absolute inset-0 size-full bg-transparent px-2 outline-none",
          formula && "text-transparent caret-foreground selection:bg-highlight/30",
          inputClassName,
        )}
        {...props}
        onScroll={(e) => {
          sync()
          props.onScroll?.(e)
        }}
        onSelect={(e) => {
          sync()
          props.onSelect?.(e)
        }}
      />
    </div>
  )
}

/** Put `insert` at the caret (replacing a selection) and say where the caret goes. */
export function insertAt(text: string, from: number, to: number, insert: string) {
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length }
}

export interface FormulaAssist {
  text: string
  caret: number
  suggestions: FormulaSuggestion[]
  active: number
  signature: ReturnType<typeof callSignature>
  canPoint: boolean
  /** Call from the input's onChange/onSelect/onKeyUp/onClick so the caret stays current. */
  track: () => void
  /** Handles completion keys; returns true when it used the key. */
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean
  apply: (s: FormulaSuggestion) => void
  /** Insert at the caret, e.g. from an operator chip or the function palette. */
  insert: (text: string) => void
  setActive: (i: number) => void
}

/** Completion and hint state for a formula input. */
export function useFormulaAssist({
  text,
  input,
  names,
  onText,
}: {
  text: string
  input: React.RefObject<HTMLInputElement | null>
  names?: FormulaNames
  onText: (text: string) => void
}): FormulaAssist {
  const [caret, setCaret] = React.useState(text.length)
  const [active, setActive] = React.useState(0)
  const [dismissed, setDismissed] = React.useState<string | null>(null)
  const pending = React.useRef<number | null>(null)

  const track = React.useCallback(() => {
    const el = input.current
    if (el && document.activeElement === el) setCaret(el.selectionStart ?? el.value.length)
  }, [input])

  // place the caret once a programmatic change has rendered
  React.useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    if (pending.current === null) {
      // the text may have changed from outside (pointing at cells): read the caret after it settles
      const id = requestAnimationFrame(track)
      return () => cancelAnimationFrame(id)
    }
    const c = pending.current
    pending.current = null
    el.focus()
    el.setSelectionRange(c, c)
    setCaret(c)
  }, [text, input, track])

  const c = Math.min(caret, text.length)
  const formula = text.startsWith("=")
  const at = formula ? formulaCaret(text, c) : null
  const all = React.useMemo(() => (formula ? formulaSuggestions(text, c, names ?? EMPTY_NAMES) : []), [formula, text, c, names])
  const key = at ? `${at.word.start}:${text.slice(0, at.word.start)}` : ""
  const suggestions = dismissed === key ? [] : all
  React.useEffect(() => setActive(0), [all.length, key])
  const signature = at?.call ? callSignature(at.call) : null

  const change = (next: string, nextCaret: number) => {
    pending.current = nextCaret
    onText(next)
  }
  const apply = (s: FormulaSuggestion) => {
    const r = insertAt(text, s.from, c, s.insert)
    const rest = text.slice(c)
    // calls get their closing parenthesis (and quote) right away when nothing follows
    if (s.kind === "function" && !/^\s*[\w(]/.test(rest)) change(r.text.slice(0, r.caret) + ")" + r.text.slice(r.caret), r.caret)
    else if (s.kind === "method" && s.insert.endsWith('("') && !/^\s*[\w(]/.test(rest)) change(r.text.slice(0, r.caret) + '")' + r.text.slice(r.caret), r.caret)
    else if (s.kind === "column") {
      // step past the closing quote and parenthesis
      const close = /^["'`]\)?/.exec(r.text.slice(r.caret))?.[0] ?? ""
      change(r.text, r.caret + close.length)
    } else change(r.text, r.caret)
  }
  const insert = (ins: string) => {
    const el = input.current
    const from = el && document.activeElement === el ? (el.selectionStart ?? c) : c
    const to = el && document.activeElement === el ? (el.selectionEnd ?? from) : from
    const r = insertAt(text, from, to, ins)
    change(r.text, r.caret)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const n = suggestions.length
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
      return true
    }
    const s = suggestions[active]
    // Enter keeps committing when the word is already complete (e.g. a param's name)
    if (e.key === "Tab" || (e.key === "Enter" && s && s.insert !== text.slice(s.from, c))) {
      e.preventDefault()
      apply(s)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setDismissed(key)
      return true
    }
    return false
  }

  return { text, caret: c, suggestions, active, signature, canPoint: !!at?.canPoint, track, onKeyDown, apply, insert, setActive }
}

const STARTERS = ["SUM", "AVERAGE", "IF", "MIN", "MAX", "COUNT", "ROUND", "XLOOKUP"]
const KIND_TAG: Record<FormulaSuggestion["kind"], string> = { function: "fx", table: "tbl", param: "in", method: ".", column: "col" }

/** The panel under a formula input: completions, the current call's arguments, or a starter set. */
export function FormulaAssistPanel({ assist, className, style }: { assist: FormulaAssist; className?: string; style?: React.CSSProperties }) {
  const { text, suggestions, active, signature } = assist
  if (!text.startsWith("=")) return null
  const keep = (e: React.MouseEvent) => e.preventDefault() // never steal focus from the input
  return (
    <div
      role="dialog"
      aria-label="Formula help"
      // only its buttons take clicks, so cells underneath can still be pointed at
      className={cn(
        "pointer-events-none w-72 overflow-hidden rounded-lg bg-popover/95 text-[12px] text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className,
      )}
      style={style}
    >
      {suggestions.length > 0 ? (
        <ul role="listbox" aria-label="Suggestions" className="pointer-events-auto max-h-64 overflow-y-auto p-1" onMouseDown={(e) => e.stopPropagation()}>
          {suggestions.map((s, i) => (
            <li
              key={`${s.kind}:${s.label}`}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1", i === active && "bg-accent text-accent-foreground")}
              onMouseEnter={() => assist.setActive(i)}
              onMouseDown={(e) => {
                keep(e)
                assist.apply(s)
              }}
            >
              <span className="w-7 shrink-0 rounded bg-muted px-1 text-center font-mono text-[10px] text-muted-foreground">{KIND_TAG[s.kind]}</span>
              <span className="shrink-0 font-mono font-medium">{s.label}</span>
              <span className="truncate text-muted-foreground">{s.detail}</span>
            </li>
          ))}
          <li className="px-2 pt-1 text-[11px] text-muted-foreground">
            <Kbd>Tab</Kbd> to insert · <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to choose
          </li>
        </ul>
      ) : (
        <div className="grid gap-1.5 p-1.5">
          <div className="flex flex-wrap gap-0.5">
            {OPERATOR_DOCS.map((o) => (
              <Chip key={o.op} title={o.description} mono onPick={() => assist.insert(o.op)}>
                {o.label}
              </Chip>
            ))}
          </div>
          {signature ? (
            <div>
              <div className="font-mono">
                <span className="font-semibold">{signature.name}</span>(
                {signature.args.map((a, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && ", "}
                    <span className={cn(i === signature.active ? "rounded bg-highlight/25 px-0.5 font-semibold text-foreground" : "text-muted-foreground")}>{a}</span>
                  </React.Fragment>
                ))}
                )
              </div>
              <div className="mt-0.5 text-muted-foreground">{signature.description}</div>
            </div>
          ) : text === "=" ? (
            <div className="grid gap-1.5">
              <div className="text-muted-foreground">Pick a function, or click a cell</div>
              <div className="flex flex-wrap gap-1">
                {STARTERS.map((n) => (
                  <Chip key={n} onPick={() => assist.apply({ label: n, kind: "function", detail: "", insert: `${n}(`, from: 1 })}>
                    {n}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
          {assist.canPoint && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <MousePointerClickIcon className="size-3.5 shrink-0" />
              Click or drag cells (or use arrows) to reference them
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Chip({ children, title, mono, onPick }: { children: React.ReactNode; title?: string; mono?: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      tabIndex={-1}
      className={cn(
        "pointer-events-auto h-5 min-w-5 rounded border bg-background px-1 text-[11px] hover:border-highlight hover:bg-highlight/10",
        mono ? "font-mono" : "font-mono font-medium",
      )}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onPick()
      }}
    >
      {children}
    </button>
  )
}

/** A searchable list of every function, grouped by category, with arguments and an example. */
export function FunctionPalette({ onPick, children }: { onPick: (name: string) => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] p-0" onCloseAutoFocus={(e) => e.preventDefault()}>
        <Command>
          <CommandInput placeholder="Search functions…" />
          <CommandList className="max-h-96">
            <CommandEmpty>No function found.</CommandEmpty>
            {FUNCTION_CATEGORIES.map((cat) => (
              <CommandGroup key={cat} heading={cat}>
                {FUNCTION_DOCS.filter((d) => d.category === cat).map((d) => (
                  <CommandItem
                    key={d.name}
                    value={`${d.name} ${d.description}`}
                    className="flex-col items-start gap-0.5"
                    onSelect={() => {
                      setOpen(false)
                      onPick(d.name)
                    }}
                  >
                    <span className="font-mono text-xs">
                      <span className="font-semibold">{d.name}</span>
                      <span className="text-muted-foreground">({d.args.join(", ")})</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {d.description} <code className="text-foreground/80">{d.example}</code>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
