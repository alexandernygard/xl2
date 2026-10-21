import * as React from "react"
import { csvToDataTable, examples, rangeName } from "@xl2/sdk"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Label,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  toast,
} from "@alexandernygard/components"
import {
  ChevronDownIcon,
  CodeIcon,
  FileSpreadsheetIcon,
  Columns2Icon,
  DownloadIcon,
  FileIcon,
  CheckIcon,
  CopyIcon,
  FilePlusIcon,
  MessageSquareIcon,
  Redo2Icon,
  SettingsIcon,
  TableIcon,
  UsersIcon,
  Trash2Icon,
  Undo2Icon,
  UploadIcon,
} from "lucide-react"
import { MAIN, useStore, type View } from "./store"
import { CodeEditor } from "./components/CodeEditor"
import { DataPane } from "./components/DataPane"
import { ChatPanel } from "./components/ChatPanel"
import { fileFromUrl } from "@alexandernygard/drive"
import { DriveFileButton, DriveLogo } from "@alexandernygard/drive/react"
import { closeRoom, drive, newRoomId, openDriveFile, openRoom, saveToDrive, shareLink, useCollab } from "./collab"

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
]

export function App() {
  const view = useStore((s) => s.view)
  const chatOpen = useStore((s) => s.chatOpen)
  const [settings, setSettings] = React.useState(false)
  const activeId = useStore((s) => s.activeId)
  const roomId = useStore((s) => s.files[s.activeId]?.roomId)

  // A shared workbook keeps a live room open while it is the active one.
  React.useEffect(() => {
    if (!roomId) return
    openRoom(activeId, roomId)
    return closeRoom
  }, [activeId, roomId])

  // /?file=<id> opens a workbook from Drive. The address keeps it while it's the active workbook, so a
  // reload or a copied link opens it again.
  React.useEffect(() => {
    const id = fileFromUrl()
    if (id) openDriveFile(id)
  }, [])
  const driveFile = useStore((s) => (s.files[s.activeId]?.drive ? s.files[s.activeId]?.roomId : undefined))
  React.useEffect(() => {
    const url = new URL(location.href)
    if (driveFile) url.searchParams.set("file", driveFile)
    else url.searchParams.delete("file")
    if (url.href !== location.href) history.replaceState(null, "", url)
  }, [driveFile])

  // /?room=<id> joins someone's workbook (once; after that it is a file in your list).
  React.useEffect(() => {
    const id = new URLSearchParams(location.search).get("room")
    if (!id) return
    history.replaceState(null, "", location.pathname)
    const s = useStore.getState()
    const existing = s.order.find((f) => s.files[f].roomId === id)
    if (existing) s.openFile(existing)
    else s.newFile({ source: "", files: {} }, { roomId: id, name: "Shared workbook" })
  }, [])

  React.useEffect(() => {
    useStore.getState().recompute()
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== "z") return
      // the code editor has its own undo history
      if ((e.target as HTMLElement)?.closest?.(".cm-editor, input, textarea, select")) return
      e.preventDefault()
      if (e.shiftKey) useStore.getState().redo()
      else useStore.getState().undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const layout = `${chatOpen ? "c" : ""}${view}`

  return (
    <div className="flex h-full flex-col">
      <Header onOpenSettings={() => setSettings(true)} />
      <DriveNotice />
      <ResizablePanelGroup key={layout} orientation="horizontal" className="min-h-0 flex-1">
        {chatOpen && (
          <>
            <ResizablePanel id="chat" defaultSize="26%" minSize="240px">
              <ChatPanel onOpenSettings={() => setSettings(true)} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        {view !== "code" && (
          <ResizablePanel id="data" defaultSize={view === "split" ? "44%" : "74%"} minSize="320px">
            <DataPane />
          </ResizablePanel>
        )}
        {view === "split" && <ResizableHandle withHandle />}
        {view !== "data" && (
          <ResizablePanel id="code" defaultSize={view === "split" ? "30%" : "74%"} minSize="280px">
            <CodePane />
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      <SettingsDialog open={settings} onOpenChange={setSettings} />
    </div>
  )
}

function CodePane() {
  const name = useStore((s) => s.files[s.activeId]?.name ?? "workbook")
  const bundleFiles = useStore((s) => s.files[s.activeId]?.files)
  const dataFiles = Object.keys(bundleFiles ?? {})
  const codeFile = useStore((s) => s.codeFile)
  const setCodeFile = useStore((s) => s.setCodeFile)
  const tabs = [{ id: MAIN, label: fileName(name), Icon: CodeIcon }, ...dataFiles.map((f) => ({ id: f, label: f, Icon: FileSpreadsheetIcon }))]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-card px-2" role="tablist" aria-label="Files">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={codeFile === id}
            onClick={() => setCodeFile(id)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-3 font-mono text-xs whitespace-nowrap text-muted-foreground hover:text-foreground",
              codeFile === id && "border-border bg-background text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
        <span className="ml-auto self-center pl-3 text-xs whitespace-nowrap text-muted-foreground">Edits in the grid rewrite these files</span>
      </div>
      <div className="min-h-0 flex-1">
        <CodeEditor key={codeFile} file={codeFile} />
      </div>
    </div>
  )
}

const fileName = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workbook"}.xl.ts`

function Header({ onOpenSettings }: { onOpenSettings: () => void }) {
  const view = useStore((s) => s.view)
  const chatOpen = useStore((s) => s.chatOpen)
  const name = useStore((s) => s.files[s.activeId]?.name)
  const shared = useStore((s) => !!s.files[s.activeId]?.roomId)
  const driveId = useStore((s) => (s.files[s.activeId]?.drive ? s.files[s.activeId]?.roomId : undefined))
  const driveItem = useCollab((s) => s.driveItem)
  const peers = useCollab((s) => s.peers)
  const liveUndo = useCollab((s) => s.canUndo)
  const liveRedo = useCollab((s) => s.canRedo)
  const canUndo = useStore((s) => (s.history[s.activeId]?.past.length ?? 0) > 0) || (shared && liveUndo)
  const canRedo = useStore((s) => (s.history[s.activeId]?.future.length ?? 0) > 0) || (shared && liveRedo)
  const [sharing, setSharing] = React.useState(false)
  const { undo, redo, setView, setChatOpen } = useStore.getState()

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
      <div className="flex items-center gap-2 pr-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-highlight">xl</span>
        <span className="font-heading text-base">xl2</span>
      </div>
      <FileMenu name={name ?? "Untitled"} />
      <div className="ml-2 flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Undo <Kbd>⌘Z</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Redo <Kbd>⇧⌘Z</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && setView(v as View)} aria-label="Layout">
          <ToggleGroupItem value="data" aria-label="Grid only">
            <TableIcon /> Grid
          </ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="Side by side">
            <Columns2Icon /> Split
          </ToggleGroupItem>
          <ToggleGroupItem value="code" aria-label="Code only">
            <CodeIcon /> Code
          </ToggleGroupItem>
        </ToggleGroup>
        {driveId ? (
          <>
            <Peers status />
            <DriveFileButton
              fileId={driveId}
              item={driveItem}
              peers={peers.map((p) => p.state.user)}
              onItemChange={(item) => useCollab.setState({ driveItem: item })}
            />
          </>
        ) : (
          <>
            <Peers />
            <Button size="sm" variant={shared ? "secondary" : "ghost"} onClick={() => setSharing(true)}>
              <UsersIcon /> Share
            </Button>
          </>
        )}
        <Button size="sm" variant={chatOpen ? "secondary" : "ghost"} onClick={() => setChatOpen(!chatOpen)} aria-pressed={chatOpen}>
          <MessageSquareIcon /> Assistant
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Settings" onClick={onOpenSettings}>
          <SettingsIcon />
        </Button>
      </div>
      <ShareDialog open={sharing} onOpenChange={setSharing} />
    </header>
  )
}

/** Who else is in this workbook, and whether we are connected. `status` shows only the connection. */
function Peers({ status: statusOnly = false }: { status?: boolean }) {
  const roomId = useCollab((s) => s.roomId)
  const status = useCollab((s) => s.status)
  const peers = useCollab((s) => s.peers)
  if (!roomId) return null
  const dot = status === "live" ? "bg-success" : status === "connecting" ? "bg-warning" : "bg-destructive"
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : status === "failed" ? "Can't connect" : "Offline, changes will sync when you reconnect"
  return (
    <div className="flex items-center gap-2">
      <div className={cn("flex -space-x-1.5", statusOnly && "hidden")}>
        {peers.slice(0, 5).map((p) => (
          <Tooltip key={p.clientId}>
            <TooltipTrigger asChild>
              <span
                className="flex size-6 items-center justify-center rounded-full border-2 border-card text-[10px] font-medium text-white"
                style={{ background: p.state.user.color }}
              >
                {p.state.user.name.slice(0, 1).toUpperCase()}
              </span>
            </TooltipTrigger>
            <TooltipContent>{p.state.user.name}</TooltipContent>
          </Tooltip>
        ))}
        {peers.length > 5 && <span className="flex size-6 items-center justify-center rounded-full border-2 border-card bg-muted text-[10px]">+{peers.length - 5}</span>}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 rounded-full", dot)} /> {statusOnly && status === "live" ? "" : status === "live" ? (peers.length ? `${peers.length + 1} here` : "Live") : label.split(",")[0]}
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function ShareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const activeId = useStore((s) => s.activeId)
  const roomId = useStore((s) => s.files[s.activeId]?.roomId)
  const name = useCollab((s) => s.name)
  const failure = useCollab((s) => s.failure)
  const [copied, setCopied] = React.useState(false)
  const link = roomId ? shareLink(roomId) : ""
  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this workbook</DialogTitle>
          <DialogDescription>
            {roomId
              ? "Anyone with this link can open the workbook and edit it live with you. There are no accounts yet, so only share it with people you trust."
              : "Make this workbook live: others join from a link and you edit together, with each other's cursors visible."}
          </DialogDescription>
        </DialogHeader>
        {failure && <p className="text-sm text-destructive">{failure}</p>}
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3">
          <DriveLogo size={28} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Save to Drive</p>
            <p className="text-xs text-muted-foreground">Share with people by email, choose who can edit, and find it with all your files at drive.nyggis.com.</p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              saveToDrive(activeId).then(
                () => {
                  onOpenChange(false)
                  toast.success("Saved to Drive", { description: "Use Share to add people." })
                },
                (e) => (e?.signedOut ? (location.href = drive.loginUrl()) : toast.error(e?.message ?? "Couldn't save to Drive")),
              )
            }
          >
            Save
          </Button>
        </div>
        {roomId ? (
          <div className="flex gap-2">
            <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <Button variant="outline" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="collab-name">Your name</Label>
          <Input id="collab-name" value={name} onChange={(e) => useCollab.getState().setName(e.target.value)} placeholder="Shown next to your cursor" />
        </div>
        <DialogFooter>
          {roomId ? (
            <Button variant="outline" onClick={() => (useStore.getState().setRoom(activeId, undefined), onOpenChange(false))}>
              Stop sharing
            </Button>
          ) : (
            <Button onClick={() => useStore.getState().setRoom(activeId, newRoomId())}>Start sharing</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FileMenu({ name }: { name: string }) {
  const files = useStore((s) => s.files)
  const order = useStore((s) => s.order)
  const activeId = useStore((s) => s.activeId)
  const { newFile, openFile, deleteFile } = useStore.getState()
  const csvInput = React.useRef<HTMLInputElement>(null)

  const save = (text: string, file: string, type: string) => {
    const blob = new Blob([text], { type })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = file
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const download = () => {
    const b = useStore.getState().bundle()
    save(b.source, fileName(name), "text/typescript")
    for (const [f, text] of Object.entries(b.files)) save(text, f, "text/csv")
  }

  const importCsv = async (file: File) => {
    const text = await file.text()
    const base = file.name.replace(/\.[^.]+$/, "")
    const tableName = base.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/^\d/, "t$&") || "data"
    const s = useStore.getState()
    const sheetName = base.slice(0, 30) || "Imported"
    if (s.model?.sheets.some((x) => x.name === sheetName)) return void toast.error(`A sheet named "${sheetName}" already exists`)
    let table: ReturnType<typeof csvToDataTable>
    try {
      table = csvToDataTable(tableName, text, { at: rangeName({ row: 0, col: 0, rows: 1, cols: 1 }) })
    } catch (e) {
      return void toast.error(String((e as Error).message))
    }
    const err = s.applyIntent([
      { type: "addDataFile", file: table.file, text: table.data },
      { type: "addSheet", name: sheetName },
      { type: "addBlock", sheet: sheetName, code: table.code },
    ])
    if (err) toast.error(err)
    else {
      s.setActiveSheet(s.model?.sheets.length ?? 0)
      toast.success(`Imported ${file.name} as table "${tableName}" backed by ${table.file}`)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 font-medium">
            <FileIcon /> {name} <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Workbooks</DropdownMenuLabel>
          {order.map((id) => (
            <DropdownMenuItem key={id} onSelect={() => openFile(id)} className={id === activeId ? "font-medium" : undefined}>
              <FileIcon /> {files[id].name}
              {id === activeId && <span className="ml-auto size-1.5 rounded-full bg-highlight" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FilePlusIcon /> New workbook
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {examples.map((ex) => (
                <DropdownMenuItem key={ex.id} onSelect={() => newFile({ source: ex.source, files: { ...ex.files } })}>
                  {ex.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => csvInput.current?.click()}>
            <UploadIcon /> Import CSV as sheet
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={download}>
            <DownloadIcon /> Download files
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={order.length <= 1} onSelect={() => deleteFile(activeId)}>
            <Trash2Icon /> Delete workbook
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={csvInput}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) importCsv(f)
          e.target.value = ""
        }}
      />
    </>
  )
}

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const apiKey = useStore((s) => s.apiKey)
  const aiModel = useStore((s) => s.aiModel)
  const [key, setKey] = React.useState(apiKey)
  const [model, setModel] = React.useState(aiModel)
  React.useEffect(() => {
    if (open) {
      setKey(apiKey)
      setModel(aiModel)
    }
  }, [open, apiKey, aiModel])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assistant settings</DialogTitle>
          <DialogDescription>
            The key stays in this browser (localStorage) and is sent only to api.anthropic.com. There is no server.
          </DialogDescription>
        </DialogHeader>
        <form
          id="settings"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            useStore.getState().setApiKey(key.trim())
            useStore.getState().setAiModel(model)
            onOpenChange(false)
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="api-key">Anthropic API key</Label>
            <Input id="api-key" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="model">Model</Label>
            <select id="model" className="h-8 rounded-lg border bg-background px-2 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="settings">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Why a Drive workbook isn't open (signed out, no access), or that you can only view it. */
function DriveNotice() {
  const failure = useCollab((s) => s.failure)
  const needsSignIn = useCollab((s) => s.needsSignIn)
  const readOnly = useCollab((s) => s.readOnly)
  const onDrive = useStore((s) => !!s.files[s.activeId]?.drive)
  if (!onDrive || (!failure && !readOnly)) return null
  return (
    <div className={cn("flex items-center gap-3 border-b px-4 py-2 text-sm", failure ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
      <DriveLogo size={18} />
      <span className="flex-1">{failure ?? "You can view this workbook. Ask the owner for edit access to make changes."}</span>
      {needsSignIn && (
        <Button size="sm" asChild>
          <a href={drive.loginUrl()}>Sign in</a>
        </Button>
      )}
    </div>
  )
}
