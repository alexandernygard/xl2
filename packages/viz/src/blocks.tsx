import * as React from "react"
import { formatValue, isCellError, type MetricModel, type TextModel } from "@xl2/sdk"
import { cn } from "@alexandernygard/components"
import type { ViewContext } from "./types"

export function MetricView({ metric, ctx }: { metric: MetricModel; ctx: ViewContext }) {
  const bad = isCellError(metric.value)
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-xs text-muted-foreground">{metric.title}</span>
      <span
        className={cn("truncate font-heading text-2xl leading-tight tabular-nums", bad && "text-destructive")}
        title={bad ? (metric.value as { error: string }).error : undefined}
      >
        {bad ? "#ERR" : formatValue(metric.value, metric.format, { ...ctx, decimals: metric.decimals })}
      </span>
      {metric.caption && <span className="truncate text-xs text-muted-foreground">{metric.caption}</span>}
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
  return <div className="space-y-1 text-sm leading-relaxed">{blocks}</div>
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
