import * as React from "react"
import { basicSetup } from "codemirror"
import { EditorView, Decoration, keymap, type DecorationSet } from "@codemirror/view"
import { Annotation, EditorState, StateEffect, StateField } from "@codemirror/state"
import { indentWithTab } from "@codemirror/commands"
import { javascript } from "@codemirror/lang-javascript"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint"
import { tags as t } from "@lezer/highlight"
import { useStore } from "../store"

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

export function CodeEditor() {
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
        doc: useStore.getState().source(),
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          keymap.of([indentWithTab]),
          javascript({ typescript: true }),
          syntaxHighlighting(highlight),
          theme,
          flashField,
          lintGutter(),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => useStore.getState().setSource(u.state.doc.toString(), "editor"), 200)
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      window.clearTimeout(timer.current)
      v.destroy()
    }
  }, [])

  // apply source changes made elsewhere (grid, AI, undo)
  React.useEffect(() => {
    const v = view.current
    if (!v) return
    const next = useStore.getState().source()
    const cur = v.state.doc.toString()
    if (next !== cur) {
      window.clearTimeout(timer.current)
      v.dispatch({ changes: diff(cur, next), annotations: external.of(true) })
    }
  }, [externalRev])

  // show the compile error, if any, at its position
  React.useEffect(() => {
    const v = view.current
    if (!v) return
    const diagnostics: Diagnostic[] = []
    if (error) {
      const doc = v.state.doc
      const pos = error.line ? doc.line(Math.min(error.line, doc.lines)).from + Math.max(0, (error.column ?? 1) - 1) : 0
      const from = Math.min(pos, doc.length)
      diagnostics.push({ from, to: Math.min(from + 1, doc.length), severity: "error", message: error.message })
    }
    v.dispatch(setDiagnostics(v.state, diagnostics))
  }, [error])

  // scroll to and flash a range (e.g. the selected cell's literal)
  React.useEffect(() => {
    const v = view.current
    if (!v || !reveal) return
    const len = v.state.doc.length
    const from = Math.min(reveal.start, len)
    const to = Math.min(reveal.end, len)
    v.dispatch({ effects: [flash.of({ from, to }), EditorView.scrollIntoView(from, { y: "center", x: "nearest" })], annotations: external.of(true) })
    const id = window.setTimeout(() => v.dispatch({ effects: flash.of(null), annotations: external.of(true) }), 1600)
    return () => window.clearTimeout(id)
  }, [reveal])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="code-editor" />
}
