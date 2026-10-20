import type { TsCompletion, TsDiagnostic, TsRequest } from "./ts.worker"

// Main-thread side of the TypeScript worker. Created on first use, since
// loading the compiler is the expensive part.

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (r: unknown) => void>()

type Req = TsRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never

function request<T>(req: Req): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./ts.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const done = pending.get(e.data.id)
      pending.delete(e.data.id)
      done?.(e.data.error ? null : e.data.result)
    }
  }
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve as (r: unknown) => void)
    worker!.postMessage({ ...req, id })
  })
}

export const tsDiagnostics = (code: string) => request<TsDiagnostic[] | null>({ type: "diagnostics", code })
export const tsCompletions = (code: string, pos: number) =>
  request<{ from?: number; options: TsCompletion[] } | null>({ type: "completions", code, pos })
export const tsHover = (code: string, pos: number) =>
  request<{ from: number; to: number; text: string; doc: string } | null>({ type: "hover", code, pos })
