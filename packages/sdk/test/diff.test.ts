import { describe, expect, it } from "vitest"
import { applyEdit, diffModels, replay, run, textEdit, touchedCells, type Bundle, type EditIntent, type StepOp } from "../src"

const src = `import { workbook, sheet, table, col, param, metric } from "@xl2/sdk"

export default workbook("D", [
  sheet("Main", [
    param("growth", 0.1, { at: "A1", label: "Growth" }),
    table("sales", {
      at: "A3",
      columns: {
        region: col.text(),
        units: col.number(),
        next: col.formula((r, ctx) => r.units * (1 + ctx.param("growth"))),
      },
      rows: [["N", 10], ["S", 20]],
      totals: { units: "sum" },
    }),
    metric("Units", (ctx) => ctx.table("sales").sum("units"), { at: "F1" }),
  ], { cells: { E1: 5, E2: "=E1 * 2" } }),
])
`

const base: Bundle = { source: src, files: {} }

function model(b: Bundle) {
  const r = run(b.source, b.files)
  if (!r.ok) throw r.error
  return r.model
}

function edit(b: Bundle, ...intents: EditIntent[]) {
  for (const i of intents) {
    const r = applyEdit(b, i)
    if (!r.ok) throw new Error(r.error)
    b = r.bundle
  }
  return b
}

describe("diffModels", () => {
  it("separates edited inputs from computed consequences", () => {
    const after = edit(base, { type: "setCell", table: "sales", row: 0, column: "units", value: 15 })
    const d = diffModels(model(base), model(after))
    const cells = d.sheets[0].cells
    // sales starts at A3: title, header, then rows 5 and 6; units is column B
    expect(cells.B5).toEqual({ kind: "edited", was: "10" })
    expect(cells.C5.kind).toBe("computed")
    expect(cells.B8.kind).toBe("computed") // totals row, below the add row
    expect(cells.C6).toBeUndefined()
    // the units total repeats the metric's numbers, so only the metric is listed
    expect(d.impact).toEqual([{ label: "Units", before: "30", after: "35" }])
    expect(touchedCells(d)).toEqual([{ sheet: "Main", address: "B5" }])
  })

  it("marks params, free cells, added rows and columns", () => {
    const after = edit(
      base,
      { type: "setParam", name: "growth", value: 0.2 },
      { type: "setFreeCell", sheet: "Main", address: "E1", value: 6 },
      { type: "setFreeCell", sheet: "Main", address: "H1", value: "new" },
      { type: "addRow", table: "sales", values: { region: "E", units: 5 } },
      { type: "addColumn", table: "sales", column: "note", kind: "text" },
    )
    const c = diffModels(model(base), model(after)).sheets[0].cells
    expect(c.B1.kind).toBe("edited")
    expect(c.E1).toEqual({ kind: "edited", was: "5" })
    expect(c.E2).toEqual({ kind: "computed", was: "10" })
    expect(c.H1.kind).toBe("added")
    expect(c.A7.kind).toBe("added") // the new row
    expect(c.D4.kind).toBe("added") // the new column's header
  })

  it("reports removed cells and rows, and moved blocks", () => {
    const after = edit(
      base,
      { type: "setFreeCell", sheet: "Main", address: "E1", value: null },
      { type: "deleteRow", table: "sales", row: 1 },
      { type: "moveBlock", sheet: "Main", index: 2, at: "H1" },
    )
    const d = diffModels(model(base), model(after))
    expect(d.sheets[0].cells.E1).toEqual({ kind: "removed", was: "5" })
    expect(d.notes).toContain('table "sales": 1 row removed')
    expect(d.notes).toContain('Moved metric "Units"')
  })
})

describe("replay", () => {
  it("leaves out a rejected step and replays the rest", () => {
    const steps: StepOp[] = [
      { kind: "intents", intents: [{ type: "setCell", table: "sales", row: 0, column: "units", value: 11 }] },
      { kind: "replace", file: "main", old: '"Growth"', new: '"Growth rate"' },
      { kind: "intents", intents: [{ type: "setFreeCell", sheet: "Main", address: "E1", value: 7 }] },
    ]
    const r = replay(base, [steps[0], null, steps[2]])
    expect(r.failed.size).toBe(0)
    expect(r.bundle.source).toContain("[\"N\", 11]")
    expect(r.bundle.source).toContain('label: "Growth"')
    expect(r.bundle.source).toContain("E1: 7")
  })

  it("fails a step that depends on a rejected one", () => {
    const add: StepOp = { kind: "replace", file: "main", old: '"Growth"', new: '"Growth rate"' }
    const dependent: StepOp = { kind: "replace", file: "main", old: '"Growth rate"', new: '"Rate"' }
    const r = replay(base, [null, dependent])
    expect(r.failed.has(1)).toBe(true)
    expect(replay(base, [add, dependent]).bundle.source).toContain('"Rate"')
  })

  it("textEdit records a minimal edit that replays after other edits", () => {
    const edited = src.replace("E1: 5", "E1: 50")
    const op = textEdit("main", src, edited)!
    expect(op.kind).toBe("replace")
    // an earlier, unrelated change shifts positions; the op still applies by content
    const shifted = { ...base, source: "// note\n" + src }
    const r = replay(shifted, [op])
    expect(r.failed.size).toBe(0)
    expect(r.bundle.source).toContain("E1: 50")
  })
})
