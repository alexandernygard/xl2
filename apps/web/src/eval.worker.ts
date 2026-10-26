/// <reference lib="webworker" />
import { run } from "@xl2/sdk/runtime"

// Runs workbook code off the main thread. The page's localStorage isn't
// reachable from a worker, a runaway loop only stalls this worker (the
// app restarts it), and network APIs are removed before any workbook runs.

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel"]) {
  try {
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false })
  } catch {
    // some globals are not configurable; nothing else to do
  }
}

export interface EvalRequest {
  id: number
  source: string
  files: Record<string, string>
}

self.onmessage = (e: MessageEvent<EvalRequest>) => {
  const { id, source, files } = e.data
  const started = performance.now()
  const r = run(source, files)
  const ms = performance.now() - started
  if (r.ok) self.postMessage({ id, ok: true, model: r.model, ms })
  else self.postMessage({ id, ok: false, error: { message: r.error.message, line: r.error.line, column: r.error.column }, ms })
}
