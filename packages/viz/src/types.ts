import type { Cell, EditIntent } from "@xl2/sdk"

/** A selected range on a sheet grid: the anchor stays put while the focus moves (shift+arrows). */
export interface GridSelection {
  anchor: Cell
  focus: Cell
}

/** Views never change data themselves; they emit intents for the host to apply to the source. */
export type IntentHandler = (intent: EditIntent | EditIntent[]) => void

export interface ViewContext {
  locale: string
  currency: string
}
