import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  applyEdits,
  applyOp,
  bundleOp,
  cellAt,
  diffModels,
  blankExample,
  locate,
  parseAddress,
  replay,
  textEdit,
  touchedCells,
  type Bundle,
  type EditIntent,
  type Range,
  type StepOp,
  type Target,
  type WorkbookModel,
} from "@xl2/sdk"
import type { GridSelection } from "@xl2/viz"
import { evaluateBundle, type EvalError, type EvalResult } from "./evaluator"

// One store for the app. The active workbook's bundle (code plus CSV data
// files) is the single source of truth; the evaluated model is derived from
// it in a worker after every change.

export type View = "data" | "split" | "code"
export type Origin = "editor" | "grid" | "ai" | "system" | "remote"

/** The workbook code's name inside a bundle, next to data files like "sales.csv". */
export const MAIN = "main"

export interface FileDoc {
  id: string
  name: string
  source: string
  files: Record<string, string>
  updatedAt: number
  /** Set while the workbook is shared: the id of its live-collaboration room. */
  roomId?: string
  /** The room is a file in Drive (drive.nyggis.com): roomId is its id, access follows its sharing, and Drive owns its name. */
  drive?: boolean
  /** Claude's changes awaiting review. The bundle above already includes them. */
  draft?: Draft
}

export type StepStatus = "pending" | "accepted" | "rejected"

/** One recorded change while a draft is open: a Claude tool call, or an edit of yours. */
export interface DraftStep {
  id: string
  author: "ai" | "user"
  label: string
  op: StepOp
  /** Your own edits are accepted from the start; only Claude's wait for review. */
  status: StepStatus
  /** The assistant message whose tool call made it. */
  messageId?: string
  /** The first cell it changed, to jump to, and how many it changed directly. */
  focus?: { sheet: string; address: string }
  cells?: number
  at: number
}

export interface Draft {
  /** The workbook before Claude's first change. */
  base: Bundle
  steps: DraftStep[]
}

export type StepOutcome = StepStatus | "conflict"

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; detail?: string; stepId?: string }

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
  /** The evaluated draft base, to diff the current model against. */
  baseModel: WorkbookModel | null
  /** Draft steps that no longer apply after a rejection, with why. */
  conflicts: Record<string, string>
  /** How reviewed steps ended, after their draft closed (for the chat). */
  decided: Record<string, StepOutcome>
  /** Ask the grid to scroll a cell into view. */
  scrollRequest: { row: number; col: number; nonce: number } | null

  bundle(): Bundle
  setBundle(bundle: Bundle, origin: Origin): Promise<EvalResult>
  setFileText(file: string, text: string, origin: Origin): Promise<EvalResult>
  applyIntent(intent: EditIntent | EditIntent[]): string | null
  /** Record a change as a draft step (Claude's open or extend a draft; yours only join an open one). */
  applyStep(op: StepOp, author: DraftStep["author"], label: string, messageId?: string): Promise<StepResult>
  draft(): Draft | undefined
  reviewStep(id: string, status: StepStatus): void
  acceptAll(): void
  rejectAll(): void
  /** Show a cell: switch to its sheet, select it and scroll to it. */
  goTo(sheet: string, address: string): void
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
  newFile(bundle: Bundle, opts?: { roomId?: string; drive?: boolean; name?: string }): void
  /** Share the active workbook (or stop sharing it). `drive`: the room is a Drive file. */
  setRoom(fileId: string, roomId: string | undefined, drive?: boolean): void
  renameFile(fileId: string, name: string): void
  openFile(id: string): void
  deleteFile(id: string): void
}

export type StepResult = { ok: true; stepId?: string; result: EvalResult } | { ok: false; error: string }

const uid = () => Math.random().toString(36).slice(2, 10)

/** Live collaboration replaces snapshot undo while a workbook is shared (see collab.ts). */
export const collabHooks: { undo?: () => void; redo?: () => void } = {}

/** File text before each of your code-editor steps, so typing coalesces into one step. */
const editorBefore = new Map<string, { file: string; text: string }>()

