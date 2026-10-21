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
import { DriveError, deniedMessage, getDrive, template, type Item, type Me } from "@alexandernygard/drive"
import { collabHooks, MAIN, useStore, type FileDoc } from "./store"

export const drive = getDrive()

// Live collaboration for the active workbook. A workbook in Drive (drive.nyggis.com) connects to the
// drive's room with a ticket that carries the person's access; a workbook shared by link uses this
// app's own Worker, where knowing the id is the permission.
// The Y.Doc holds the bundle as named texts: "main" is the
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
  /** The Drive file, as of the last ticket (name, sharing, your role). */
  driveItem: Item | null
  /** View-only access to a Drive file. */
  readOnly: boolean
  /** The ticket was refused because nobody is signed in. */
  needsSignIn: boolean
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
  driveItem: null,
  readOnly: false,
  needsSignIn: false,
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
let account: Me | null = null
const me = () => {
  if (account) return { name: account.name || account.email, color: colorFor(account.id), id: account.id, picture: account.picture, email: account.email }
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
  const onDrive = !!useStore.getState().files[fileId]?.drive
  let provider!: CollabProvider
  const options = onDrive
    ? drive.roomOptions(
        roomId,
        (t) => {
          useCollab.setState({ driveItem: t.item, readOnly: t.readOnly, needsSignIn: false, failure: null })
          useStore.getState().renameFile(fileId, t.item.name)
        },
        (e: DriveError) => {
          useCollab.setState({ failure: deniedMessage(e), needsSignIn: e.status === 401 })
          setTimeout(() => provider.disconnect())
        },
      )
    : { url: collabUrl(roomId) }
  provider = new CollabProvider(options)
  if (onDrive)
    void drive.me().then(
      (m) => {
        account = m
        setPresence(provider.awareness, { user: me() })
      },
      () => {},
    )
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
    if (map.size === 0 && onDrive) {
      // A Drive file the drive couldn't seed: start from the blank workbook.
      ydoc.transact(() => {
        for (const [name, text] of Object.entries(template("sheet", f?.name ?? "Untitled").files!)) map.set(name, new Y.Text(text))
      }, "seed")
    } else if (map.size === 0 && f && (f.source || Object.keys(f.files).length)) {
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
      useCollab.setState({ roomId: null, status: "off", peers: [], failure: null, canUndo: false, canRedo: false, driveItem: null, readOnly: false, needsSignIn: false })
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

/** Put a local workbook in Drive: it becomes a Drive file you can share with people, and this copy follows it. */
export async function saveToDrive(fileId: string): Promise<Item> {
  const f = useStore.getState().files[fileId]
  if (!f) throw new Error("No such workbook")
  const item = await drive.create({ kind: "sheet", name: f.name, content: { files: toFiles(f) } })
  useStore.getState().setRoom(fileId, item.id, true)
  return item
}

/** Open a Drive file from `?file=<id>`: the local copy if there is one, else a new one that fills in from the room. */
export function openDriveFile(id: string) {
  const s = useStore.getState()
  const existing = s.order.find((f) => s.files[f].drive && s.files[f].roomId === id)
  if (existing) s.openFile(existing)
  else s.newFile({ source: "", files: {} }, { roomId: id, drive: true, name: "Opening…" })
}
