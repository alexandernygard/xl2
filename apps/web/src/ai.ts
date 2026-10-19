import Anthropic from "@anthropic-ai/sdk"
import { create } from "zustand"
import {
  SDK_REFERENCE,
  applyIntents,
  isCellError,
  replaceOnce,
  run,
  type EditIntent,
  type Literal,
  type WorkbookModel,
} from "@xl2/sdk"
import { useStore, type ChatMessage, type ChatPart } from "./store"

// The assistant: a streaming tool-use loop that reads and edits the workbook
// source through the same SDK functions the UI uses.

const SYSTEM = `You are the assistant inside xl2, a spreadsheet where the workbook is a TypeScript file.
The user sees the evaluated workbook (sheets, tables, charts) and the code side by side. Every change you make goes
through your tools and shows up live. The current source is attached to each user message in <workbook_source>.

How to work:
- Answer questions about the data with read_values (it returns computed formula results). Don't guess numbers.
- Change plain cell values with set_cells. Change structure, formulas, charts or anything else with edit_code
  (exact string replacement, keep edits small). Use write_code only for new workbooks or large rewrites.
- Prefer formulas, queries and params over hard-coded computed numbers, so the sheet stays live.
- After editing, the tool result tells you whether the workbook still evaluates. If it reports errors, fix them.
- Keep replies short: say what you changed or found. The user can see the sheet, so don't repeat the whole table.

${SDK_REFERENCE}`

const tools: Anthropic.Tool[] = [
  {
    name: "read_values",
    description:
      "Read evaluated values from the workbook. Without `table`, returns an overview of every sheet and block (metric values, row counts, params). With `table`, returns rows of that table or query, including computed formula columns.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table or query name" },
        offset: { type: "integer", description: "First row (0-based)" },
        limit: { type: "integer", description: "Max rows, default 200" },
      },
    },
  },
  {
    name: "set_cells",
    description:
      "Set literal cell values in tables (not formula columns). Rows are 0-based. Use row = current row count to append. Values must be string, number, boolean or null; percent columns are fractions (0.25 = 25%).",
    input_schema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              table: { type: "string" },
              row: { type: "integer" },
              column: { type: "string" },
              value: { type: ["string", "number", "boolean", "null"] },
            },
            required: ["table", "row", "column", "value"],
          },
        },
      },
      required: ["edits"],
    },
  },
  {
    name: "edit_code",
    description:
      "Replace one exact, unique occurrence of old_string in the workbook source with new_string. Include enough context to make old_string unique.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["old_string", "new_string"],
    },
  },
  {
    name: "write_code",
    description: "Replace the entire workbook source.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
    },
  },
]

// --- chat state (per file, not persisted) -----------------------------------

interface ChatState {
  messages: Record<string, ChatMessage[]>
  transcripts: Record<string, Anthropic.Beta.BetaMessageParam[]>
  running: boolean
  abort: AbortController | null
}

export const useChat = create<ChatState>(() => ({ messages: {}, transcripts: {}, running: false, abort: null }))

function updateLast(fileId: string, fn: (m: ChatMessage) => ChatMessage) {
  useChat.setState((s) => {
    const list = [...(s.messages[fileId] ?? [])]
    list[list.length - 1] = fn(list[list.length - 1])
    return { messages: { ...s.messages, [fileId]: list } }
  })
}

function pushPart(fileId: string, part: ChatPart) {
  updateLast(fileId, (m) => ({ ...m, parts: [...m.parts, part] }))
}

function patchTool(fileId: string, id: string, patch: Partial<Extract<ChatPart, { type: "tool" }>>) {
  updateLast(fileId, (m) => ({
    ...m,
    parts: m.parts.map((p) => (p.type === "tool" && p.id === id ? { ...p, ...patch } : p)),
  }))
}

// --- tools -------------------------------------------------------------------

type ToolOutput = { content: string; isError?: boolean; summary: string }

function evalReport(model: WorkbookModel | null, error: string | null): string {
  if (error) return `The workbook no longer runs: ${error}. Fix it.`
  if (!model) return ""
  const problems: string[] = [...model.issues]
  for (const s of model.sheets) {
    for (const b of s.blocks) {
      if ("error" in b && b.error) problems.push(`${s.name} / ${"name" in b ? b.name : b.title}: ${b.error}`)
      if (b.type === "table") {
        b.rows.forEach((r, i) =>
          r.forEach((v, j) => {
            if (isCellError(v) && problems.length < 12) problems.push(`${b.name}[${i}].${b.columns[j].key}: ${v.error}`)
          }),
        )
      }
    }
  }
  return problems.length ? `Evaluates, but with errors:\n- ${problems.join("\n- ")}` : "Workbook evaluates without errors."
}

