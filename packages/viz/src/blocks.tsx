import * as React from "react"
import {
  coerceInput,
  editText,
  formatValue,
  isCellError,
  kindForFormat,
  type MetricModel,
  type ParamModel,
  type TextModel,
} from "@xl2/sdk"
import { Input, Slider, Switch, cn } from "@alexandernygard/components"
import type { IntentHandler, ViewContext } from "./types"

export function MetricView({ metric, ctx }: { metric: MetricModel; ctx: ViewContext }) {
  const bad = isCellError(metric.value)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{metric.title}</span>
      <span
        className={cn("font-heading text-3xl tabular-nums", bad && "text-destructive")}
        title={bad ? (metric.value as { error: string }).error : undefined}
      >
        {bad ? "#ERR" : formatValue(metric.value, metric.format, { ...ctx, decimals: metric.decimals })}
      </span>
      {metric.caption && <span className="text-xs text-muted-foreground">{metric.caption}</span>}
    </div>
  )
}

export function ParamView({
  param,
  ctx,
  onIntent,
  onError,
}: {
  param: ParamModel
  ctx: ViewContext
  onIntent: IntentHandler
  onError?: (m: string) => void
}) {
  const kind = kindForFormat(param.format)
  const display = editText(param.value, kind)
  const [draft, setDraft] = React.useState(display)
  const [live, setLive] = React.useState<number | null>(null)
  const [focused, setFocused] = React.useState(false)
  React.useEffect(() => setDraft(display), [display])

  const set = (value: string | number | boolean | null) => {
    if (value !== param.value) onIntent({ type: "setParam", name: param.name, value })
  }
  const commit = () => {
    const parsed = coerceInput(draft, kind, param.options)
    if (!parsed.ok) {
      onError?.(parsed.error)
      setDraft(display)
    } else set(parsed.value)
  }

  const numeric = typeof param.value === "number"
  const hasRange = numeric && param.min !== undefined && param.max !== undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={`param-${param.name}`} className="text-sm text-muted-foreground">
          {param.label}
        </label>
        <code className="text-[11px] text-muted-foreground/70">{param.name}</code>
      </div>
      {typeof param.value === "boolean" ? (
        <Switch id={`param-${param.name}`} checked={param.value} onCheckedChange={(v) => set(v)} />
      ) : param.options ? (
        <select
          id={`param-${param.name}`}
          className="h-8 rounded-lg border bg-background px-2 text-sm"
          value={String(param.value ?? "")}
          onChange={(e) => set(e.target.value)}
        >
          {param.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <Input
          id={`param-${param.name}`}
          value={live !== null ? formatValue(live, param.format, ctx) : focused ? draft : formatValue(param.value, param.format, ctx)}
          className="font-heading text-xl tabular-nums"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commit()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") setDraft(display)
          }}
        />
      )}
      {hasRange && (
        <Slider
          aria-label={param.label}
          min={param.min}
          max={param.max}
          step={param.step ?? (param.max! - param.min!) / 100}
          value={[live ?? (param.value as number)]}
          onValueChange={([v]) => setLive(v)}
          onValueCommit={([v]) => {
            setLive(null)
            set(+v.toPrecision(10))
          }}
        />
      )}
    </div>
  )
}

/** Tiny markdown: headings, bullet lists, paragraphs, **bold**, *italic*, `code`. */
export function TextView({ text }: { text: TextModel }) {
  const blocks: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      )
      list = []
    }
  }
  for (const line of text.content.split("\n")) {
    const t = line.trim()
    if (/^[-*] /.test(t)) {
      list.push(t.slice(2))
      continue
    }
    flush()
    if (!t) continue
    const h = /^(#{1,3}) (.*)$/.exec(t)
    if (h) {
      const size = h[1].length === 1 ? "text-2xl" : h[1].length === 2 ? "text-xl" : "text-lg"
      blocks.push(
        <p key={blocks.length} className={cn("font-heading", size)}>
          {inline(h[2])}
        </p>,
      )
    } else blocks.push(<p key={blocks.length}>{inline(t)}</p>)
  }
  flush()
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>
}

function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("**")) out.push(<strong key={m.index}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith("`"))
      out.push(
        <code key={m.index} className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {tok.slice(1, -1)}
        </code>,
      )
    else out.push(<em key={m.index}>{tok.slice(1, -1)}</em>)
    last = m.index! + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
