import type { Bundle, WorkbookModel } from "@xl2/sdk"
import type { EvalRequest } from "./eval.worker"

// Main-thread side of the evaluation worker. Requests run in order; if one
// takes longer than TIMEOUT_MS (an infinite loop, say) the worker is killed
// and replaced, and that request fails with a timeout error.

export interface EvalError {
  message: string
  line?: number
  column?: number
}

export type EvalResult = { ok: true; model: WorkbookModel; ms: number } | { ok: false; error: EvalError; ms?: number }

const TIMEOUT_MS = 3000

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (r: EvalResult) => void; timer: number }>()

function spawn() {
  const w = new Worker(new URL("./eval.worker.ts", import.meta.url), { type: "module" })
  w.onmessage = (e: MessageEvent<EvalResult & { id: number }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    window.clearTimeout(p.timer)
    pending.delete(e.data.id)
    p.resolve(e.data)
  }
  w.onerror = (e) => {
    e.preventDefault()
    fail(`Evaluation crashed: ${e.message}`)
  }
  return w
}

function fail(message: string) {
  worker?.terminate()
  worker = null
  for (const [, p] of pending) {
    window.clearTimeout(p.timer)
    p.resolve({ ok: false, error: { message } })
  }
  pending.clear()
}

export function evaluateBundle(bundle: Bundle): Promise<EvalResult> {
  worker ??= spawn()
  const id = ++seq
  return new Promise((resolve) => {
    // the timer starts when the worker is free, so queued requests don't time out early
    const start = () =>
      window.setTimeout(
        () => fail(`The workbook took longer than ${TIMEOUT_MS / 1000}s to evaluate and was stopped. Is there an infinite loop?`),
        TIMEOUT_MS * (pending.size + 1),
      )
    pending.set(id, { resolve, timer: start() })
    worker!.postMessage({ id, source: bundle.source, files: bundle.files } satisfies EvalRequest)
  })
}
