import { transform } from "sucrase"
import * as builders from "./builders"
import { evaluate, type WorkbookModel } from "./engine"
import type { WorkbookDef } from "./types"

// Runs workbook source (TypeScript) in the current JS realm. The only
// importable module is "@xl2/sdk". Code runs unsandboxed: fine for your own
// workbooks, but see the README for the trust model.

export class WorkbookError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message)
  }
}

const MODULES: Record<string, unknown> = {
  "@xl2/sdk": builders,
  xl2: builders,
}

export function compile(source: string): string {
  try {
    return transform(source, { transforms: ["typescript", "imports"], production: true }).code
  } catch (e: any) {
    const m = /\((\d+):(\d+)\)/.exec(e?.message ?? "")
    throw new WorkbookError(`Syntax error: ${e?.message ?? e}`, m ? +m[1] : undefined, m ? +m[2] : undefined)
  }
}

/** Execute source and return its default-exported workbook definition. */
export function load(source: string): WorkbookDef {
  const code = compile(source)
  const module = { exports: {} as any }
  const require = (id: string) => {
    if (id in MODULES) return MODULES[id]
    throw new WorkbookError(`Cannot import "${id}". Only "@xl2/sdk" is available.`)
  }
  try {
    new Function("require", "module", "exports", code)(require, module, module.exports)
  } catch (e: any) {
    if (e instanceof WorkbookError) throw e
    throw new WorkbookError(`Runtime error: ${e?.message ?? e}`)
  }
  const def = module.exports.default ?? module.exports
  if (!def || def.type !== "workbook") {
    throw new WorkbookError("The file must `export default workbook(...)`")
  }
  return def as WorkbookDef
}

export type RunResult =
  | { ok: true; def: WorkbookDef; model: WorkbookModel }
  | { ok: false; error: WorkbookError }

/** Load + evaluate, never throws. */
export function run(source: string): RunResult {
  try {
    const def = load(source)
    return { ok: true, def, model: evaluate(def) }
  } catch (e: any) {
    return { ok: false, error: e instanceof WorkbookError ? e : new WorkbookError(String(e?.message ?? e)) }
  }
}
