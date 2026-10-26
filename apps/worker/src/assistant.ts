import { createKit, defineAgent, defineContext, jsonSchema, sqlStore, tool, type Kit } from "@alexandernygard/ai-kit"
import { claude } from "@alexandernygard/ai-kit-anthropic"
import { SDK_REFERENCE } from "@xl2/sdk/reference"
import type { User } from "./auth/auth"
import type { Meter } from "./auth/usage"

// The assistant runs here, with the app's own Claude key. Its tools edit the workbook, which lives in the
// browser, so they're client tools: declared here without `execute`, run by the chat panel (apps/web/src/ai.ts),
// which sends back { content, summary, stepId }. The model sees only `content`.

export const MODEL = "claude-haiku-5-5"

export interface Context {
  user: User
}

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

/** What the browser's tools send back. */
interface ToolOutput {
  content: string
  summary?: string
  stepId?: string
}

const toModelOutput = (o: ToolOutput) => (typeof o?.content === "string" ? o.content : JSON.stringify(o))
const summary = { type: "string", description: 'A few words for the review list, e.g. "Add margin column"' }

const tools = [
  tool({
    name: "read_values",
    description:
      'Read evaluated values. With no input: an overview of every sheet (blocks with their grid ranges, metric values, params, free cells). With `table`: rows of that table or query, including computed columns. With `sheet` and `range` (e.g. "A1:H20"): the grid as rows of cells, showing values and the formulas of free cells.',
    readOnly: true,
    input: jsonSchema({
      type: "object",
      properties: {
        table: { type: "string", description: "Table or query name" },
        offset: { type: "integer", description: "First row (0-based), with table" },
        limit: { type: "integer", description: "Max rows, default 200, with table" },
        sheet: { type: "string", description: "Sheet name, with range" },
        range: { type: "string", description: "A1 range on the sheet, at most 2000 cells" },
      },
    }),
    toModelOutput,
  }),
  tool({
    name: "set_cells",
    description:
      'Set cell values. Each edit is either {table, row, column, value} for a table cell (rows 0-based; row = row count appends; a formula column gets an override), or {sheet, address, value} for a grid cell (free cells take literals or "=..." formulas; param value cells set the param). Values are string, number, boolean or null; percents are fractions (0.25 = 25%).',
    input: jsonSchema({
      type: "object",
      properties: {
        summary,
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
    }),
    toModelOutput,
  }),
  tool({
    name: "edit_code",
    description:
      'Replace one exact, unique occurrence of old_string with new_string in the workbook code, or in a data file when `file` names one (e.g. "orders.csv"). Include enough context to make old_string unique.',
    input: jsonSchema({
      type: "object",
      properties: {
        file: { type: "string", description: "Data file name; omit for the workbook code" },
        summary,
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["old_string", "new_string"],
    }),
    toModelOutput,
  }),
  tool({
    name: "write_code",
    description:
      "Replace the entire workbook code, or write a whole data file (creating it if needed) when `file` names one. Data files are CSV with a header line of column keys.",
    input: jsonSchema({
      type: "object",
      properties: {
        file: { type: "string", description: 'Data file name like "sales.csv"; omit for the workbook code' },
        summary,
        source: { type: "string", description: "The full file contents" },
      },
      required: ["source"],
    }),
    toModelOutput,
  }),
]

/**
 * The workbook as the browser sent it with the user's message (code, data files, selection, review notes).
 * Resumes after a tool call carry none, so it's added once per message, as before.
 */
const workbook = defineContext({
  name: "workbook",
  get: ({ clientContext }) => (typeof clientContext?.workbook === "string" ? clientContext.workbook : undefined),
})

export interface AssistantEnv {
  ANTHROPIC_API_KEY?: string
  /** Local testing only: a stand-in for the Claude API. */
  ANTHROPIC_BASE_URL?: string
  DB: D1Database
}

/** One kit per isolate. Sessions, messages and run events are in D1, so any isolate can resume a run. */
let kit: Kit<Context> | undefined

export function assistantKit(env: AssistantEnv, meter: Meter): Kit<Context> {
  kit ??= createKit<Context>({
    agents: [
      defineAgent<Context>({
        name: "xl2",
        instructions: SYSTEM,
        model: claude(MODEL, { clientOptions: { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined } }),
        settings: { effort: "medium", reasoningSummary: true, maxOutputTokens: 32000 },
        tools,
        contextProviders: [workbook],
        limits: { maxSteps: 25 },
        hooks: {
          // Each call counts against the user's daily allowance (auth.nyggis.com → Apps → xl2 → AI).
          afterModelCall: async ({ usage }, ctx) => {
            await meter.record(ctx.context.user, {
              model: MODEL,
              usage: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cache_read_input_tokens: usage.cacheReadTokens,
                cache_creation_input_tokens: usage.cacheWriteTokens,
              },
            })
          },
        },
      }),
    ],
    store: sqlStore({ exec: async (sql, params) => (await env.DB.prepare(sql).bind(...params).all()).results }),
  })
  return kit
}