function commit(source: string): string {
  useStore.getState().setSource(source, "ai")
  const r = run(source)
  return r.ok ? evalReport(r.model, null) : evalReport(null, r.error.message)
}

function overview(model: WorkbookModel) {
  return model.sheets.map((s) => ({
    sheet: s.name,
    blocks: s.blocks.map((b) => {
      switch (b.type) {
        case "table":
          return { [b.source]: b.name, title: b.title, rows: b.rows.length, columns: b.columns.map((c) => c.key) }
        case "metric":
          return { metric: b.title, value: b.value }
        case "param":
          return { param: b.name, value: b.value }
        case "chart":
          return { chart: b.title, kind: b.kind, points: b.data.length }
        case "text":
          return { text: b.content.slice(0, 80) }
      }
    }),
  }))
}

const isLiteral = (v: unknown): v is Literal => v === null || ["string", "number", "boolean"].includes(typeof v)

function runTool(name: string, input: any): ToolOutput {
  const store = useStore.getState()
  switch (name) {
    case "read_values": {
      const model = store.model
      if (!model) return { content: "The workbook doesn't evaluate right now.", isError: true, summary: "Read values" }
      if (!input?.table) return { content: JSON.stringify(overview(model)), summary: "Read workbook overview" }
      const t = model.sheets.flatMap((s) => s.blocks).find((b) => b.type === "table" && b.name === input.table)
      if (!t || t.type !== "table") return { content: `No table named "${input.table}"`, isError: true, summary: `Read ${input.table}` }
      const offset = Number(input.offset ?? 0)
      const limit = Number(input.limit ?? 200)
      const rows = t.rows.slice(offset, offset + limit).map((r) => Object.fromEntries(t.columns.map((c, i) => [c.key, r[i]])))
      return {
        content: JSON.stringify({ columns: t.columns.map((c) => ({ key: c.key, kind: c.kind, computed: c.computed })), total: t.rows.length, offset, rows }),
        summary: `Read ${t.name} (${rows.length} rows)`,
      }
    }
    case "set_cells": {
      const edits = input?.edits
      if (!Array.isArray(edits) || !edits.every((e) => typeof e?.table === "string" && Number.isInteger(e?.row) && typeof e?.column === "string" && isLiteral(e?.value)))
        return { content: "Invalid input: edits must be [{table, row, column, value}]", isError: true, summary: "Set cells" }
      // appends: rows at the end become addRow intents
      const counts = new Map<string, number>()
      const intents: EditIntent[] = []
      for (const e of edits) {
        const t = store.model?.sheets.flatMap((s) => s.blocks).find((b) => b.type === "table" && b.name === e.table)
        const count = counts.get(e.table) ?? (t && t.type === "table" ? t.rows.length : 0)
        if (e.row >= count) {
          for (let i = count; i < e.row; i++) intents.push({ type: "addRow", table: e.table })
          intents.push({ type: "addRow", table: e.table, values: { [e.column]: e.value } })
          counts.set(e.table, e.row + 1)
        } else {
          intents.push({ type: "setCell", table: e.table, row: e.row, column: e.column, value: e.value })
          counts.set(e.table, count)
        }
      }
      const r = applyIntents(store.source(), intents)
      if (!r.ok) return { content: r.error, isError: true, summary: `Set ${edits.length} cells` }
      return { content: commit(r.source), summary: `Set ${edits.length} cell${edits.length === 1 ? "" : "s"}` }
    }
    case "edit_code": {
      if (typeof input?.old_string !== "string" || typeof input?.new_string !== "string")
        return { content: "Invalid input: old_string and new_string are required strings", isError: true, summary: "Edit code" }
      const r = replaceOnce(store.source(), input.old_string, input.new_string)
      if (!r.ok) return { content: r.error, isError: true, summary: "Edit code" }
      const lines = input.new_string.split("\n").length
      return { content: commit(r.source), summary: `Edited code (${lines} line${lines === 1 ? "" : "s"})` }
    }
    case "write_code": {
      if (typeof input?.source !== "string" || !input.source.trim())
        return { content: "Invalid input: source is required", isError: true, summary: "Write code" }
      return { content: commit(input.source), summary: `Wrote workbook (${input.source.split("\n").length} lines)` }
    }
  }
  return { content: `Unknown tool ${name}`, isError: true, summary: name }
}

// --- the loop ----------------------------------------------------------------

