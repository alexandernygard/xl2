import Anthropic from "@anthropic-ai/sdk"
import { create } from "zustand"
import {
  SDK_REFERENCE,
  address,
  cellAt,
  cellLabel,
  isCellError,
  parseAddress,
  parseRange,
  rangeName,
  type CellValue,
  type EditIntent,
  type Literal,
  type StepOp,
  type WorkbookModel,
} from "@xl2/sdk"
import { selectionRect } from "@xl2/viz"
import { MAIN, takeReviewNotes, useStore, type ChatMessage, type ChatPart } from "./store"
import type { EvalResult } from "./evaluator"
import { tsDiagnostics } from "./tsClient"

// The assistant: a streaming tool-use loop that reads and edits the workbook
// source through the same SDK functions the UI uses.

const SYSTEM = `You are the assistant inside xl2, a spreadsheet where the workbook is a TypeScript file plus optional CSV
data files. The user mainly sees each sheet as an infinite grid: tables, params and free cells sit in cells; charts,
metrics and text float over cell ranges. Every change you make goes through your tools and shows up live.
Each user message carries the current code in <workbook_source>, a summary of data files in <data_files>, and the
user's selection and active sheet.

How to work:
- Answer questions about the data with read_values (computed results). Don't guess numbers. Read a range like "A1:H20"
  to see what's where on a sheet before placing new things.
- Change values with set_cells: table cells by {table, row, column}, or any grid cell by {sheet, address} (free cells
  accept "=..." formulas). Change structure, formulas, charts or layout with edit_code (exact string replacement on the
  code or a data file; keep edits small). Use write_code for new workbooks, large rewrites, or creating a data file.
- Give every new block an \`at\` that doesn't overlap existing blocks or cells (the tool result reports overlaps).
- Prefer formulas, queries and params over hard-coded computed numbers, so the sheet stays live.
- After editing, the tool result tells you whether the workbook still evaluates. If it reports errors, fix them.
- The user reviews your changes: each edit tool call is one item they accept or reject, and they see changed cells
  highlighted. Give every edit a short \`summary\` (e.g. "Add margin column"), and keep unrelated changes in separate
  calls so they can be judged on their own. Your changes are live in the workbook while they wait for review.
- Keep replies short: say what you changed or found. The user can see the sheet, so don't repeat the whole table.

${SDK_REFERENCE}`

const tools: Anthropic.Tool[] = [
  {
    name: "read_values",
    description:
      "Read evaluated values. With no input: an overview of every sheet (blocks with their grid ranges, metric values, params, free cells). With `table`: rows of that table or query, including computed columns. With `sheet` and `range` (e.g. \"A1:H20\"): the grid as rows of cells, showing values and the formulas of free cells.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table or query name" },
        offset: { type: "integer", description: "First row (0-based), with table" },
        limit: { type: "integer", description: "Max rows, default 200, with table" },
        sheet: { type: "string", description: "Sheet name, with range" },
        range: { type: "string", description: "A1 range on the sheet, at most 2000 cells" },
      },
    },
  },
  {
    name: "set_cells",
    description:
      "Set cell values. Each edit is either {table, row, column, value} for a table cell (rows 0-based; row = row count appends; a formula column gets an override), or {sheet, address, value} for a grid cell (free cells take literals or \"=...\" formulas; param value cells set the param). Values are string, number, boolean or null; percents are fractions (0.25 = 25%).",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A few words for the review list, e.g. \"Add margin column\"" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              table: { type: "string" },
              row: { type: "integer" },
              column: { type: "string" },
              sheet: { type: "string" },
              address: { type: "string" },
              value: { type: ["string", "number", "boolean", "null"] },
            },
            required: ["value"],
          },
        },
      },
      required: ["edits"],
    },
  },
  {
    name: "edit_code",
    description:
      "Replace one exact, unique occurrence of old_string with new_string in the workbook code, or in a data file when `file` names one (e.g. \"orders.csv\"). Include enough context to make old_string unique.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Data file name; omit for the workbook code" },
        summary: { type: "string", description: "A few words for the review list, e.g. \"Add margin column\"" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["old_string", "new_string"],
    },
  },
  {
    name: "write_code",
    description: "Replace the entire workbook code, or write a whole data file (creating it if needed) when `file` names one. Data files are CSV with a header line of column keys.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Data file name like \"sales.csv\"; omit for the workbook code" },
        summary: { type: "string", description: "A few words for the review list, e.g. \"Add margin column\"" },
        source: { type: "string", description: "The full file contents" },
      },
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

