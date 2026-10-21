import { create } from "zustand"
import * as Y from "yjs"
import {
  CollabProvider,
  bindFiles,
  collabUrl,
  colorFor,
  createUndoManager,
  filesMap,
  getPeers,
  setPresence,
  throttle,
  type Peer,
  type TextFiles,
} from "@alexandernygard/collab"
import { collabHooks, MAIN, useStore, type FileDoc } from "./store"

// Live collaboration for the active workbook. The Y.Doc holds the bundle as named texts: "main" is the
// workbook code, every other key is a CSV data file. The store stays the source the rest of the app reads;
// bindFiles keeps the two equal, and edits from others arrive through setBundle(…, "remote").

export interface XlPresence {
  /** Where this person's selection is. */
  cell?: { sheet: string; anchor: { row: number; col: number }; focus: { row: number; col: number } }
}

interface CollabState {
  roomId: string | null
  status: "off" | "connecting" | "live" | "offline" | "failed"
  failure: string | null
  peers: Peer<XlPresence>[]
  canUndo: boolean
  canRedo: boolean
  name: string
  setName(name: string): void
}

const NAME_KEY = "xl2.name"
const loadName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || `Guest ${100 + Math.floor(Math.random() * 900)}`
  } catch {
    return "Guest"
  }
}

export const useCollab = create<CollabState>()((set) => ({
  roomId: null,
  status: "off",
  failure: null,
  peers: [],
  canUndo: false,
  canRedo: false,
  name: loadName(),
  setName(name) {
    set({ name })
    try {
      localStorage.setItem(NAME_KEY, name)
    } catch {}
    session?.provider && setPresence(session.provider.awareness, { user: me() })
  },
}))

// One id per browser tab, so your own other tabs show up as separate people.
const tabId = Math.random().toString(36).slice(2, 8)
const me = () => {
  const name = useCollab.getState().name
  return { name, color: colorFor(tabId), id: tabId }
}

/** 22 random base64url characters (128 bits). Knowing the id is the permission to edit. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const shareLink = (roomId: string) => `${location.origin}/?room=${roomId}`

const toFiles = (f: Pick<FileDoc, "source" | "files">): TextFiles => ({ [MAIN]: f.source, ...f.files })
const fromFiles = (t: TextFiles) => {
  const { [MAIN]: source = "", ...files } = t
  return { source, files }
}

interface Session {
  roomId: string
  doc: Y.Doc
  provider: CollabProvider
  stop(): void
  undo(): void
  redo(): void
}
let session: Session | null = null

function start(fileId: string, roomId: string): Session {
  const provider = new CollabProvider({ url: collabUrl(roomId) })
  const ydoc = provider.doc
  const map = filesMap(ydoc)
  const undoManager = createUndoManager(map)
  const cleanups: (() => void)[] = []
  let unbind: (() => void) | null = null

  const syncUndo = () => useCollab.setState({ canUndo: undoManager.undoStack.length > 0, canRedo: undoManager.redoStack.length > 0 })
  for (const ev of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const) {
    undoManager.on(ev, syncUndo)
    cleanups.push(() => undoManager.off(ev, syncUndo))
  }

  const file = () => useStore.getState().files[fileId]
  const bind = () => {
    // Called once, after the first sync, so nothing is pushed on top of content we have not received yet.
    const f = file()
    if (map.size === 0 && f && (f.source || Object.keys(f.files).length)) {
      // A new room: the creator's copy becomes the document.
      ydoc.transact(() => {
        for (const [name, text] of Object.entries(toFiles(f))) map.set(name, new Y.Text(text))
      }, "seed")
    }
    unbind = bindFiles(
      map,
      {
        get: () => {
          const f = file()
          return f ? toFiles(f) : {}
        },
        set: (files) => useStore.getState().setBundle(fromFiles(files), "remote"),
        subscribe: (fn) =>
          useStore.subscribe((s, prev) => {
            const a = s.files[fileId]
            const b = prev.files[fileId]
            if (a && (a.source !== b?.source || a.files !== b?.files)) fn(toFiles(a))
          }),
      },
      { undoManager },
    )
  }

  const status = () => {
    const s = provider.status
    useCollab.setState({ status: s === "connected" ? (provider.synced ? "live" : "connecting") : s === "failed" ? "failed" : s === "connecting" ? "connecting" : "offline" })
  }
  cleanups.push(
    provider.on("status", status),
    provider.on("synced", (synced) => {
      status()
      if (synced && !unbind) bind()
    }),
    provider.on("fatal", (code, reason) => useCollab.setState({ failure: code === 4426 ? "This version of xl2 is out of date. Refresh the page." : reason || "Could not open the shared workbook." })),
  )

  const peers = () => useCollab.setState({ peers: getPeers<XlPresence>(provider.awareness) })
  provider.awareness.on("change", peers)
  cleanups.push(() => provider.awareness.off("change", peers))

  // Publish where my selection is.
  const publish = throttle(() => {
    const s = useStore.getState()
    const sheet = s.model?.sheets[s.activeSheet]
    setPresence<XlPresence>(provider.awareness, { user: me(), cell: s.selection && sheet ? { sheet: sheet.name, ...s.selection } : undefined })
  }, 60)
  setPresence<XlPresence>(provider.awareness, { user: me() })
  cleanups.push(useStore.subscribe((s, prev) => (s.selection !== prev.selection || s.activeSheet !== prev.activeSheet || s.model !== prev.model) && publish()))

  useCollab.setState({ roomId, status: "connecting", failure: null, peers: [], canUndo: false, canRedo: false })
  status()

  return {
    roomId,
    doc: ydoc,
    provider,
    undo: () => undoManager.undo(),
    redo: () => undoManager.redo(),
    stop() {
      unbind?.()
      for (const c of cleanups) c()
      undoManager.destroy()
      provider.destroy()
      useCollab.setState({ roomId: null, status: "off", peers: [], failure: null, canUndo: false, canRedo: false })
    },
  }
}

export function openRoom(fileId: string, roomId: string) {
  if (session?.roomId === roomId) return
  closeRoom()
  session = start(fileId, roomId)
}

export function closeRoom() {
  session?.stop()
  session = null
}

collabHooks.undo = () => session?.undo()
collabHooks.redo = () => session?.redo()
