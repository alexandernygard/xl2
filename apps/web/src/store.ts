import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  applyIntents,
  examples,
  locate,
  run,
  type EditIntent,
  type Range,
  type Target,
  type WorkbookError,
  type WorkbookModel,
} from "@xl2/sdk"
import type { GridSelection } from "@xl2/viz"

// One store for the app. The active file's source string is the single source
// of truth; the evaluated model is derived from it on every change.

export type View = "data" | "split" | "code"
export type Origin = "editor" | "grid" | "ai" | "system"

export interface FileDoc {
  id: string
  name: string
  source: string
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
  past: string[]
  future: string[]
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
  error: WorkbookError | null
  history: Record<string, History>
  activeSheet: number
  selection: GridSelection | null
  reveal: (Range & { nonce: number }) | null
  /** Bumped whenever the source changes from outside the code editor. */
  externalRev: number

  source(): string
  setSource(source: string, origin: Origin): void
  applyIntent(intent: EditIntent | EditIntent[]): string | null
  undo(): void
  redo(): void
  recompute(): void
  select(sel: GridSelection | null): void
  revealTarget(target: Target): void
  setActiveSheet(i: number): void
  setView(v: View): void
  setChatOpen(open: boolean): void
  setApiKey(k: string): void
  setAiModel(m: string): void
  newFile(source: string): void
  openFile(id: string): void
  deleteFile(id: string): void
}

const uid = () => Math.random().toString(36).slice(2, 10)

function initialFiles() {
  const files: Record<string, FileDoc> = {}
  const order: string[] = []
  for (const ex of examples.filter((e) => e.id !== "blank")) {
    const id = uid()
    files[id] = { id, name: ex.name, source: ex.source, updatedAt: Date.now() }
    order.push(id)
  }
  return { files, order, activeId: order[0] }
}

const COALESCE_MS = 1200

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      ...initialFiles(),
      view: "split",
      chatOpen: true,
      apiKey: "",
      aiModel: "claude-opus-5-5",

      model: null,
      error: null,
      history: {},
      activeSheet: 0,
      selection: null,
      reveal: null,
      externalRev: 0,

      source: () => get().files[get().activeId]?.source ?? "",

      setSource(source, origin) {
        const { activeId, files } = get()
        const file = files[activeId]
        if (!file || file.source === source) return
        const h = get().history[activeId] ?? { past: [], future: [], lastPush: 0 }
        const now = Date.now()
        // typing in the editor coalesces into one undo step
        const coalesce = origin === "editor" && h.lastOrigin === "editor" && now - h.lastPush < COALESCE_MS
        const past = coalesce ? h.past : [...h.past, file.source].slice(-200)
        const r = run(source)
        set((s) => ({
          files: {
            ...s.files,
            [activeId]: { ...file, source, updatedAt: now, name: r.ok ? r.model.name : file.name },
          },
          history: { ...s.history, [activeId]: { past, future: [], lastPush: now, lastOrigin: origin } },
          model: r.ok ? r.model : s.model,
          error: r.ok ? null : r.error,
          externalRev: origin === "editor" ? s.externalRev : s.externalRev + 1,
          activeSheet: r.ok ? Math.min(s.activeSheet, Math.max(0, r.model.sheets.length - 1)) : s.activeSheet,
        }))
      },

      applyIntent(intent) {
        const r = applyIntents(get().source(), Array.isArray(intent) ? intent : [intent])
        if (!r.ok) return r.error
        get().setSource(r.source, "grid")
        // keep the code view pointed at what was just edited
        const sel = get().selection
        if (sel) get().revealTarget({ type: "cell", ...sel })
        return null
      },

      undo() {
        const { activeId, history, files } = get()
        const h = history[activeId]
        if (!h?.past.length) return
        const prev = h.past[h.past.length - 1]
        const cur = files[activeId].source
        const r = run(prev)
        set((s) => ({
          files: { ...s.files, [activeId]: { ...files[activeId], source: prev, updatedAt: Date.now() } },
          history: { ...s.history, [activeId]: { past: h.past.slice(0, -1), future: [cur, ...h.future], lastPush: 0 } },
          model: r.ok ? r.model : s.model,
          error: r.ok ? null : r.error,
          externalRev: s.externalRev + 1,
        }))
      },

      redo() {
        const { activeId, history, files } = get()
        const h = history[activeId]
        if (!h?.future.length) return
        const [next, ...rest] = h.future
        const cur = files[activeId].source
        const r = run(next)
        set((s) => ({
          files: { ...s.files, [activeId]: { ...files[activeId], source: next, updatedAt: Date.now() } },
          history: { ...s.history, [activeId]: { past: [...h.past, cur], future: rest, lastPush: 0 } },
          model: r.ok ? r.model : s.model,
          error: r.ok ? null : r.error,
          externalRev: s.externalRev + 1,
        }))
      },

      recompute() {
        const r = run(get().source())
        set({ model: r.ok ? r.model : null, error: r.ok ? null : r.error })
      },

      select(sel) {
        set({ selection: sel })
        if (sel) get().revealTarget({ type: "cell", ...sel })
      },

      revealTarget(target) {
        const range = locate(get().source(), target)
        if (range) set({ reveal: { ...range, nonce: Date.now() } })
      },

      setActiveSheet: (i) => set({ activeSheet: i, selection: null }),
      setView: (view) => set({ view }),
      setChatOpen: (chatOpen) => set({ chatOpen }),
      setApiKey: (apiKey) => set({ apiKey }),
      setAiModel: (aiModel) => set({ aiModel }),

      newFile(source) {
        const id = uid()
        const r = run(source)
        set((s) => ({
          files: { ...s.files, [id]: { id, name: r.ok ? r.model.name : "Untitled", source, updatedAt: Date.now() } },
          order: [...s.order, id],
          activeId: id,
          activeSheet: 0,
          selection: null,
          model: r.ok ? r.model : null,
          error: r.ok ? null : r.error,
          externalRev: s.externalRev + 1,
        }))
      },

      openFile(id) {
        if (!get().files[id]) return
        set((s) => ({ activeId: id, activeSheet: 0, selection: null, externalRev: s.externalRev + 1 }))
        get().recompute()
      },

      deleteFile(id) {
        const { order, files, activeId } = get()
        if (order.length <= 1) return
        const rest = order.filter((x) => x !== id)
        const { [id]: _, ...keep } = files
        set({ files: keep, order: rest })
        if (activeId === id) get().openFile(rest[0])
      },
    }),
    {
      name: "xl2",
      version: 1,
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
