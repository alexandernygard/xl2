import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  applyEdits,
  cellAt,
  examples,
  locate,
  type Bundle,
  type EditIntent,
  type Range,
  type Target,
  type WorkbookModel,
} from "@xl2/sdk"
import type { GridSelection } from "@xl2/viz"
import { evaluateBundle, type EvalError, type EvalResult } from "./evaluator"

// One store for the app. The active workbook's bundle (code plus CSV data
// files) is the single source of truth; the evaluated model is derived from
// it in a worker after every change.

export type View = "data" | "split" | "code"
export type Origin = "editor" | "grid" | "ai" | "system"

/** The workbook code's name inside a bundle, next to data files like "sales.csv". */
export const MAIN = "main"

export interface FileDoc {
  id: string
  name: string
  source: string
  files: Record<string, string>
  updatedAt: number
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; detail?: string }

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: ChatPart[]
  error?: string
}

interface History {
  past: Bundle[]
  future: Bundle[]
  lastPush: number
  lastOrigin?: Origin
}

interface State {
  files: Record<string, FileDoc>
  order: string[]
  activeId: string
  view: View
  chatOpen: boolean
  apiKey: string
  aiModel: string

  // not persisted
  model: WorkbookModel | null
  error: EvalError | null
  evaluating: boolean
  history: Record<string, History>
  activeSheet: number
  selection: GridSelection | null
  /** Index of the selected chart/metric/text/table block on the active sheet. */
  selectedBlock: number | null
  reveal: (Range & { nonce: number }) | null
  /** File shown in the code pane: MAIN or a data file name. */
  codeFile: string
  /** Bumped whenever a file changes from outside the code editor. */
  externalRev: number

  bundle(): Bundle
  setBundle(bundle: Bundle, origin: Origin): Promise<EvalResult>
  setFileText(file: string, text: string, origin: Origin): Promise<EvalResult>
  applyIntent(intent: EditIntent | EditIntent[]): string | null
  /** Resolves with the evaluation of the latest change. */
  settle(): Promise<EvalResult>
  undo(): void
  redo(): void
  recompute(): Promise<EvalResult>
  select(sel: GridSelection | null): void
  selectBlock(index: number | null): void
  revealTarget(target: Target): void
  setActiveSheet(i: number): void
  setView(v: View): void
  setChatOpen(open: boolean): void
  setApiKey(k: string): void
  setAiModel(m: string): void
  setCodeFile(f: string): void
  newFile(bundle: Bundle): void
  openFile(id: string): void
  deleteFile(id: string): void
}

const uid = () => Math.random().toString(36).slice(2, 10)

function initialFiles() {
  const files: Record<string, FileDoc> = {}
  const order: string[] = []
  for (const ex of examples.filter((e) => e.id !== "blank")) {
    const id = uid()
    files[id] = { id, name: ex.name, source: ex.source, files: { ...ex.files }, updatedAt: Date.now() }
    order.push(id)
  }
  return { files, order, activeId: order[0] }
}

const COALESCE_MS = 1200
const sameBundle = (a: Bundle, b: Bundle) =>
  a.source === b.source && Object.keys(a.files).length === Object.keys(b.files).length && Object.entries(a.files).every(([k, v]) => b.files[k] === v)