type ToolOutput = { content: string; isError?: boolean; summary: string; stepId?: string }

function evalReport(r: EvalResult): string {
  if (!r.ok) return `The workbook no longer runs: ${r.error.message}${r.error.line ? ` (line ${r.error.line})` : ""}. Fix it.`
  const model = r.model
  const problems: string[] = [...model.issues]
  for (const s of model.sheets) {
    for (const b of s.blocks) {
      if ("error" in b && b.error) problems.push(`${s.name} / ${"name" in b ? b.name : b.title}: ${b.error}`)
      if (b.type === "table") {
        b.rows.forEach((row, i) =>
          row.forEach((v, j) => {
            if (isCellError(v) && problems.length < 15) problems.push(`${b.name}[${i}].${b.columns[j].key}: ${v.error}`)
          }),
        )
      }
    }
    for (const [a, c] of Object.entries(s.cells)) if (isCellError(c.value) && problems.length < 15) problems.push(`${s.name}!${a}: ${c.value.error}`)
  }
  return problems.length ? `Evaluates, but with problems:\n- ${problems.join("\n- ")}` : "Workbook evaluates without errors."
}

/** The assistant message being written, so its edits are tied to it in the review list. */
let currentMessage: string | undefined

/** Apply an edit as a draft step for review, and report how the workbook evaluates afterwards. */
async function commit(op: StepOp, input: any, fallback: string): Promise<ToolOutput> {
  const label = typeof input?.summary === "string" && input.summary.trim() ? input.summary.trim() : fallback
  const before = useStore.getState().bundle().source
  const r = await useStore.getState().applyStep(op, "ai", label, currentMessage)
  if (!r.ok) return { content: r.error, isError: true, summary: label }
  const out: ToolOutput = { content: evalReport(r.result), summary: label, stepId: r.stepId }
  const source = useStore.getState().bundle().source
  if (source === before) return out
  // type errors often point at the real mistake before it shows up as a runtime error
  const types = (await tsDiagnostics(source))?.filter((d) => d.severity === "error") ?? []
  if (!types.length) return out
  const lineOf = (pos: number) => source.slice(0, pos).split("\n").length
  return { ...out, content: `${out.content}\nType errors:\n${types.slice(0, 8).map((d) => `- line ${lineOf(d.from)}: ${d.message}`).join("\n")}` }
}

const cellJson = (v: CellValue) => (isCellError(v) ? `#ERR: ${v.error}` : v)

function overview(model: WorkbookModel) {
  return model.sheets.map((s) => ({
    sheet: s.name,
    used: s.extent.rows ? rangeName({ row: 0, col: 0, rows: s.extent.rows, cols: s.extent.cols }) : null,
    blocks: s.blocks.map((b) => {
      const at = rangeName(b.rect)
      switch (b.type) {
        case "table":
          return { [b.source]: b.name, at, title: b.title, rows: b.rows.length, columns: b.columns.map((c) => c.key), dataFile: b.dataFile }
        case "metric":
          return { metric: b.title, at, value: cellJson(b.value) }
        case "param":
          return { param: b.name, at, value: b.value }
        case "chart":
          return { chart: b.title, at, kind: b.kind, points: b.data.length }
        case "text":
          return { text: b.content.slice(0, 80), at }
      }
    }),
    cells: Object.fromEntries(
      Object.entries(s.cells)
        .slice(0, 150)
        .map(([a, c]) => [a, c.formula ? { formula: c.formula, value: cellJson(c.value) } : cellJson(c.value)]),
    ),
  }))
}

function readRange(model: WorkbookModel, sheetName: string, range: string): ToolOutput {
  const sheet = model.sheets.find((s) => s.name === sheetName)
  if (!sheet) return { content: `No sheet named "${sheetName}"`, isError: true, summary: `Read ${range}` }
  const r = parseRange(range)
  if (!r) return { content: `"${range}" is not an A1 range`, isError: true, summary: `Read ${range}` }
  if (r.rows * r.cols > 2000) return { content: "Range too large (max 2000 cells)", isError: true, summary: `Read ${range}` }
  const rows: Record<string, unknown>[] = []
  for (let row = r.row; row < r.row + r.rows; row++) {
    const line: Record<string, unknown> = {}
    for (let col = r.col; col < r.col + r.cols; col++) {
      const info = cellAt(sheet, row, col)
      const a = address(row, col)
      if (info.kind === "empty") continue
      if (info.kind === "free") line[a] = info.cell.formula ? { formula: info.cell.formula, value: cellJson(info.cell.value) } : cellJson(info.cell.value)
      else if (info.kind === "table") line[a] = { [cellLabel(info)]: cellJson(info.value) }
      else if (info.kind === "param") line[a] = info.part === "label" ? info.param.label : { [`param ${info.param.name}`]: info.param.value }
      else line[a] = `(${info.block.type} "${"title" in info.block ? info.block.title : "text"}" over ${rangeName(info.block.rect)})`
    }
    if (Object.keys(line).length) rows.push(line)
  }
  return { content: JSON.stringify({ sheet: sheet.name, range: rangeName(r), cells: rows }), summary: `Read ${sheet.name}!${rangeName(r)}` }
}