export async function send(userText: string) {
  const store = useStore.getState()
  const fileId = store.activeId
  if (!store.apiKey) throw new Error("Add your Anthropic API key in settings first.")

  const client = new Anthropic({ apiKey: store.apiKey, dangerouslyAllowBrowser: true })
  const abort = new AbortController()
  const sel = store.selection
  const context = [
    `<workbook_source>\n${store.source()}\n</workbook_source>`,
    sel ? `<selection>table "${sel.table}", row ${sel.row} (0-based), column "${sel.column}"</selection>` : "",
    store.model ? `<active_sheet>${store.model.sheets[store.activeSheet]?.name}</active_sheet>` : "",
    store.error ? `<current_error>${store.error.message}</current_error>` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const transcript = [
    ...(useChat.getState().transcripts[fileId] ?? []),
    { role: "user" as const, content: [{ type: "text" as const, text: `${context}\n\n${userText}` }] },
  ]

  useChat.setState((s) => ({
    running: true,
    abort,
    messages: {
      ...s.messages,
      [fileId]: [
        ...(s.messages[fileId] ?? []),
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: userText }] },
        { id: crypto.randomUUID(), role: "assistant", parts: [] },
      ],
    },
  }))

  const save = () => useChat.setState((s) => ({ transcripts: { ...s.transcripts, [fileId]: [...transcript] } }))

  try {
    for (let turn = 0; turn < 25; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: useStore.getState().aiModel,
          max_tokens: 32000,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          cache_control: { type: "ephemeral" },
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          tools,
          messages: transcript,
        } as Anthropic.Beta.MessageCreateParamsStreaming,
        { signal: abort.signal },
      )

      // stream text and thinking summaries into the last assistant message
      let mode: "text" | "thinking" | null = null
      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start") {
          const t = ev.content_block.type
          mode = t === "text" ? "text" : t === "thinking" ? "thinking" : null
          if (mode) pushPart(fileId, { type: mode, text: "" })
        } else if (ev.type === "content_block_delta" && mode) {
          const d = ev.delta
          const chunk = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : ""
          if (chunk)
            updateLast(fileId, (m) => {
              const parts = [...m.parts]
              const last = parts[parts.length - 1]
              if (last && (last.type === "text" || last.type === "thinking")) parts[parts.length - 1] = { ...last, text: last.text + chunk }
              return { ...m, parts }
            })
        }
      })

      const message = await stream.finalMessage()
      // drop empty thinking placeholders (thinking can be omitted)
      updateLast(fileId, (m) => ({ ...m, parts: m.parts.filter((p) => !(p.type === "thinking" && !p.text.trim())) }))

      transcript.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] })

      if (message.stop_reason === "refusal") {
        updateLast(fileId, (m) => ({ ...m, error: "Claude declined this request." }))
        break
      }
      if (message.stop_reason === "pause_turn") continue
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      if (!uses.length) break
      if (message.stop_reason === "max_tokens") {
        transcript.pop() // a truncated tool call must not run, and can't stay in the transcript unanswered
        updateLast(fileId, (m) => ({ ...m, error: "The response was cut off (max tokens). Try a smaller request." }))
        break
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const u of uses) {
        pushPart(fileId, { type: "tool", id: u.id, name: u.name, summary: u.name, status: "running" })
        let out: ToolOutput
        try {
          out = runTool(u.name, u.input)
        } catch (e) {
          out = { content: String(e), isError: true, summary: u.name }
        }
        patchTool(fileId, u.id, { summary: out.summary, status: out.isError ? "error" : "ok", detail: out.content })
        results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.isError })
      }
      transcript.push({ role: "user", content: results })
    }
    save()
  } catch (e) {
    const aborted = abort.signal.aborted
    // keep the transcript valid: drop a trailing assistant turn whose tools never got results
    const last = transcript[transcript.length - 1]
    if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) transcript.pop()
    save()
    updateLast(fileId, (m) => ({ ...m, error: aborted ? "Stopped." : errorMessage(e) }))
  } finally {
    useChat.setState({ running: false, abort: null })
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it in settings."
  if (e instanceof Anthropic.RateLimitError) return "Rate limited. Wait a moment and try again."
  if (e instanceof Anthropic.APIError) return `${e.status ?? ""} ${e.message}`.trim()
  return e instanceof Error ? e.message : String(e)
}

export function stop() {
  useChat.getState().abort?.abort()
}

export function clearChat(fileId: string) {
  useChat.setState((s) => ({ messages: { ...s.messages, [fileId]: [] }, transcripts: { ...s.transcripts, [fileId]: [] } }))
}