/** What the user decided since Claude last looked, per file; the next message tells Claude. */
const reviewNotes: Record<string, string[]> = {}
export function takeReviewNotes(fileId: string): string[] {
  const notes = reviewNotes[fileId] ?? []
  delete reviewNotes[fileId]
  return notes
}

/** A label for your own edit, from its intents. */
function describe(intents: EditIntent[]): string {
  const i = intents[0]
  const more = intents.length > 1 ? ` (+${intents.length - 1})` : ""
  switch (i?.type) {
    case "setCell":
    case "setOverride":
      return `Edited ${i.table}[${i.row}].${i.column}${more}`
    case "setFreeCell":
    case "setCellStyle":
      return `Edited ${i.address}${more}`
    case "setParam":
      return `Set ${i.name}${more}`
    case "addRow":
      return `Added a row to ${i.table}${more}`
    case "deleteRow":
      return `Deleted a row of ${i.table}${more}`
    case "moveBlock":
      return `Moved a block to ${i.at}${more}`
    default:
      return `Your edit${more}`
  }
}
function initialFiles() {
  const id = uid()
  return { files: { [id]: { id, name: "Untitled", source: blankExample, files: {}, updatedAt: Date.now() } }, order: [id], activeId: id }
}

const COALESCE_MS = 1200
const sameBundle = (a: Bundle, b: Bundle) =>
  a.source === b.source && Object.keys(a.files).length === Object.keys(b.files).length && Object.entries(a.files).every(([k, v]) => b.files[k] === v)