const isLiteral = (v: unknown): v is Literal => v === null || ["string", "number", "boolean"].includes(typeof v)

/** A set_cells edit as intents. Table cells past the end become appended rows. */
function cellEdits(model: WorkbookModel | null, edits: any[]): EditIntent[] | string {
  const counts = new Map<string, number>()
  const intents: EditIntent[] = []
  const tables = model?.sheets.flatMap((s) => s.blocks) ?? []
  for (const e of edits) {
    if (!isLiteral(e?.value)) return "Each edit needs a literal value"
    if (typeof e.sheet === "string" && typeof e.address === "string") {
      const sheet = model?.sheets.find((s) => s.name === e.sheet)
      const p = parseAddress(e.address)
      if (!sheet || !p) return `Unknown cell ${e.sheet}!${e.address}`
      const info = cellAt(sheet, p.row, p.col)
      if (info.kind === "free" || info.kind === "empty") intents.push({ type: "setFreeCell", sheet: sheet.name, address: info.address, value: e.value })
      else if (info.kind === "param" && info.part === "value") intents.push({ type: "setParam", name: info.param.name, value: e.value })
      else if (info.kind === "table" && info.region.kind === "data" && info.column && info.table.source === "table")
        intents.push(
          info.column.computed
            ? { type: "setOverride", table: info.table.name, row: info.region.index, column: info.column.key, value: e.value }
            : { type: "setCell", table: info.table.name, row: info.region.index, column: info.column.key, value: e.value },
        )
      else return `${e.sheet}!${e.address} is ${cellLabel(info)}, which can't be set directly`
      continue
    }
    if (typeof e.table !== "string" || !Number.isInteger(e.row) || typeof e.column !== "string")
      return "Each edit needs {table, row, column, value} or {sheet, address, value}"
    const t = tables.find((b) => b.type === "table" && b.name === e.table)
    const count = counts.get(e.table) ?? (t?.type === "table" ? t.rows.length : 0)
    const computed = t?.type === "table" && t.columns.find((c) => c.key === e.column)?.computed
    if (e.row >= count) {
      for (let i = count; i < e.row; i++) intents.push({ type: "addRow", table: e.table })
      intents.push({ type: "addRow", table: e.table, values: { [e.column]: e.value } })
      counts.set(e.table, e.row + 1)
    } else {
      intents.push(
        computed
          ? { type: "setOverride", table: e.table, row: e.row, column: e.column, value: e.value }
          : { type: "setCell", table: e.table, row: e.row, column: e.column, value: e.value },
      )
      counts.set(e.table, count)
    }
  }
  return intents
}

