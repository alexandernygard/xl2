import type { EditIntent } from "@xl2/sdk"

/** A selected cell in a table block. */
export interface GridSelection {
  table: string
  row: number
  column: string
}

/** Views never change data themselves; they emit intents for the host to apply to the source. */
export type IntentHandler = (intent: EditIntent | EditIntent[]) => void

export interface ViewContext {
  locale: string
  currency: string
}
