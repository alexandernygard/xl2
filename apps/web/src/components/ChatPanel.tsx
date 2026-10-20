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
  KeyRoundIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react"
import { cellAt, cellLabel, rangeName } from "@xl2/sdk"
import { selectionRect } from "@xl2/viz"
import { clearChat, send, stop, useChat } from "../ai"
import { useStore, type ChatPart } from "../store"

const NO_MESSAGES: never[] = []

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

export function ChatPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const fileId = useStore((s) => s.activeId)
  const apiKey = useStore((s) => s.apiKey)
  const selection = useStore((s) => s.selection)
  const sheet = useStore((s) => s.model?.sheets[s.activeSheet])
  const messages = useChat((s) => s.messages[fileId] ?? NO_MESSAGES)
  const running = useChat((s) => s.running)
  const [draft, setDraft] = React.useState("")

  const submit = (text = draft) => {
    if (!text.trim() || running) return
    if (!apiKey) {
      onOpenSettings()
      return
    }
    setDraft("")
    send(text.trim()).catch((e) => toast.error(String(e?.message ?? e)))
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
              Claude reads and edits the workbook code directly. Every change shows up in the sheet and the code, and you can undo it.
            </p>
            {!apiKey && (
              <Button variant="outline" size="sm" className="self-start" onClick={onOpenSettings}>
                <KeyRoundIcon /> Add your API key
              </Button>
            )}
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-auto rounded-full py-1 text-left whitespace-normal" onClick={() => submit(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <MessageScrollerProvider>
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-4 p-3">
                  {messages.map((m, i) => {
                    const last = i === messages.length - 1
                    return (
                      <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                        <Message align={m.role === "user" ? "end" : "start"}>
                          <MessageContent>
                            {m.parts.map((p, j) => (
                              <Part key={j} part={p} user={m.role === "user"} />
                            ))}
                            {m.role === "assistant" && last && running && <Working parts={m.parts} />}
                            {m.error && (
                              <div className="flex items-start gap-2 text-sm text-destructive">
                                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                                {m.error}
                              </div>
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  })}
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
            placeholder="Ask or tell Claude to change something"
            className="max-h-40 min-h-12"
            aria-label="Message"
          />
          <InputGroupAddon align="block-end">
            {running ? (
              <InputGroupButton type="button" size="icon-xs" variant="default" className="ml-auto rounded-full" aria-label="Stop" onClick={stop}>
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

function Working({ parts }: { parts: ChatPart[] }) {
  const tail = parts[parts.length - 1]
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

function Part({ part, user }: { part: ChatPart; user: boolean }) {
  if (part.type === "text") {
    if (!part.text) return null
    return (
      <Bubble variant={user ? "default" : "ghost"}>
        <BubbleContent className="whitespace-pre-wrap">{part.text}</BubbleContent>
      </Bubble>
    )
  }
  if (part.type === "thinking") {
    return (
      <details className="group text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <BrainIcon className="size-3.5" /> Thought
        </summary>
        <p className="mt-1 border-l pl-3 whitespace-pre-wrap">{part.text}</p>
      </details>
    )
  }
  const Icon = TOOL_ICON[part.name] ?? CodeIcon
  return (
    <Trace>
      <TraceLine title={part.detail}>
        <TraceIcon>{part.status === "running" ? <Spinner /> : <Icon />}</TraceIcon>
        <TraceTitle className={cn(part.status === "error" && "text-destructive")}>{part.summary}</TraceTitle>
        {part.status === "error" && <TraceDescription>failed</TraceDescription>}
        {part.status === "ok" && part.detail?.startsWith("Evaluates, but") && <TraceDescription className="text-warning">errors</TraceDescription>}
      </TraceLine>
    </Trace>
  )
}
