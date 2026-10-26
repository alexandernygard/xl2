# xl2

An experiment in an AI-first spreadsheet where the workbook is code. A workbook is one TypeScript module plus optional CSV data files. Each sheet is an infinite grid: tables, inputs and free cells sit in cells, and charts, metrics and text float over cell ranges. Every edit in the grid rewrites the matching code or CSV text, so the files stay the single source of truth.

```bash
pnpm install
pnpm dev        # http://localhost:5199
pnpm test       # SDK tests
```

The assistant needs a Nyggis account: it runs on this app's own Claude key, and each person has a daily allowance (shown under the message box). Workbooks live in your browser. A new tab starts on an empty workbook; a reload keeps the one you were in, and earlier ones stay in the file menu.

### Sharing a workbook live

Share in the header needs a Nyggis account: it saves the workbook to Drive, where you add people by email and choose who can edit, and you edit together with each other's selections visible. Workbooks shared by link before Drive still sync through this app's Durable Object (`apps/worker`, built on `@alexandernygard/collab`) until they're saved to Drive or the link is turned off; new link sharing is gone.

```bash
pnpm dev:worker   # Worker + Durable Object + assistant on :8789 (vite proxies /collab and /api to it)
pnpm dev          # the app
```

### The assistant

Claude runs in the Worker (`apps/worker/src/assistant.ts`) on [ai-kit](../ai-kit), with the app's key. Its four tools change the workbook, which lives in the browser, so they're ai-kit client tools: the Worker declares them, the chat panel runs them (`apps/web/src/ai.ts`) and sends the result back, and the run continues. Each user message carries the workbook as `clientContext`, which the agent sees once per message.

- **Key:** the `ANTHROPIC_API_KEY` secret on the `xl2` Worker (Cloudflare dashboard → Workers → xl2 → Settings → Variables and Secrets). Without it the assistant answers 503.
- **Who:** signed-in Nyggis users only (`appId` `xl2`). The app itself stays public.
- **Limits and usage:** each Claude call is recorded in the shared `ai-usage` database, and a user over today's limit gets a 429. Set the limit per app or role in the auth console (auth.nyggis.com → Apps → xl2 → AI); usage shows on its AI usage page.
- **Sessions:** ai-kit keeps conversations in the `xl2` D1 database (`apps/worker/migrations`). Apply migrations with `wrangler d1 migrations apply xl2 --remote`.
- **Locally:** copy `.dev.vars.example` to `.dev.vars`, run the auth Worker on :8787, and set a key. Apply the migrations with `--local`, and run `../auth/usage-migrations/0001_init.sql` against `ai-usage` with `wrangler d1 execute ai-usage --local --file`. `ANTHROPIC_BASE_URL` points the Worker at a stand-in Claude API for tests.

### Drive

Workbooks in [Drive](../drive) (drive.nyggis.com) open here as `/?file=<id>` and sync through the drive's rooms instead of this app's Worker, so sharing follows Drive: people you add by email, as viewers or editors, with Nyggis accounts. The header shows who else is in the file and Drive's share dialog. *Save to Drive* (in Share) moves a local workbook there. Locally, run the drive (`pnpm dev:worker` in `../drive`) and the auth Worker (:8787).

## Packages

| Package | What it is |
| --- | --- |
| `packages/sdk` (`@xl2/sdk`) | The model. The authoring API (`workbook`, `sheet` with `cells`/`widths`, `table`, `col`, `query`, `chart`, `metric`, `param`, `text`, `data`), A1 addressing and cell formulas (`=SUM(B2:B9) * growth`, cross-sheet refs, Excel-named functions), the evaluation engine (lazy and memoized, with cycle detection and per-cell errors), the grid layout (`at: "H2:M14"`), **source edits** (`applyEdit`: UI edits become minimal splices to the code or the CSV, found via a Babel AST), and grid logic (`cellAt`, typing/paste/fill/clear → edit intents, with relative references shifted). Also `SDK_REFERENCE`, the docs given to Claude. |
| `packages/viz` (`@xl2/viz`) | React views on `@alexandernygard/components`. `SheetGrid` is a virtualized, infinite grid with sticky headers, range selection, keyboard navigation, type-to-edit, formula point-mode, fill handle, copy/paste, column resize, context menu, and drag to move or resize blocks. Also sheet tabs, charts (recharts), metric and markdown views. Views never mutate data; they emit `EditIntent`s. |
| `apps/worker` | The Worker: static assets, the link-sharing Durable Object, and the assistant (ai-kit agent, Nyggis sign-in, usage metering). |
| `apps/web` | The in-browser app. A zustand store (bundles, undo/redo), evaluation in a Web Worker, a CodeMirror editor with TypeScript checking in a second worker, a toolbar, a formula bar with a name box, a chat panel for the assistant (ai-kit client tools), and a Grid / Split / Code layout. |

## How it fits together