let evalRev = 0
let baseInFlight: Bundle | null = null
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
              files: r.ok && file && !file.drive && file.name !== r.model.name ? { ...s.files, [fileId]: { ...file, name: r.model.name } } : s.files,
            }
          })
          return r
        })
        const draft = get().files[fileId]?.draft
        if (draft && !get().baseModel && baseInFlight !== draft.base) {
          const base = (baseInFlight = draft.base)
          evaluateBundle(base).then((r) => {
            if (baseInFlight === base) baseInFlight = null
            if (r.ok && get().activeId === fileId && get().files[fileId]?.draft?.base === draft.base) set({ baseModel: r.model })
          })
        }
        return lastEval
      }

      function writeDraft(draft: Draft | undefined, bundle: Bundle, external = true) {
        const { activeId } = get()
        set((s) => ({
          files: { ...s.files, [activeId]: { ...s.files[activeId], source: bundle.source, files: bundle.files, draft, updatedAt: Date.now() } },
          externalRev: external ? s.externalRev + 1 : s.externalRev,
          codeFile: s.codeFile === MAIN || s.codeFile in bundle.files ? s.codeFile : MAIN,
        }))
      }

      /** Re-apply the draft's steps onto its base, leaving out rejected ones. */
      function rebuild(draft: Draft) {
        const r = replay(draft.base, draft.steps.map((st) => (st.status === "rejected" ? null : st.op)))
        set({ conflicts: Object.fromEntries([...r.failed].map(([i, e]) => [draft.steps[i].id, e])) })
        writeDraft(draft, r.bundle)
        schedule()
      }

      /** Close the draft once nothing of Claude's waits for review: it becomes one undo step. */
      function finalize() {
        const { activeId, conflicts } = get()
        const draft = get().files[activeId]?.draft
        if (!draft || draft.steps.some((st) => st.author === "ai" && st.status === "pending")) return
        const cur = get().bundle()
        const h = get().history[activeId] ?? { past: [], future: [], lastPush: 0 }
        const outcome = (st: DraftStep): StepOutcome => (conflicts[st.id] ? "conflict" : st.status)
        const notes = draft.steps
          .filter((st) => st.author === "ai" && outcome(st) !== "accepted")
          .map((st) => `${outcome(st) === "conflict" ? "Dropped (depended on a rejected change)" : "Rejected"}: ${st.label}`)
        if (notes.length) (reviewNotes[activeId] ??= []).push(...notes)
        set((s) => ({
          decided: { ...s.decided, ...Object.fromEntries(draft.steps.map((st) => [st.id, outcome(st)])) },
          history: sameBundle(draft.base, cur) ? s.history : { ...s.history, [activeId]: { past: [...h.past, draft.base].slice(-200), future: [], lastPush: 0 } },
          baseModel: null,
          conflicts: {},
        }))
        writeDraft(undefined, cur, false)
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
        baseModel: null,
        conflicts: {},
        decided: {},
        scrollRequest: null,

        bundle: () => {
          const f = get().files[get().activeId]
          return { source: f?.source ?? "", files: f?.files ?? {} }
        },

        draft: () => get().files[get().activeId]?.draft,

        setBundle(bundle, origin) {
          const { activeId } = get()
          const cur = get().bundle()
          if (sameBundle(cur, bundle)) return lastEval
          const draft = get().draft()
          if (draft) {
            // while Claude's changes await review, your edits join the draft as accepted steps
            const last = draft.steps[draft.steps.length - 1]
            const prev = last && editorBefore.get(last.id)
            const changed = bundle.source !== cur.source ? MAIN : Object.keys(bundle.files).find((f) => bundle.files[f] !== cur.files[f])
            if (origin === "editor" && last?.author === "user" && prev && prev.file === changed && Date.now() - last.at < COALESCE_MS) {
              const text = changed === MAIN ? bundle.source : bundle.files[changed]
              const op = textEdit(changed, prev.text, text)
              const steps = op ? [...draft.steps.slice(0, -1), { ...last, op, at: Date.now() }] : draft.steps.slice(0, -1)
              writeDraft({ ...draft, steps }, bundle, false)
              return schedule()
            }
            const op = bundleOp(cur, bundle)
            if (!op) return lastEval
            const step: DraftStep = { id: uid(), author: "user", label: origin === "remote" ? "A collaborator's edit" : origin === "editor" ? `Edited ${changed === MAIN ? "code" : changed}` : "Your edit", op, status: "accepted", at: Date.now() }
            if (origin === "editor" && changed) editorBefore.set(step.id, { file: changed, text: changed === MAIN ? cur.source : cur.files[changed] })
            writeDraft({ ...draft, steps: [...draft.steps, step] }, bundle, origin !== "editor")
            return schedule()
          }
          const h = get().history[activeId] ?? { past: [], future: [], lastPush: 0 }
          if (origin === "remote") {
            write(bundle, h, true)
            return schedule()
          }
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
          const intents = Array.isArray(intent) ? intent : [intent]
          const r = applyEdits(get().bundle(), intents)
          if (!r.ok) return r.error
          if (get().draft()) get().applyStep({ kind: "intents", intents }, "user", describe(intents))
          else get().setBundle(r.bundle, "grid")
          return null
        },

        async applyStep(op, author, label, messageId) {
          const cur = get().bundle()
          const r = applyOp(cur, op)
          if (!r.ok) return { ok: false, error: r.error }
          if (sameBundle(cur, r.bundle)) return { ok: true, result: await lastEval }
          let draft = get().draft()
          if (!draft && author === "user") return { ok: true, result: await get().setBundle(r.bundle, "grid") }
          if (!draft) {
            draft = { base: cur, steps: [] }
            set({ baseModel: get().error || get().evaluating ? null : get().model, conflicts: {} })
          }
          const step: DraftStep = { id: uid(), author, label, op, status: author === "ai" ? "pending" : "accepted", messageId, at: Date.now() }
          const before = get().model
          writeDraft({ ...draft, steps: [...draft.steps, step] }, r.bundle)
          const result = await schedule()
          if (result.ok && before) {
            // where this step landed, for jumping to it from the review list
            const touched = touchedCells(diffModels(before, result.model))
            const d = get().draft()
            if (d?.steps.some((st) => st.id === step.id)) {
              const steps = d.steps.map((st) => (st.id === step.id ? { ...st, focus: touched[0], cells: touched.length } : st))
              writeDraft({ ...d, steps }, get().bundle(), false)
            }
          }
          return { ok: true, stepId: step.id, result }
        },

        reviewStep(id, status) {
          const draft = get().draft()
          const step = draft?.steps.find((st) => st.id === id)
          if (!draft || !step || step.status === status) return
          const next = { ...draft, steps: draft.steps.map((st) => (st.id === id ? { ...st, status } : st)) }
          if (step.status === "rejected" || status === "rejected") rebuild(next)
          else writeDraft(next, get().bundle(), false)
          finalize()
        },

        acceptAll() {
          const draft = get().draft()
          if (!draft) return
          writeDraft({ ...draft, steps: draft.steps.map((st) => (st.status === "pending" ? { ...st, status: "accepted" } : st)) }, get().bundle(), false)
          finalize()
        },

        rejectAll() {
          const draft = get().draft()
          if (!draft) return
          rebuild({ ...draft, steps: draft.steps.map((st) => (st.author === "ai" ? { ...st, status: "rejected" } : st)) })
          finalize()
        },

        settle: () => lastEval,

        goTo(sheetName, a) {
          const i = get().model?.sheets.findIndex((sh) => sh.name === sheetName) ?? -1
          const p = parseAddress(a)
          if (i < 0 || !p) return
          if (i !== get().activeSheet) get().setActiveSheet(i)
          if (get().view === "code") set({ view: "split" })
          get().select({ anchor: p, focus: p })
          set({ scrollRequest: { ...p, nonce: Date.now() } })
        },

        undo() {
          const { activeId, history } = get()
          const draft = get().draft()
          if (draft) {
            // inside a draft, undo takes back the latest step, whoever made it
            const steps = draft.steps.slice(0, -1)
            if (steps.length) rebuild({ ...draft, steps })
            else {
              writeDraft(undefined, draft.base)
              set({ baseModel: null, conflicts: {} })
              schedule()
            }
            return
          }
          if (get().files[activeId]?.roomId && collabHooks.undo) return collabHooks.undo()
          const h = history[activeId]
          if (!h?.past.length) return
          const prev = h.past[h.past.length - 1]
          write(prev, { past: h.past.slice(0, -1), future: [get().bundle(), ...h.future], lastPush: 0 }, true)
          schedule()
        },

        redo() {
          if (get().draft()) return
          const { activeId, history } = get()
          if (get().files[activeId]?.roomId && collabHooks.redo) return collabHooks.redo()
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

        setRoom(fileId, roomId, drive) {
          set((s) => (s.files[fileId] ? { files: { ...s.files, [fileId]: { ...s.files[fileId], roomId, drive: roomId ? drive : undefined } } } : s))
        },

        renameFile(fileId, name) {
          set((s) => (s.files[fileId] && s.files[fileId].name !== name ? { files: { ...s.files, [fileId]: { ...s.files[fileId], name } } } : s))
        },

        newFile(bundle, opts) {
          const id = uid()
          set((s) => ({
            files: { ...s.files, [id]: { id, name: opts?.name ?? "Untitled", source: bundle.source, files: bundle.files, updatedAt: Date.now(), roomId: opts?.roomId, drive: opts?.drive } },
            order: [...s.order, id],
            activeId: id,
            activeSheet: 0,
            selection: null,
            selectedBlock: null,
            codeFile: MAIN,
            model: null,
            error: null,
            baseModel: null,
            conflicts: {},
            externalRev: s.externalRev + 1,
          }))
          schedule()
        },

        openFile(id) {
          if (!get().files[id]) return
          set((s) => ({ activeId: id, activeSheet: 0, selection: null, selectedBlock: null, codeFile: MAIN, model: null, error: null, baseModel: null, conflicts: {}, externalRev: s.externalRev + 1 }))
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

const TAB_KEY = "xl2.tab"

/**
 * A new tab starts on an empty workbook (an untouched one if there is one, so they don't pile up); a
 * reload keeps the workbook you were in. Earlier workbooks stay in the menu. Call once, at startup;
 * `opening` is true when the address opens a particular workbook.
 */
export function startTab(opening: boolean) {
  try {
    if (sessionStorage.getItem(TAB_KEY)) return
    sessionStorage.setItem(TAB_KEY, "1")
  } catch {
    return
  }
  if (opening) return
  const s = useStore.getState()
  const blank = s.order.find((id) => {
    const f = s.files[id]
    return !f.roomId && f.source === blankExample && Object.keys(f.files).length === 0
  })
  if (blank) s.openFile(blank)
  else s.newFile({ source: blankExample, files: {} })
}
