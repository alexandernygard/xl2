/// <reference lib="webworker" />
import ts from "typescript"
import { libs, sdk } from "virtual:ts-env"

// A TypeScript language service for the workbook file, checked against the
// SDK's real authoring types. Runs in its own worker so typing stays smooth.

const MAIN = "/workbook.ts"

const files = new Map<string, string>()
for (const [name, text] of Object.entries(libs as Record<string, string>)) files.set(`/lib/${name}`, text)
for (const [name, text] of Object.entries(sdk as Record<string, string>)) files.set(`/sdk/${name}`, text)
files.set("/sdk/index.ts", 'export * from "./builders"\nexport * from "./types"\n')
// workbook code has no DOM, but console works in the evaluation worker
files.set("/env.d.ts", "declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }\n")
files.set(MAIN, "")
const versions = new Map<string, number>()

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  strict: false,
  noImplicitAny: false,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  baseUrl: "/",
  paths: { "@xl2/sdk": ["/sdk/index.ts"], xl2: ["/sdk/index.ts"] },
}

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [MAIN, "/env.d.ts"],
  getScriptVersion: (f) => String(versions.get(f) ?? 0),
  getScriptSnapshot: (f) => {
    const text = files.get(f)
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
  },
  getCurrentDirectory: () => "/",
  getCompilationSettings: () => options,
  getDefaultLibFileName: () => "/lib/lib.es2022.d.ts",
  fileExists: (f) => files.has(f),
  readFile: (f) => files.get(f),
  directoryExists: (d) => [...files.keys()].some((k) => k.startsWith(d.endsWith("/") ? d : d + "/")),
  getDirectories: () => [],
}

const service = ts.createLanguageService(host, ts.createDocumentRegistry())

function update(code: string) {
  if (files.get(MAIN) === code) return
  files.set(MAIN, code)
  versions.set(MAIN, (versions.get(MAIN) ?? 0) + 1)
}

export type TsRequest =
  | { id: number; type: "diagnostics"; code: string }
  | { id: number; type: "completions"; code: string; pos: number }
  | { id: number; type: "hover"; code: string; pos: number }

export interface TsDiagnostic {
  from: number
  to: number
  message: string
  severity: "error" | "warning"
}

export interface TsCompletion {
  label: string
  kind: string
  detail?: string
}

const flatten = (m: string | ts.DiagnosticMessageChain) => ts.flattenDiagnosticMessageText(m, "\n")

self.onmessage = (e: MessageEvent<TsRequest>) => {
  const req = e.data
  update(req.code)
  try {
    if (req.type === "diagnostics") {
      const all = [...service.getSyntacticDiagnostics(MAIN), ...service.getSemanticDiagnostics(MAIN)]
      const out: TsDiagnostic[] = all.map((d) => ({
        from: d.start ?? 0,
        to: (d.start ?? 0) + (d.length ?? 1),
        message: flatten(d.messageText),
        severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      }))
      self.postMessage({ id: req.id, result: out })
    } else if (req.type === "completions") {
      const info = service.getCompletionsAtPosition(MAIN, req.pos, { includeCompletionsWithInsertText: true })
      const out: TsCompletion[] = (info?.entries ?? [])
        .filter((en) => en.kind !== ts.ScriptElementKind.keyword || info!.entries.length < 200)
        .slice(0, 400)
        .map((en) => ({ label: en.name, kind: en.kind }))
      self.postMessage({ id: req.id, result: { from: info?.optionalReplacementSpan?.start, options: out } })
    } else {
      const q = service.getQuickInfoAtPosition(MAIN, req.pos)
      self.postMessage({
        id: req.id,
        result: q
          ? {
              from: q.textSpan.start,
              to: q.textSpan.start + q.textSpan.length,
              text: ts.displayPartsToString(q.displayParts),
              doc: ts.displayPartsToString(q.documentation ?? []),
            }
          : null,
      })
    }
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err) })
  }
}
