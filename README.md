# xl2

An experiment in an AI-first spreadsheet where the workbook is code. A workbook is one TypeScript module. The app evaluates it and renders sheets, tables, charts, metrics and inputs. Editing a cell rewrites the matching literal in the code, so code stays the single source of truth.

```bash
pnpm install
pnpm dev        # http://localhost:5199
pnpm test       # SDK tests
```

Add your Anthropic API key under Settings (gear icon) to use the assistant. It stays in the browser's localStorage and is only sent to api.anthropic.com. There is no server.

## Packages

| Package | What it is |
| --- | --- |
| `packages/sdk` (`@xl2/sdk`) | The model. Authoring API (`workbook`, `sheet`, `table`, `col`, `query`, `chart`, `metric`, `param`, `text`), the evaluation engine (lazy formulas, cross-table refs, cycle detection, per-cell errors), the runtime (TS → JS with sucrase, run with only `@xl2/sdk` importable), **source edits** (`applyIntent`: UI edits become minimal text splices found via a Babel AST), formatting/input parsing, CSV → table code, and `SDK_REFERENCE`, the docs given to Claude. |
| `packages/viz` (`@xl2/viz`) | React views on `@alexandernygard/components`: `SheetView`, `SheetTabs`, `DataGrid` (keyboard navigation, type-to-edit, TSV paste, add/delete rows and columns), `ChartView` (recharts), metric, param and markdown blocks. Views never mutate data. They emit `EditIntent`s. |
| `apps/web` | The in-browser app. Zustand store (files, undo/redo, derived model), CodeMirror editor, chat panel with a streaming Claude tool loop, resizable Data / Split / Code layout. |

## How two-way editing works

```
source (string) ──run()──▶ WorkbookModel ──▶ SheetView
     ▲                                          │ EditIntent {setCell, addRow, ...}
     └──────── applyIntent(source, intent) ◀────┘
```

- **Code → data:** every source change (editor, AI, undo) is re-run and re-evaluated synchronously. If it fails, the last good model stays on screen with an error banner and a marker in the editor.
- **Data → code:** an intent locates the node (`table("sales")` → `rows[2]` → `units`) in the AST and replaces just that literal's text range. Object rows and tuple rows both work, and formatting and comments are kept. Selecting a cell flashes its literal in the code. For computed cells, the formula bar shows the formula's source.
- **AI:** Claude gets the SDK reference and the current source, and works through four tools: `read_values` (evaluated data), `set_cells` (goes through the same intents), `edit_code` (exact string replace) and `write_code`. After each edit it gets back whether the workbook still evaluates, so it can fix its own errors.

## Limitations and what a real version would need

1. **Only literal data is editable in the grid.** Rows built by code (`Array.from`, query results) and formula cells are read-only, and the grid says so. That's inherent to "code is the truth". A fuller answer is an *overrides* layer (`table(..., { overrides })`) or a data/code split where big data lives in a JSON/CSV file next to the code.
2. **Code runs unsandboxed on the page.** Workbook code (yours or the AI's) runs with `new Function` in the page's own origin, so it could read the API key in localStorage, and an infinite loop freezes the tab. Next step: evaluate in a Web Worker, or in a sandboxed iframe with a timeout, and only send back the model. That's a contained change because `run()` is pure.
3. **Scale.** Each change re-parses, re-runs and re-evaluates the whole workbook, and the grid isn't virtualized. That's fine for hundreds of rows but not for 100k. Real use needs incremental evaluation (a dependency graph per cell/column), a virtualized grid, and columnar data stored outside the source text.
4. **Code → grid selection is one-way.** Clicking a cell highlights its code. Moving the cursor in code doesn't select a cell yet. The `locate` function gives everything needed for that.
5. **Formulas are JS functions, not cell references.** There's no `=B2*C2` or A1 addressing. Formulas are per-column, plus queries. This is the deliberate "reimagined" part, but users from Excel will miss single-cell formulas and ranges.
6. **Assistant:** the conversation isn't saved across reloads, and every user message includes the full source, so very large workbooks cost more tokens per turn. It uses `claude-opus-5-5` (switchable to Sonnet/Haiku in Settings) with adaptive thinking and server-side refusal fallbacks (`fallbacks: "default"`).
7. **Type checking:** the editor highlights TypeScript but doesn't type-check against the SDK types. Monaco or a TS worker would add autocomplete and type errors for both people and Claude.

None of this needed a new form factor. A browser-only app works, and the one structural change worth making next is moving evaluation into a worker.
