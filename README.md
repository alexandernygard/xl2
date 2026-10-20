# xl2

An experiment in an AI-first spreadsheet where the workbook is code. A workbook is one TypeScript module plus optional CSV data files. Each sheet is an infinite grid: tables, inputs and free cells sit in cells, and charts, metrics and text float over cell ranges. Every edit in the grid rewrites the matching code or CSV text, so the files stay the single source of truth.

```bash
pnpm install
pnpm dev        # http://localhost:5199
pnpm test       # SDK tests
```

Add your Anthropic API key under Settings (gear icon) to use the assistant. It stays in the browser's localStorage and is only sent to api.anthropic.com. There is no server.

## Packages

| Package | What it is |
| --- | --- |
| `packages/sdk` (`@xl2/sdk`) | The model. The authoring API (`workbook`, `sheet` with `cells`/`widths`, `table`, `col`, `query`, `chart`, `metric`, `param`, `text`, `data`), A1 addressing and cell formulas (`=SUM(B2:B9) * growth`, cross-sheet refs, Excel-named functions), the evaluation engine (lazy and memoized, with cycle detection and per-cell errors), the grid layout (`at: "H2:M14"`), **source edits** (`applyEdit`: UI edits become minimal splices to the code or the CSV, found via a Babel AST), and grid logic (`cellAt`, typing/paste/fill/clear → edit intents, with relative references shifted). Also `SDK_REFERENCE`, the docs given to Claude. |
| `packages/viz` (`@xl2/viz`) | React views on `@alexandernygard/components`. `SheetGrid` is a virtualized, infinite grid with sticky headers, range selection, keyboard navigation, type-to-edit, formula point-mode, fill handle, copy/paste, column resize, context menu, and drag to move or resize blocks. Also sheet tabs, charts (recharts), metric and markdown views. Views never mutate data; they emit `EditIntent`s. |
| `apps/web` | The in-browser app. A zustand store (bundles, undo/redo), evaluation in a Web Worker, a CodeMirror editor with TypeScript checking in a second worker, a toolbar, a formula bar with a name box, a chat panel with a streaming Claude tool loop, and a Grid / Split / Code layout. |

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
2. **Growing tables don't push neighbours.** A table that gains rows can grow into a block below it. That's reported as an overlap issue, but nothing moves out of the way the way Excel's "insert row" does.
3. **No incremental re-evaluation.** Each change re-runs the whole workbook in the worker. That's fine for thousands of rows, since data lives in CSV rather than in the parsed code. Far beyond that needs a cell/column dependency graph and incremental evaluation.
4. **The sandbox is a worker, not a security boundary for hostile code.** Workbook code runs in a Web Worker without network, storage or DOM access and is stopped after 3 s, so it can't read the API key or freeze the page. Parsing for edits (Babel) still runs on the main thread.
5. **Typed rows are missing.** The checker catches wrong builder names, options and types, but `r.unitz` inside a formula isn't an error, because rows are `Record<string, any>`.
6. **Cell formulas are JS with A1 sugar, not Excel syntax.** Use `==`, `&&` and `"text"` (`<>` is accepted). There are no array formulas, named ranges or conditional formatting yet.
7. **Grid gaps.** There is no row insert or delete for free cells, no merged free cells, and no per-cell number format inside tables (formats are per column).
8. **Assistant state.** The conversation isn't saved across reloads, and every user message includes the full code. Pending drafts are saved, but after a reload you review them only from the bar above the grid.
9. **Review gaps.** There's no code merge view yet, and no per-chunk review inside one tool call. Rows are matched by position, so a row inserted mid-table marks every row below it as changed.
