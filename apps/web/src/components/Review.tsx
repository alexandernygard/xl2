import * as React from "react"
import { Button, cn } from "@alexandernygard/components"
import { ArrowRightIcon, CheckIcon, GitCompareArrowsIcon, TriangleAlertIcon, Undo2Icon, XIcon } from "lucide-react"
import { diffModels, type WorkbookDiff } from "@xl2/sdk"
import { useStore, type DraftStep } from "../store"

// Reviewing Claude's changes: they're applied as a draft, highlighted in the
// grid, and accepted or rejected per tool call (in the chat) or all at once.

const NO_STEPS: DraftStep[] = []

export function useDraftSteps(): DraftStep[] {
  return useStore((s) => s.files[s.activeId]?.draft?.steps ?? NO_STEPS)
}

/** Current model against the draft's base, while a draft is open. */
export function useDiff(): WorkbookDiff | null {
  const base = useStore((s) => s.baseModel)
  const model = useStore((s) => s.model)
  const open = useStore((s) => !!s.files[s.activeId]?.draft)
  return React.useMemo(() => (open && base && model ? diffModels(base, model) : null), [open, base, model])
}

/** Accept/reject controls on a tool call in the chat. */
export function StepControls({ stepId }: { stepId: string }) {
  const steps = useDraftSteps()
  const step = steps.find((s) => s.id === stepId)
  const conflict = useStore((s) => s.conflicts[stepId])
  const decided = useStore((s) => s.decided[stepId])
  const { reviewStep, goTo } = useStore.getState()

  if (!step) {
    if (!decided) return null
    return (
      <span className={cn("ml-auto shrink-0 text-xs", decided === "accepted" ? "text-muted-foreground" : "text-destructive")}>
        {decided === "accepted" ? "Accepted" : decided === "rejected" ? "Rejected" : "Dropped"}
      </span>
    )
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {conflict ? (
        <span className="flex items-center gap-1 text-xs text-warning" title={`Depends on a change you rejected: ${conflict}`}>
          <TriangleAlertIcon className="size-3.5" /> Can't apply
        </span>
      ) : step.focus && step.status !== "rejected" ? (
        <Button size="icon-xs" variant="ghost" aria-label="Show in grid" title={`Show ${step.focus.sheet}!${step.focus.address}`} onClick={() => goTo(step.focus!.sheet, step.focus!.address)}>
          <ArrowRightIcon />
        </Button>
      ) : null}
      {step.status === "pending" ? (
        <>
          <Button size="icon-xs" variant="ghost" aria-label="Reject change" title="Reject" onClick={() => reviewStep(step.id, "rejected")}>
            <XIcon />
          </Button>
          {!conflict && (
            <Button size="icon-xs" variant="ghost" aria-label="Accept change" title="Accept" onClick={() => reviewStep(step.id, "accepted")}>
              <CheckIcon />
            </Button>
          )}
        </>
      ) : (
        <>
          <span className={cn("text-xs", step.status === "rejected" ? "text-destructive" : "text-muted-foreground")}>
            {step.status === "rejected" ? "Rejected" : "Accepted"}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label="Undo decision" title="Back to pending" onClick={() => reviewStep(step.id, "pending")}>
            <Undo2Icon />
          </Button>
        </>
      )}
    </span>
  )
}

function pendingCount(steps: DraftStep[]) {
  return steps.filter((s) => s.author === "ai" && s.status === "pending").length
}

/** Above the chat input while changes wait for review. */
export function ChatReviewBar({ disabled }: { disabled?: boolean }) {
  const steps = useDraftSteps()
  const n = pendingCount(steps)
  if (!n) return null
  const { acceptAll, rejectAll } = useStore.getState()
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-highlight/15 px-2.5 py-1.5 text-xs">
      <GitCompareArrowsIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {n} change{n === 1 ? "" : "s"} to review
      </span>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={rejectAll}>
        Reject all
      </Button>
      <Button size="xs" disabled={disabled} onClick={acceptAll}>
        Accept all
      </Button>
    </div>
  )
}

/** Above the grid: what's being reviewed, the numbers that moved, and accept/reject for everything. */
export function ReviewBar({ diff }: { diff: WorkbookDiff | null }) {
  const steps = useDraftSteps()
  const n = pendingCount(steps)
  if (!steps.length) return null
  const { acceptAll, rejectAll } = useStore.getState()
  const mine = steps.filter((s) => s.author === "user").length
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-highlight/10 px-3 py-1.5 text-xs">
      <span className="flex items-center gap-1.5 font-medium">
        <GitCompareArrowsIcon className="size-3.5" />
        {n ? `Reviewing ${n} change${n === 1 ? "" : "s"} from Claude` : "Changes from Claude"}
      </span>
      <Legend />
      {diff?.impact.map((i) => (
        <span key={i.label} className="flex items-center gap-1 tabular-nums">
          <span className="text-muted-foreground">{i.label}</span>
          <span className="text-muted-foreground line-through">{i.before}</span>
          <ArrowRightIcon className="size-3 text-muted-foreground" />
          <span className="font-medium">{i.after}</span>
        </span>
      ))}
      {diff && diff.notes.length > 0 && (
        <span className="truncate text-muted-foreground" title={diff.notes.join("\n")}>
          {diff.notes.slice(0, 2).join(" · ")}
          {diff.notes.length > 2 ? ` · +${diff.notes.length - 2} more` : ""}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        {mine > 0 && <span className="mr-1 text-muted-foreground">Your {mine} edit{mine === 1 ? "" : "s"} stay either way</span>}
        <Button size="xs" variant="ghost" onClick={rejectAll}>
          Reject all
        </Button>
        <Button size="xs" onClick={acceptAll}>
          Accept all
        </Button>
      </span>
    </div>
  )
}

function Legend() {
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="size-2.5 rounded-[2px] bg-highlight/50 ring-1 ring-highlight" /> changed
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2.5 rounded-[2px] bg-positive/25 ring-1 ring-positive/60" /> added
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2.5 rounded-[2px] bg-info/15 ring-1 ring-info/40" /> recalculated
      </span>
    </span>
  )
}
