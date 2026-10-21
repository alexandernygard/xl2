import type { Cell, EditIntent } from "@xl2/sdk"

/** A selected range on a sheet grid: the anchor stays put while the focus moves (shift+arrows). */
export interface GridSelection {
  anchor: Cell
  focus: Cell
}

/** Someone else's selection on this sheet, drawn in their colour with their name. */
export interface GridPeer {
  id: string | number
  name: string
  color: string
  selection: GridSelection
}

/** Views never change data themselves; they emit intents for the host to apply to the source. */
export type IntentHandler = (intent: EditIntent | EditIntent[]) => void

export interface ViewContext {
  locale: string
  currency: string
}