let evalRev = 0
let lastEval: Promise<EvalResult> = Promise.resolve({ ok: false, error: { message: "Not evaluated yet" } })

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Evaluate the active bundle in the worker; only the newest result is applied. */
      function schedule(): Promise<EvalResult> {
        const rev = ++evalRev
        const fileId = get().activeId
        set({ evaluating: true })
        lastEval = evaluateBundle(get().bundle()).then((r) => {
          if (rev !== evalRev || fileId !== get().activeId) return r
          set((s) => {
            const file = s.files[fileId]
            return {
              evaluating: false,
              model: r.ok ? r.model : s.model,
              error: r.ok ? null : r.error,
              activeSheet: r.ok ? Math.min(s.activeSheet, Math.max(0, r.model.sheets.length - 1)) : s.activeSheet,
              files: r.ok && file && file.name !== r.model.name ? { ...s.files, [fileId]: { ...file, name: r.model.name } } : s.files,
            }
          })
          return r
        })
        return lastEval
      }

      function write(bundle: Bundle, history: History, external: boolean) {
        const { activeId } = get()
        set((s) => ({
          files: { ...s.files, [activeId]: { ...s.files[activeId], source: bundle.source, files: bundle.files, updatedAt: Date.now() } },
          history: { ...s.history, [activeId]: history },
          externalRev: external ? s.externalRev + 1 : s.externalRev,
          codeFile: s.codeFile === MAIN || s.codeFile in bundle.files ? s.codeFile : MAIN,
        }))
      }

      return {
        ...initialFiles(),
        view: "data",
        chatOpen: true,
        apiKey: "",
        aiModel: "claude-opus-5-5",

        model: null,
        error: null,
        evaluating: false,
        history: {},
        activeSheet: 0,
        selection: null,
        selectedBlock: null,
        reveal: null,
        codeFile: MAIN,
        externalRev: 0,

        bundle: () => {
          const f = get().files[get().activeId]
          return { source: f?.source ?? "", files: f?.files ?? {} }
        },

        setBundle(bundle, origin) {
          const { activeId } = get()
          const cur = get().bundle()
          if (sameBundle(cur, bundle)) return lastEval
          const h = get().history[activeId] ?? { past: [], future: [], lastPush: 0 }
          const now = Date.now()
          // typing in the editor coalesces into one undo step
          const coalesce = origin === "editor" && h.lastOrigin === "editor" && now - h.lastPush < COALESCE_MS
          const past = coalesce ? h.past : [...h.past, cur].slice(-200)
          write(bundle, { past, future: [], lastPush: now, lastOrigin: origin }, origin !== "editor")
          return schedule()
        },

        setFileText(file, text, origin) {
          const b = get().bundle()
          return get().setBundle(file === MAIN ? { ...b, source: text } : { ...b, files: { ...b.files, [file]: text } }, origin)
        },

        applyIntent(intent) {
          const r = applyEdits(get().bundle(), Array.isArray(intent) ? intent : [intent])
          if (!r.ok) return r.error
          get().setBundle(r.bundle, "grid")
          return null
        },

        settle: () => lastEval,

        undo() {
          const { activeId, history } = get()
          const h = history[activeId]
          if (!h?.past.length) return
          const prev = h.past[h.past.length - 1]
          write(prev, { past: h.past.slice(0, -1), future: [get().bundle(), ...h.future], lastPush: 0 }, true)
          schedule()
        },

        redo() {
          const { activeId, history } = get()
          const h = history[activeId]
          if (!h?.future.length) return
          const [next, ...rest] = h.future
          write(next, { past: [...h.past, get().bundle()], future: rest, lastPush: 0 }, true)
          schedule()
        },

        recompute: () => schedule(),

        select(sel) {
          set({ selection: sel, selectedBlock: null })
          const { model, activeSheet } = get()
          const sheet = model?.sheets[activeSheet]
          if (!sel || !sheet) return
          const info = cellAt(sheet, sel.focus.row, sel.focus.col)
          let target: Target | null = null
          if (info.kind === "free") target = { type: "freeCell", sheet: sheet.name, address: info.address }
          else if (info.kind === "param") target = { type: "param", name: info.param.name }
          else if (info.kind === "table" && info.table.source === "table" && info.column) {
            const { region } = info
            target =
              region.kind === "data"
                ? { type: "cell", table: info.table.name, row: region.index, column: info.column.key }
                : region.kind === "header"
                  ? { type: "column", table: info.table.name, column: info.column.key }
                  : { type: "table", table: info.table.name }
          } else if (info.kind === "table") target = { type: "block", sheet: sheet.name, index: info.table.index }
          if (target) get().revealTarget(target)
        },

        selectBlock(index) {
          set({ selectedBlock: index })
          const sheet = get().model?.sheets[get().activeSheet]
          if (index !== null && sheet) get().revealTarget({ type: "block", sheet: sheet.name, index })
        },

        revealTarget(target) {
          const b = get().bundle()
          const range = locate(b.source, target, b.files)
          if (range) set({ reveal: { ...range, nonce: Date.now() }, codeFile: range.file ?? MAIN })
        },

        setActiveSheet: (i) => set({ activeSheet: i, selection: null, selectedBlock: null }),
        setView: (view) => set({ view }),
        setChatOpen: (chatOpen) => set({ chatOpen }),
        setApiKey: (apiKey) => set({ apiKey }),
        setAiModel: (aiModel) => set({ aiModel }),
        setCodeFile: (codeFile) => set({ codeFile }),

        newFile(bundle) {
          const id = uid()
          set((s) => ({
            files: { ...s.files, [id]: { id, name: "Untitled", source: bundle.source, files: bundle.files, updatedAt: Date.now() } },
            order: [...s.order, id],
            activeId: id,
            activeSheet: 0,
            selection: null,
            selectedBlock: null,
            codeFile: MAIN,
            model: null,
            error: null,
            externalRev: s.externalRev + 1,
          }))
          schedule()
        },

        openFile(id) {
          if (!get().files[id]) return
          set((s) => ({ activeId: id, activeSheet: 0, selection: null, selectedBlock: null, codeFile: MAIN, model: null, error: null, externalRev: s.externalRev + 1 }))
          schedule()
        },

        deleteFile(id) {
          const { order, files, activeId } = get()
          if (order.length <= 1) return
          const rest = order.filter((x) => x !== id)
          const { [id]: _, ...keep } = files
          set({ files: keep, order: rest })
          if (activeId === id) get().openFile(rest[0])
        },
      }
    },
    {
      name: "xl2",
      version: 2,
      migrate: (state: any, version) => {
        if (version < 2 && state?.files) {
          // v1 files had no data files, and the default view was split
          for (const f of Object.values<any>(state.files)) f.files ??= {}
          state.view = "data"
        }
        return state
      },
      partialize: (s) => ({
        files: s.files,
        order: s.order,
        activeId: s.activeId,
        view: s.view,
        chatOpen: s.chatOpen,
        apiKey: s.apiKey,
        aiModel: s.aiModel,
      }),
    },
  ),
)