async function runTool(name: string, input: any): Promise<ToolOutput> {
  const store = useStore.getState()
  const bundle = store.bundle()
  switch (name) {
    case "read_values": {
      const model = store.model
      if (!model) return { content: "The workbook doesn't evaluate right now.", isError: true, summary: "Read values" }
      if (typeof input?.range === "string") return readRange(model, String(input.sheet ?? model.sheets[store.activeSheet]?.name), input.range)
      if (!input?.table) return { content: JSON.stringify(overview(model)), summary: "Read workbook overview" }
      const t = model.sheets.flatMap((s) => s.blocks).find((b) => b.type === "table" && b.name === input.table)
      if (!t || t.type !== "table") return { content: `No table named "${input.table}"`, isError: true, summary: `Read ${input.table}` }
      const offset = Number(input.offset ?? 0)
      const limit = Number(input.limit ?? 200)
      const rows = t.rows.slice(offset, offset + limit).map((r) => Object.fromEntries(t.columns.map((c, i) => [c.key, cellJson(r[i])])))
      return {
        content: JSON.stringify({
          at: rangeName(t.rect),
          columns: t.columns.map((c) => ({ key: c.key, kind: c.kind, computed: c.computed })),
          total: t.rows.length,
          offset,
          rows,
          overridden: t.overridden,
        }),
        summary: `Read ${t.name} (${rows.length} rows)`,
      }
    }
    case "set_cells": {
      const edits = input?.edits
      if (!Array.isArray(edits) || !edits.length) return { content: "Invalid input: edits must be a non-empty array", isError: true, summary: "Set cells" }
      const intents = cellEdits(store.model, edits)
      if (typeof intents === "string") return { content: intents, isError: true, summary: "Set cells" }
      return commit({ kind: "intents", intents }, input, `Set ${edits.length} cell${edits.length === 1 ? "" : "s"}`)
    }
    case "edit_code": {
      if (typeof input?.old_string !== "string" || typeof input?.new_string !== "string")
        return { content: "Invalid input: old_string and new_string are required strings", isError: true, summary: "Edit code" }
      const file = typeof input.file === "string" && input.file !== MAIN ? input.file : null
      if (file && !(file in bundle.files)) return { content: `No data file "${file}". Use write_code to create it.`, isError: true, summary: `Edit ${file}` }
      const lines = input.new_string.split("\n").length
      return commit(
        { kind: "replace", file: file ?? MAIN, old: input.old_string, new: input.new_string },
        input,
        `Edited ${file ?? "code"} (${lines} line${lines === 1 ? "" : "s"})`,
      )
    }
    case "write_code": {
      if (typeof input?.source !== "string" || (!input.file && !input.source.trim()))
        return { content: "Invalid input: source is required", isError: true, summary: "Write code" }
      const file = typeof input.file === "string" && input.file !== MAIN ? input.file : null
      if (file && !/^[\w.-]+\.csv$/.test(file)) return { content: "Data file names must look like name.csv", isError: true, summary: `Write ${file}` }
      return commit({ kind: "write", file: file ?? MAIN, text: input.source }, input, `Wrote ${file ?? "workbook"} (${input.source.split("\n").length} lines)`)
    }
  }
  return { content: `Unknown tool ${name}`, isError: true, summary: name }
}

// --- the loop ----------------------------------------------------------------

/** What happened to Claude's earlier changes: rejections since the last message, and what still waits for review. */
function review(fileId: string): string {
  const lines = takeReviewNotes(fileId)
  const pending = useStore.getState().draft()?.steps.filter((s) => s.author === "ai" && s.status === "pending") ?? []
  if (pending.length) lines.push(`Still awaiting the user's review (applied in the code above): ${pending.map((s) => s.label).join("; ")}`)
  return lines.length ? `<review>\n${lines.join("\n")}\n</review>` : ""
}

export async function send(userText: string) {
  const store = useStore.getState()
  const fileId = store.activeId
  if (!store.apiKey) throw new Error("Add your Anthropic API key in settings first.")

  const client = new Anthropic({ apiKey: store.apiKey, dangerouslyAllowBrowser: true })
  const abort = new AbortController()
  const bundle = store.bundle()
  const sheet = store.model?.sheets[store.activeSheet]
  const sel = store.selection && sheet ? store.selection : null
  const selText = sel && sheet
    ? (() => {
        const info = cellAt(sheet, sel.focus.row, sel.focus.col)
        const range = rangeName(selectionRect(sel))
        return `<selection>${sheet.name}!${range}${info.kind !== "empty" && info.kind !== "free" ? ` (focus: ${cellLabel(info)})` : ""}</selection>`
      })()
    : ""
  const files = Object.entries(bundle.files).map(([f, text]) => {
    const lines = text.split("\n").filter(Boolean)
    return `${f}: ${Math.max(0, lines.length - 1)} rows\n${lines.slice(0, 4).join("\n")}${lines.length > 4 ? "\n…" : ""}`
  })
  const context = [
    `<workbook_source>\n${bundle.source}\n</workbook_source>`,
    files.length ? `<data_files>\n${files.join("\n\n")}\n</data_files>` : "",
    selText,
    sheet ? `<active_sheet>${sheet.name}</active_sheet>` : "",
    store.error ? `<current_error>${store.error.message}</current_error>` : "",
    review(fileId),
  ]
    .filter(Boolean)
    .join("\n")

  const assistantId = crypto.randomUUID()
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
        { id: assistantId, role: "assistant", parts: [] },
      ],
    },
  }))
  currentMessage = assistantId

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
          out = await runTool(u.name, u.input)
        } catch (e) {
          out = { content: String(e), isError: true, summary: u.name }
        }
        patchTool(fileId, u.id, { summary: out.summary, status: out.isError ? "error" : "ok", detail: out.content, stepId: out.stepId })
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
    currentMessage = undefined
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