```
code + CSV files ──worker: run()──▶ WorkbookModel (values placed on each sheet's grid) ──▶ SheetGrid
        ▲                                                                                     │ EditIntent
        └────────────── applyEdit(bundle, intent): splice one literal / CSV cell ◀────────────┘
```

- **Grid.** Blocks get an `at`. A cell anchors a table, query or param at its natural size. A range sizes a chart, metric or text block. Free cells live in `sheet(name, blocks, { cells: { B3: 0.08, C3: "=B3*2" } })`. Formulas are JS expressions with A1 references, so they can point into tables, params and other sheets.
- **Typing.** Where a value goes depends on what's under the cell:
  - Table cell: its literal changes (in code or the CSV).
  - Row under a table: a new row is appended.
  - Cell right of a table header: a new column is added.
  - Formula cell: an `override` is recorded, marked with a corner tick and reversible from the formula bar.
  - Param: the param's value changes.
  - Empty cell: a free cell is created.
- **Building formulas.** Type `=` in a cell or the formula bar and a help panel opens under it:
  - Click a cell, or drag a range, to insert its reference. Clicking again replaces it, and Shift+click extends it. Arrow keys point too, as in Excel (Shift+arrows for a range).
  - References are coloured in the text and outlined on the grid in the same colour.
  - Completions cover functions, tables and params. After `sales.` you get Rows methods, and inside `sales.sum("` the column keys. Press Tab to insert.
  - Inside a call, the function's arguments show with the current one marked.
  - Operator chips (`+ − × ÷`, comparisons, `and`/`or`) insert at the caret.
  - The **fx** button in the formula bar opens a searchable list of every function, with arguments and an example.

  The function docs live in `@xl2/sdk` (`FUNCTION_DOCS`, `formulaSuggestions`, `formulaCaret`).
- **Moving.** Dragging a chart, metric, text block, table grip or param grip rewrites its `at`. Drops that would overlap another block are refused. Column resizes write `widths`.
- **Code → grid.** Every change (editor, AI, undo) is evaluated in a worker. If it fails, the last good model stays up with an error banner and a marker in the editor. The editor also type-checks against the real SDK types, with completions and hover.
- **Grid → code.** Selecting a cell highlights its literal, its CSV cell, its formula or its block in the code pane.
- **AI.** Claude gets the SDK reference, the code, a summary of the data files, and the selection. It works through four tools:
  - `read_values`: an overview, a table's rows, or any A1 range.
  - `set_cells`: by table row and column, or by A1 address.
  - `edit_code`: exact string replacement in the code or a CSV.
  - `write_code`: replaces the code, or creates a data file.

  After each edit Claude gets back the evaluation result, layout overlaps and type errors.
- **Review.** Claude's edits apply right away but open a draft. Each tool call is one change you accept or reject, from its row in the chat or all at once from the bar above the grid. The grid shows each change:
  - Cells Claude edited are tinted.
  - Added cells are green.
  - Recalculated cells get a dashed outline.
  - Removed values are struck through.
  - Moved blocks leave an outline where they were.
  - Hovering a changed cell shows its old value.

  The bar also shows how headline numbers moved (metrics and table totals). Your own edits during a draft are recorded too and kept when you reject Claude's. Rejecting a change replays the others onto the original; a change that depended on a rejected one is flagged and dropped. A closed draft is one undo step, and Claude is told what you rejected.

## Limitations and next steps

1. **Rows built by code aren't editable.** Rows generated by code (`Array.from`, queries) stay read-only. Formula cells can be overridden, but only in tables with literal or CSV rows.
2. **Pushed blocks keep their old `at`.** When a table grows into a block below it, the block is drawn lower to make room (and auto-placed blocks keep clear of placed ones), but its `at` in the code stays the same until you move it. Free cells under a growing table are still covered.
3. **No incremental re-evaluation.** Each change re-runs the whole workbook in the worker. That's fine for thousands of rows, since data lives in CSV rather than in the parsed code. Far beyond that needs a cell/column dependency graph and incremental evaluation.
4. **The sandbox is a worker, not a security boundary for hostile code.** Workbook code runs in a Web Worker without network, storage or DOM access and is stopped after 3 s, so it can't reach the page's storage or freeze the page. Parsing for edits (Babel) still runs on the main thread.
5. **Typed rows are missing.** The checker catches wrong builder names, options and types, but `r.unitz` inside a formula isn't an error, because rows are `Record<string, any>`.
6. **Cell formulas are JS with A1 sugar, not Excel syntax.** Use `==`, `&&` and `"text"` (`<>` is accepted). There are no array formulas, named ranges or conditional formatting yet.
7. **Grid gaps.** There is no row insert or delete for free cells, no merged free cells, and no per-cell number format inside tables (formats are per column).
8. **Assistant state.** Conversations are stored in D1, but the page doesn't reopen them after a reload, and every user message includes the full code. Pending drafts are saved, but after a reload you review them only from the bar above the grid.
9. **Review gaps.** There's no code merge view yet, and no per-chunk review inside one tool call. Rows are matched by position, so a row inserted mid-table marks every row below it as changed.
