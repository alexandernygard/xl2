import { create } from "zustand"
import { Chat, httpTransport, type ClientToolHandler } from "@alexandernygard/ai-kit-react"
import {
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
import { MAIN, takeReviewNotes, useStore } from "./store"
import { fetchWithRefresh } from "./auth/browser"
import type { EvalResult } from "./evaluator"
import { tsDiagnostics } from "./tsClient"

// The assistant runs in the Worker (apps/worker/src/assistant.ts) with the app's Claude key. Its tools
// read and edit the workbook, which lives here, so they run in the page as ai-kit client tools, through
// the same SDK functions the UI uses.

export const transport = httpTransport({ baseUrl: "/api/ai", fetch: (input, init) => fetchWithRefresh(input, init) })

// --- conversations: one ai-kit Chat per workbook (not persisted) -------------
// Kept outside React, so a run carries on when the panel closes or the layout changes.

const chats = new Map<string, Chat>()

/** Bumped when a conversation is cleared, so the panel picks up the new Chat. */
export const useChats = create<{ version: number }>(() => ({ version: 0 }))

export function chatFor(fileId: string): Chat {
  let chat = chats.get(fileId)
  if (!chat) {
    chat = new Chat({ transport, newSession: { agent: "xl2" }, clientTools })
    chats.set(fileId, chat)
  }
  return chat
}

export function clearChat(fileId: string) {
  void chats.get(fileId)?.stop()
  chats.delete(fileId)
  useChats.setState((s) => ({ version: s.version + 1 }))
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

export function setCurrentMessage(id: string | undefined) {
  currentMessage = id
}

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

// --- what the agent gets ----------------------------------------------------

/** What happened to Claude's earlier changes: rejections since the last message, and what still waits for review. */
function review(fileId: string): string {
  const lines = takeReviewNotes(fileId)
  const pending = useStore.getState().draft()?.steps.filter((s) => s.author === "ai" && s.status === "pending") ?? []
  if (pending.length) lines.push(`Still awaiting the user's review (applied in the code above): ${pending.map((s) => s.label).join("; ")}`)
  return lines.length ? `<review>\n${lines.join("\n")}\n</review>` : ""
}

/** The workbook as the agent sees it with each message. Sent as clientContext; the Worker adds it to the turn. */
export function workbookContext(): { workbook: string } {
  const store = useStore.getState()
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
  const workbook = [
    `<workbook_source>\n${bundle.source}\n</workbook_source>`,
    files.length ? `<data_files>\n${files.join("\n\n")}\n</data_files>` : "",
    selText,
    sheet ? `<active_sheet>${sheet.name}</active_sheet>` : "",
    store.error ? `<current_error>${store.error.message}</current_error>` : "",
    review(store.activeId),
  ]
    .filter(Boolean)
    .join("\n")
  return { workbook }
}

/** What a tool sends back: the model reads `content`; the chat shows `summary` and review controls for `stepId`. */
export type ToolResult = { content: string; summary: string; stepId?: string }

/** The agent's tools, run in the page. A thrown error goes back to the model as a failed call. */
export const clientTools: Record<string, ClientToolHandler> = Object.fromEntries(
  ["read_values", "set_cells", "edit_code", "write_code"].map((name) => [
    name,
    async (input: unknown): Promise<ToolResult> => {
      const out = await runTool(name, input)
      if (out.isError) throw new Error(out.content)
      return { content: out.content, summary: out.summary, stepId: out.stepId }
    },
  ]),
)
