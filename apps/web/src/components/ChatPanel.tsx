import * as React from "react"
import {
  Bubble,
  BubbleContent,
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Marker,
  MarkerContent,
  MarkerIcon,
  Message,
  MessageContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Spinner,
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  cn,
  toast,
} from "@alexandernygard/components"
import {
  ArrowUpIcon,
  BrainIcon,
  CircleAlertIcon,
  CodeIcon,
  EraserIcon,
  LogInIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react"
import { cellAt, cellLabel, rangeName } from "@xl2/sdk"
import { selectionRect } from "@xl2/viz"
import type { Message as AiMessage, ToolPart } from "@alexandernygard/ai-kit"
import { chatFor, clearChat, setCurrentMessage, useChats, workbookContext, type ToolResult } from "../ai"
import { useAccount } from "../account"
import { useStore } from "../store"
import { ChatReviewBar, StepControls } from "./Review"

const SUGGESTIONS = [
  "Add a column for profit margin",
  "Which region grew most in the forecast?",
  "Put a line chart of revenue per rep next to the table",
  "Add a small summary block of totals in free cells",
]

const TOOL_ICON: Record<string, React.ComponentType> = {
  read_values: SearchIcon,
  set_cells: PencilIcon,
  edit_code: CodeIcon,
  write_code: CodeIcon,
}

export function ChatPanel() {
  const fileId = useStore((s) => s.activeId)
  const version = useChats((s) => s.version)
  const chat = React.useMemo(() => chatFor(fileId), [fileId, version])
  const state = React.useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const selection = useStore((s) => s.selection)
  const sheet = useStore((s) => s.model?.sheets[s.activeSheet])
  const account = useAccount()
  const messages = state.path
  const running = state.status === "submitted" || state.status === "streaming"
  // Today's spend changes after each answer.
  const { reload } = account
  React.useEffect(() => {
    if (!running) reload()
  }, [running, reload])
  const [draft, setDraft] = React.useState("")

  // Edits are tied to the assistant message that made them, for the review list.
  const last = messages[messages.length - 1]
  React.useEffect(() => setCurrentMessage(running && last?.role === "assistant" ? last.id : undefined), [running, last?.id, last?.role])

  const signedOut = account.state.status === "signed-out"
  const submit = (text = draft) => {
    if (!text.trim() || running) return
    if (account.state.status === "signed-out") {
      location.href = account.state.loginUrl
      return
    }
    setDraft("")
    chat.send(text.trim(), { context: workbookContext() }).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <SparklesIcon className="size-4 text-muted-foreground" />
        <span className="font-heading text-sm">Assistant</span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Clear conversation"
          disabled={running || !messages.length}
          onClick={() => clearChat(fileId)}
        >
          <EraserIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-3 p-4">
            <p className="font-heading text-xl">What should this workbook do?</p>
            <p className="text-sm text-muted-foreground">
              Claude reads and edits the workbook code directly. Its changes show up highlighted in the sheet, and you accept or reject each one.
            </p>
            {account.state.status === "signed-out" ? (
              <Button variant="outline" size="sm" className="self-start" asChild>
                <a href={account.state.loginUrl}>
                  <LogInIcon /> Sign in to use the assistant
                </a>
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="outline" size="sm" className="h-auto max-w-full rounded-full py-1 text-left whitespace-normal" onClick={() => submit(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <MessageScrollerProvider>
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-4 p-3">
                  {messages.map((m, i) => {
                    const isLast = i === messages.length - 1
                    return (
                      <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                        <Message align={m.role === "user" ? "end" : "start"}>
                          <MessageContent>
                            {m.parts.map((p, j) => (
                              <Part key={j} part={p} user={m.role === "user"} />
                            ))}
                            {m.role === "assistant" && isLast && running && <Working message={m} />}
                            {isLast && state.error && (
                              <div className="flex items-start gap-2 text-sm text-destructive">
                                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                                {state.error}
                              </div>
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  })}
                  {running && last?.role === "user" && (
                    <MessageScrollerItem messageId="working">
                      <Working />
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>

      <form
        className="shrink-0 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <ChatReviewBar />
        {selection && sheet && (
          <p className="mb-1.5 truncate text-xs text-muted-foreground">
            Context:{" "}
            <code>
              {sheet.name}!{rangeName(selectionRect(selection))}
              {(() => {
                const info = cellAt(sheet, selection.focus.row, selection.focus.col)
                return info.kind === "empty" || info.kind === "free" ? "" : ` · ${cellLabel(info)}`
              })()}
            </code>
          </p>
        )}
        <InputGroup>
          <InputGroupTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={signedOut ? "Sign in to use the assistant" : "Ask or tell Claude to change something"}
            className="max-h-40 min-h-12"
            aria-label="Message"
          />
          <InputGroupAddon align="block-end">
            {account.state.status === "signed-in" && account.state.limitUsd > 0 && (
              <span className="text-xs text-muted-foreground" title="Today's assistant use. It resets at midnight UTC.">
                ${account.state.spentUsd.toFixed(2)} / ${account.state.limitUsd.toFixed(2)} today
              </span>
            )}
            {running ? (
              <InputGroupButton type="button" size="icon-xs" variant="default" className="ml-auto rounded-full" aria-label="Stop" onClick={() => void chat.stop()}>
                <SquareIcon className="fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-xs" variant="default" className="ml-auto rounded-full" aria-label="Send" disabled={!draft.trim()}>
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}

function Working({ message }: { message?: AiMessage }) {
  const tail = message?.parts[message.parts.length - 1]
  if (tail?.type === "text" && tail.text) return null
  return (
    <Marker role="status">
      <MarkerIcon>
        <Spinner />
      </MarkerIcon>
      <MarkerContent className="shimmer">{tail?.type === "tool" ? "Working" : "Thinking"}</MarkerContent>
    </Marker>
  )
}

function Part({ part, user }: { part: AiMessage["parts"][number]; user: boolean }) {
  if (part.type === "text") {
    if (!part.text) return null
    return (
      <Bubble variant={user ? "default" : "ghost"}>
        <BubbleContent className="whitespace-pre-wrap">{part.text}</BubbleContent>
      </Bubble>
    )
  }
  if (part.type === "reasoning") {
    if (!part.text.trim()) return null
    return (
      <details className="group text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <BrainIcon className="size-3.5" /> Thought
        </summary>
        <p className="mt-1 border-l pl-3 whitespace-pre-wrap">{part.text}</p>
      </details>
    )
  }
  if (part.type === "tool") return <ToolLine part={part} />
  return null
}

const DEFAULT_SUMMARY: Record<string, string> = { read_values: "Read values", set_cells: "Set cells", edit_code: "Edit code", write_code: "Write code" }

function ToolLine({ part }: { part: ToolPart }) {
  const out = part.state === "output-available" ? (part.output as ToolResult | undefined) : undefined
  const input = part.input as { summary?: unknown } | undefined
  const summary = out?.summary ?? (typeof input?.summary === "string" && input.summary) ?? DEFAULT_SUMMARY[part.toolName] ?? part.toolName
  const status = part.state === "output-error" || part.state === "denied" ? "error" : out ? "ok" : "running"
  const detail = status === "error" ? part.error : out?.content
  const Icon = TOOL_ICON[part.toolName] ?? CodeIcon
  return (
    <Trace>
      <TraceLine title={detail} className={cn(out?.stepId && "w-full")}>
        <TraceIcon>{status === "running" ? <Spinner /> : <Icon />}</TraceIcon>
        <TraceTitle className={cn(status === "error" && "text-destructive")}>{summary}</TraceTitle>
        {status === "error" && <TraceDescription>failed</TraceDescription>}
        {status === "ok" && detail?.startsWith("Evaluates, but") && <TraceDescription className="text-warning">errors</TraceDescription>}
        {out?.stepId && <StepControls stepId={out.stepId} />}
      </TraceLine>
    </Trace>
  )
}
