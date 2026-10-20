import * as React from "react"
import type { ChartModel, MetricModel, TextModel } from "@xl2/sdk"
import { cn } from "@alexandernygard/components"
import { ChartBarIcon } from "lucide-react"
import { ChartView } from "./ChartBlock"
import { MetricView, TextView } from "./blocks"
import type { ViewContext } from "./types"

/** Content of a block that floats over grid cells (charts, metrics, text). Memoized: charts are expensive. */
export const OverlayContent = React.memo(function OverlayContent({
  block,
  ctx,
}: {
  block: ChartModel | MetricModel | TextModel
  ctx: ViewContext
}) {
  switch (block.type) {
    case "chart":
      return (
        <div className="flex h-full min-h-0 flex-col gap-1 p-3">
          <div data-drag-handle className="flex shrink-0 cursor-grab items-center gap-1.5 text-sm font-medium active:cursor-grabbing">
            <ChartBarIcon className="size-3.5 text-muted-foreground" />
            <span className="truncate">{block.title}</span>
          </div>
          <div className="min-h-0 flex-1">
            <ChartView chart={block} ctx={ctx} fill />
          </div>
        </div>
      )
    case "metric":
      return (
        <div data-drag-handle className="flex h-full cursor-grab flex-col justify-center px-3 active:cursor-grabbing">
          <MetricView metric={block} ctx={ctx} />
        </div>
      )
    case "text":
      return (
        <div data-drag-handle className={cn("h-full cursor-grab overflow-hidden px-2 py-1 active:cursor-grabbing")}>
          <TextView text={block} />
        </div>
      )
  }
})
