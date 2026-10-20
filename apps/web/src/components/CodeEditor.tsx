import * as React from "react"
import { basicSetup } from "codemirror"
import { EditorView, Decoration, hoverTooltip, keymap, type DecorationSet } from "@codemirror/view"
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete"
import { Annotation, EditorState, StateEffect, StateField } from "@codemirror/state"
import { indentWithTab } from "@codemirror/commands"
import { javascript } from "@codemirror/lang-javascript"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint"
import { tags as t } from "@lezer/highlight"
import { MAIN, useStore } from "../store"
import { tsCompletions, tsDiagnostics, tsHover } from "../tsClient"

const external = Annotation.define<boolean>()

const flash = StateEffect.define<{ from: number; to: number } | null>()
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(flash)) deco = e.value ? Decoration.set([Decoration.mark({ class: "cm-flash" }).range(e.value.from, e.value.to)]) : Decoration.none
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--card)", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--highlight) 30%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "8px" },
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword], color: "var(--chart-2)" },
  { tag: [t.string, t.special(t.string)], color: "var(--positive)" },
  { tag: [t.number, t.bool, t.null], color: "var(--chart-1)" },
  { tag: [t.comment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--info)" },
  { tag: [t.propertyName], color: "var(--foreground)" },
  { tag: [t.typeName], color: "var(--warning)" },
  { tag: [t.operator, t.punctuation], color: "var(--muted-foreground)" },
])

// --- TypeScript checking (workbook code only) ----------------------------------

/** The runtime error from evaluation, placed at its line, plus the type checker's findings. */
const workbookLinter = linter(
  async (view) => {
    const code = view.state.doc.toString()
    const out: Diagnostic[] = []
    const error = useStore.getState().error
    if (error) {
      const doc = view.state.doc
      const pos = error.line ? doc.line(Math.min(error.line, doc.lines)).from + Math.max(0, (error.column ?? 1) - 1) : 0
      const from = Math.min(pos, doc.length)
      out.push({ from, to: Math.min(from + 1, doc.length), severity: "error", message: error.message, source: "run" })
    }
    const ts = await tsDiagnostics(code)
    if (view.state.doc.toString() !== code) return out
    for (const d of ts ?? []) {
      const from = Math.min(d.from, view.state.doc.length)
      out.push({ from, to: Math.min(Math.max(d.to, from), view.state.doc.length), severity: d.severity, message: d.message, source: "ts" })
    }
    return out
  },
  { delay: 350 },
)

const KIND: Record<string, Completion["type"]> = {
  function: "function",
  method: "method",
  property: "property",
  "local var": "variable",
  var: "variable",
  let: "variable",
  const: "constant",
  parameter: "variable",
  class: "class",
  interface: "interface",
  type: "type",
  alias: "type",
  keyword: "keyword",
  string: "text",
  module: "namespace",
}

async function tsCompletionSource(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[\w$]*/)
  if (!word) return null
  const before = ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from)
  const inString = /["'`]$/.test(before)
  if (word.from === word.to && !ctx.explicit && before !== "." && !inString) return null
  const res = await tsCompletions(ctx.state.doc.toString(), ctx.pos)
  if (!res || ctx.aborted) return null
  return {
    from: res.from ?? word.from,
    options: res.options.map((o) => ({ label: o.label, type: KIND[o.kind] ?? "variable" })),
    validFor: /^[\w$]*$/,
  }
}

const tsHoverTooltip = hoverTooltip(async (view, pos) => {
  const q = await tsHover(view.state.doc.toString(), pos)
  if (!q) return null
  return {
    pos: q.from,
    end: q.to,
    above: true,
    create() {
      const dom = document.createElement("div")
      dom.className = "cm-ts-hover"
      const sig = document.createElement("code")
      sig.textContent = q.text
      dom.append(sig)
      if (q.doc) {
        const p = document.createElement("p")
        p.textContent = q.doc
        dom.append(p)
      }
      return { dom }
    },
  }
})

/** Minimal change between two strings, so cursor and undo survive external edits. */
function diff(a: string, b: string) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { from: start, to: endA, insert: b.slice(start, endB) }
}

const fileText = (file: string) => {
  const b = useStore.getState().bundle()
  return file === MAIN ? b.source : (b.files[file] ?? "")
}

/** Edits one file of the bundle: the workbook code (TypeScript) or a CSV data file. */
export function CodeEditor({ file }: { file: string }) {
  const host = React.useRef<HTMLDivElement>(null)
  const view = React.useRef<EditorView | null>(null)
  const timer = React.useRef<number>(0)
  const externalRev = useStore((s) => s.externalRev)
  const reveal = useStore((s) => s.reveal)
  const error = useStore((s) => s.error)

  React.useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: fileText(file),
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          keymap.of([indentWithTab]),
          file === MAIN
            ? [javascript({ typescript: true }), workbookLinter, autocompletion({ override: [tsCompletionSource] }), tsHoverTooltip]
            : [],
          syntaxHighlighting(highlight),
          theme,
          flashField,
          lintGutter(),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => useStore.getState().setFileText(file, u.state.doc.toString(), "editor"), 200)
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      window.clearTimeout(timer.current)
      v.destroy()
    }
  }, [file])

  // apply source changes made elsewhere (grid, AI, undo)
  React.useEffect(() => {
    const v = view.current
    if (!v) return
    const next = fileText(file)
    const cur = v.state.doc.toString()
    if (next !== cur) {
      window.clearTimeout(timer.current)
      v.dispatch({ changes: diff(cur, next), annotations: external.of(true) })
    }
  }, [externalRev, file])

  // re-lint when the evaluation result changes, so the runtime error marker follows it
  React.useEffect(() => {
    if (view.current && file === MAIN) forceLinting(view.current)
  }, [error, file])

  // scroll to and flash a range (e.g. the selected cell's literal)
  React.useEffect(() => {
    const v = view.current
    if (!v || !reveal || (reveal.file ?? MAIN) !== file) return
    const len = v.state.doc.length
    const from = Math.min(reveal.start, len)
    const to = Math.min(reveal.end, len)
    v.dispatch({ effects: [flash.of({ from, to }), EditorView.scrollIntoView(from, { y: "center", x: "nearest" })], annotations: external.of(true) })
    const id = window.setTimeout(() => v.dispatch({ effects: flash.of(null), annotations: external.of(true) }), 1600)
    return () => window.clearTimeout(id)
  }, [reveal, file])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="code-editor" />
}
