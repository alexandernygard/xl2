import * as React from "react"
import { formatValue, type ChartModel } from "@xl2/sdk"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@alexandernygard/components"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, Scatter, ScatterChart, XAxis, YAxis } from "recharts"
import type { ViewContext } from "./types"

const color = (i: number) => `var(--chart-${(i % 5) + 1})`

function compact(v: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(v)
}

// CSS custom property names can't contain every character a key might.
const cssKey = (k: string) => k.replace(/[^a-zA-Z0-9_-]/g, "_")

export function ChartView({ chart, ctx }: { chart: ChartModel; ctx: ViewContext }) {
  const fmt = (v: unknown) => (typeof v === "number" ? formatValue(v, chart.format, ctx) : String(v ?? ""))

  if (chart.error) return <p className="p-4 text-sm text-destructive">{chart.error}</p>
  if (!chart.data.length) return <p className="p-4 text-sm text-muted-foreground">No data</p>

  if (chart.kind === "pie") {
    const s = chart.series[0]
    const data = chart.data.map((d, i) => ({ name: String(d[chart.x] ?? ""), value: d[s.key] ?? 0, fill: color(i) }))
    const config: ChartConfig = Object.fromEntries(data.map((d, i) => [d.name, { label: d.name, color: color(i) }]))
    return (
      <ChartContainer config={config} className="mx-auto aspect-square max-h-72 w-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" formatter={(v, n) => <TooltipRow name={String(n)} value={fmt(v)} />} />} />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" strokeWidth={2} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.fill} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="name" />} className="flex-wrap" />
        </PieChart>
      </ChartContainer>
    )
  }

  const config: ChartConfig = Object.fromEntries(chart.series.map((s, i) => [cssKey(s.key), { label: s.label, color: color(i) }]))
  // recharts reads values by key; remap to css-safe keys so colors resolve
  const data = chart.data.map((d) => {
    const p: Record<string, unknown> = { __x: d[chart.x] }
    for (const s of chart.series) p[cssKey(s.key)] = d[s.key]
    return p
  })
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="__x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
      <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compact(v, ctx.locale)} />
      <ChartTooltip
        content={<ChartTooltipContent formatter={(v, n) => <TooltipRow name={String(config[String(n)]?.label ?? n)} value={fmt(v)} color={`var(--color-${n})`} />} />}
      />
      {chart.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
    </>
  )
  const stack = chart.stacked ? "a" : undefined
  const keys = chart.series.map((s) => cssKey(s.key))

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      {chart.kind === "bar" ? (
        <BarChart data={data}>
          {axes}
          {keys.map((k) => (
            <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={4} stackId={stack} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : chart.kind === "line" ? (
        <LineChart data={data}>
          {axes}
          {keys.map((k) => (
            <Line key={k} dataKey={k} stroke={`var(--color-${k})`} strokeWidth={2} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      ) : chart.kind === "area" ? (
        <AreaChart data={data}>
          {axes}
          {keys.map((k) => (
            <Area
              key={k}
              dataKey={k}
              stroke={`var(--color-${k})`}
              fill={`var(--color-${k})`}
              fillOpacity={0.25}
              stackId={stack}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      ) : (
        <ScatterChart>
          <CartesianGrid />
          <XAxis dataKey="__x" type="number" tickLine={false} axisLine={false} tickFormatter={(v) => compact(v, ctx.locale)} />
          <YAxis dataKey={keys[0]} type="number" tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compact(v, ctx.locale)} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Scatter data={data} fill={`var(--color-${keys[0]})`} isAnimationActive={false} />
        </ScatterChart>
      )}
    </ChartContainer>
  )
}

function TooltipRow({ name, value, color }: { name: string; value: string; color?: string }) {
  return (
    <div className="flex w-full items-center gap-2">
      {color && <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />}
      <span className="text-muted-foreground">{name}</span>
      <span className="ml-auto font-mono font-medium tabular-nums">{value}</span>
    </div>
  )
}
