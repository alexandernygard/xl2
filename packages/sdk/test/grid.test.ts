import { describe, expect, it } from "vitest"
import { applyEdit, cellAt, fillIntents, inputIntents, locate, parseTsv, pasteIntents, run, shiftFormula, tableRegion, translateFormula, type Bundle, type EditIntent, type TableModel } from "../src"

const src = `import { workbook, sheet, table, col, param, chart, data } from "@xl2/sdk"

export default workbook("G", [
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
    table("people", {
      at: "F3",
      columns: { name: col.text(), age: col.number(), double: col.formula((r) => r.age * 2) },
      rows: data("people.csv"),
    }),
    chart.bar("Units", { data: "sales", x: "region", y: "units", at: "A12:F20" }),
  ], {
    cells: {
      E1: "=SUM(B5:B6)",
      E2: { value: "=sales.sum('units') * growth", format: "number", bold: true },
      H1: "=Other!A1 + 1",
      J1: "=J2",
      J2: "=J1",
      K1: "=IFERROR(1 / 0 + J1, 'n/a')",
    },
    widths: { A: 140 },
  }),
  sheet("Other", [], { cells: { A1: 41 } }),
])
`

const files = { "people.csv": "name,age\nAda,36\nAlan,41\n" }
const bundle: Bundle = { source: src, files }

function model(b: Bundle = bundle) {
  const r = run(b.source, b.files)
  if (!r.ok) throw r.error
  return r.model
}

function edit(b: Bundle, intent: EditIntent) {
  const r = applyEdit(b, intent)
  if (!r.ok) throw new Error(r.error)
  return r.bundle
}

const table = (m: ReturnType<typeof model>, name: string) =>
  m.sheets.flatMap((s) => s.blocks).find((x) => x.type === "table" && x.name === name) as TableModel

describe("grid layout", () => {
  it("places blocks at their anchors with natural or explicit sizes", () => {
    const m = model()
    const [p, sales, people, c] = m.sheets[0].blocks
    expect(p.rect).toEqual({ row: 0, col: 0, rows: 1, cols: 2 })
    // title, header, 2 rows, add row, totals
    expect(sales.rect).toEqual({ row: 2, col: 0, rows: 6, cols: 3 })
    expect(people.rect).toEqual({ row: 2, col: 5, rows: 5, cols: 3 })
    expect(c.rect).toEqual({ row: 11, col: 0, rows: 9, cols: 6 })
    expect(m.sheets[0].widths).toEqual({ 0: 140 })
    expect(m.issues).toEqual([])
    expect(tableRegion(sales as TableModel, 4)).toEqual({ kind: "data", index: 0 })
    expect(tableRegion(sales as TableModel, 6)).toEqual({ kind: "add" })
    expect(tableRegion(sales as TableModel, 7)).toEqual({ kind: "totals" })
  })

  it("stacks blocks without `at` down column A", () => {
    const r = run(`import { workbook, sheet, metric, text } from "@xl2/sdk"
export default workbook("x", [sheet("s", [text("hi"), metric("m", () => 1)])])`)
    if (!r.ok) throw r.error
    expect(r.model.sheets[0].blocks.map((b) => b.rect)).toEqual([
      { row: 0, col: 0, rows: 1, cols: 6 },
      { row: 2, col: 0, rows: 3, cols: 2 },
    ])
  })
})

describe("overlaps", () => {
  it("moves a block down when a table above grows into it, and keeps auto-placed blocks clear", () => {
    const r = run(`import { workbook, sheet, table, col, metric, text } from "@xl2/sdk"
export default workbook("x", [sheet("s", [
  table("t", { at: "A1", columns: { a: col.number() }, rows: [[1], [2], [3]] }),
  metric("m", () => 1, { at: "A5:B7" }),
  text("auto"),
])])`)
    if (!r.ok) throw r.error
    const [t, m, txt] = r.model.sheets[0].blocks
    // title, header, 3 rows, add row: rows 0-5, so the metric moves to row 7
    expect(t.rect).toEqual({ row: 0, col: 0, rows: 6, cols: 1 })
    expect(m.rect).toEqual({ row: 7, col: 0, rows: 3, cols: 2 })
    // the auto-placed text would start at row 0; it fits in below both
    expect(txt.rect.row).toBe(11)
    expect(r.model.issues).toEqual([])
  })
})

describe("cell formulas", () => {
  it("resolve A1 refs into tables, params, other sheets, and names", () => {
    const cells = model().sheets[0].cells
    expect(cells.E1.value).toBe(30)
    expect(cells.E2.value).toBeCloseTo(3)
    expect(cells.E2.style).toEqual({ format: "number", bold: true })
    expect(cells.E2.formula).toBe("=sales.sum('units') * growth")
    expect(cells.H1.value).toBe(42)
  })

  it("report cycles per cell and let IFERROR catch errors", () => {
    const cells = model().sheets[0].cells
    expect(cells.J1.value).toMatchObject({ error: expect.stringContaining("#CYCLE") })
    expect(cells.K1.value).toBe("n/a")
  })

  it("translates references but leaves strings and identifiers alone", () => {
    expect(translateFormula("SUM(B2:B9) + 'Q1 data'!A1 + x.B3 + \"C4\" + LOG10(2) + D5<>1").js).toBe(
      'SUM(__range(null,"B2","B9")) + __ref("Q1 data","A1") + x.B3 + "C4" + LOG10(2) + __ref(null,"D5")!=1',
    )
  })

  it("table formulas and metrics can read cells with ctx.cell", () => {
    const r = run(`import { workbook, sheet, metric } from "@xl2/sdk"
export default workbook("x", [sheet("s", [metric("m", (ctx) => ctx.cell("A1") * 2, { at: "C1" })], { cells: { A1: 21 } })])`)
    if (!r.ok) throw r.error
    expect((r.model.sheets[0].blocks[0] as any).value).toBe(42)
  })
})

describe("data files", () => {
  it("reads rows from CSV with column kinds", () => {
    expect(table(model(), "people").rows).toEqual([
      ["Ada", 36, 72],
      ["Alan", 41, 82],
    ])
    expect(table(model(), "people").dataFile).toBe("people.csv")
  })

  it("edits the CSV, not the code, for data-backed tables", () => {
    let b = edit(bundle, { type: "setCell", table: "people", row: 1, column: "age", value: 42 })
    expect(b.source).toBe(src)
    expect(b.files["people.csv"]).toBe("name,age\nAda,36\nAlan,42\n")
    b = edit(b, { type: "addRow", table: "people", values: { name: "Grace, Hopper" } })
    expect(b.files["people.csv"]).toBe('name,age\nAda,36\nAlan,42\n"Grace, Hopper",\n')
    expect(edit(b, { type: "addRow", table: "people", values: { name: "Ida" }, at: 1 }).files["people.csv"]).toBe(
      'name,age\nAda,36\nIda,\nAlan,42\n"Grace, Hopper",\n',
    )
    b = edit(b, { type: "deleteRow", table: "people", row: 0 })
    expect(table(model(b), "people").rows.map((r) => r[0])).toEqual(["Alan", "Grace, Hopper"])
    b = edit(b, { type: "addColumn", table: "people", column: "city", kind: "text" })
    expect(b.files["people.csv"].split("\n")[0]).toBe("name,age,city")
    b = edit(b, { type: "setCell", table: "people", row: 0, column: "city", value: "London" })
    expect(table(model(b), "people").rows[0]).toEqual(["Alan", 42, 84, "London"])
    const loc = locate(b.source, { type: "cell", table: "people", row: 0, column: "city" }, b.files)!
    expect(loc.file).toBe("people.csv")
    expect(b.files["people.csv"].slice(loc.start, loc.end)).toBe("London")
  })
})

describe("overrides", () => {
  it("replace one formula cell and shift when rows are deleted", () => {
    let b = edit(bundle, { type: "setOverride", table: "sales", row: 1, column: "next", value: 99 })
    expect(b.source).toContain('overrides: [{ row: 1, column: "next", value: 99 }]')
    let t = table(model(b), "sales")
    expect(t.rows[1][2]).toBe(99)
    expect(t.overridden).toEqual(["1:next"])
    b = edit(b, { type: "deleteRow", table: "sales", row: 0 })
    t = table(model(b), "sales")
    expect(t.rows).toEqual([["S", 20, 99]])
    expect(t.overridden).toEqual(["0:next"])
    t = table(model(edit(b, { type: "addRow", table: "sales", values: { region: "W" }, at: 0 })), "sales")
    expect(t.rows.map((r) => r[0])).toEqual(["W", "S"])
    expect(t.overridden).toEqual(["1:next"])
    b = edit(b, { type: "setOverride", table: "sales", row: 0, column: "next", value: undefined })
    expect(b.source).not.toContain("overrides")
    expect(table(model(b), "sales").rows[0][2]).toBeCloseTo(22)
  })
})

describe("grid edits", () => {
  it("sets, styles and clears free cells", () => {
    let b = edit(bundle, { type: "setFreeCell", sheet: "Main", address: "E1", value: "=E2 + 1" })
    expect(b.source).toContain('E1: "=E2 + 1",')
    b = edit(b, { type: "setFreeCell", sheet: "Main", address: "L9", value: 5 })
    expect(model(b).sheets[0].cells.L9.value).toBe(5)
    b = edit(b, { type: "setCellStyle", sheet: "Main", address: "L9", style: { bold: true, format: "currency" } })
    expect(b.source).toContain('L9: { value: 5, bold: true, format: "currency" }')
    b = edit(b, { type: "setCellStyle", sheet: "Main", address: "L9", style: { bold: null, align: "right" } })
    expect(model(b).sheets[0].cells.L9.style).toEqual({ format: "currency", align: "right" })
    b = edit(b, { type: "setFreeCell", sheet: "Main", address: "L9", value: 7 })
    expect(model(b).sheets[0].cells.L9).toMatchObject({ value: 7, style: { format: "currency", align: "right" } })
    b = edit(b, { type: "setFreeCell", sheet: "Main", address: "E1", value: null })
    expect(model(b).sheets[0].cells.E1).toBeUndefined()
  })

  it("adds cells and widths to sheets without options", () => {
    let b = edit(bundle, { type: "setFreeCell", sheet: "Other", address: "B2", value: "x" })
    expect(model(b).sheets[1].cells.B2.value).toBe("x")
    b = edit({ source: src.replace('sheet("Other", [], { cells: { A1: 41 } })', 'sheet("Other")'), files }, { type: "setWidth", sheet: "Other", column: "c", width: 200 })
    expect(b.source).toContain('sheet("Other", [], { widths: { C: 200 } })')
    expect(model(b).sheets[1].widths).toEqual({ 2: 200 })
  })

  it("moves, deletes and renames", () => {
    let b = edit(bundle, { type: "moveBlock", sheet: "Main", index: 3, at: "H10:M18" })
    expect(model(b).sheets[0].blocks[3].rect).toEqual({ row: 9, col: 7, rows: 9, cols: 6 })
    b = edit(b, { type: "moveBlock", sheet: "Main", index: 0, at: "C1" })
    expect(b.source).toContain('param("growth", 0.1, { at: "C1", label: "Growth" })')
    b = edit({ source: b.source.replace('param("growth", 0.1, { at: "C1", label: "Growth" })', 'param("growth", 0.1)'), files }, { type: "moveBlock", sheet: "Main", index: 0, at: "A1" })
    expect(b.source).toContain('param("growth", 0.1, { at: "A1" })')
    b = edit(b, { type: "deleteBlock", sheet: "Main", index: 3 })
    expect(model(b).sheets[0].blocks).toHaveLength(3)
    b = edit(b, { type: "renameSheet", sheet: "Other", name: "Inputs" })
    expect(model(b).sheets[1].name).toBe("Inputs")
    b = edit(b, { type: "setColumnFormat", table: "sales", column: "units", format: "integer" })
    expect(b.source).toContain('units: col.number({ format: "integer" })')
  })
})

describe("typing, paste and fill", () => {
  const sheet = () => model().sheets[0]
  const apply = (intents: EditIntent[]) => intents.reduce(edit, bundle)

  it("routes typed input by what's under the cell", () => {
    const s = sheet()
    const at = (a: string) => {
      const p = /^([A-Z]+)(\d+)$/.exec(a)!
      return cellAt(s, +p[2] - 1, p[1].charCodeAt(0) - 65)
    }
    expect(inputIntents(s, at("B5"), "12")).toEqual({ ok: true, intents: [{ type: "setCell", table: "sales", row: 0, column: "units", value: 12 }] })
    expect(inputIntents(s, at("C5"), "50")).toMatchObject({ ok: true, intents: [{ type: "setOverride", column: "next", value: 50 }] })
    expect(inputIntents(s, at("A7"), "W")).toEqual({ ok: true, intents: [{ type: "addRow", table: "sales", values: { region: "W" } }] })
    expect(inputIntents(s, at("D4"), "Unit price")).toMatchObject({ ok: true, intents: [{ type: "addColumn", table: "sales", column: "unitPrice", label: "Unit price" }] })
    expect(inputIntents(s, at("B1"), "25%")).toEqual({ ok: true, intents: [{ type: "setParam", name: "growth", value: 0.25 }] })
    expect(inputIntents(s, at("Z9"), "1,200")).toMatchObject({ ok: true, intents: [{ type: "setFreeCell", address: "Z9", value: 1200 }] })
    expect(inputIntents(s, at("B8"), "1").ok).toBe(false)
  })

  it("appends pasted rows that land on a table's add row", () => {
    const res = pasteIntents(sheet(), 6, 0, parseTsv("E\t5\nW\t6\n"))
    if (!res.ok) throw new Error(res.error)
    expect(table(model(apply(res.intents)), "sales").rows.map((r) => r.slice(0, 2))).toEqual([
      ["N", 10],
      ["S", 20],
      ["E", 5],
      ["W", 6],
    ])
  })

  it("fills formulas with shifted references", () => {
    let b = edit(bundle, { type: "setFreeCell", sheet: "Main", address: "M1", value: 1 })
    b = edit(b, { type: "setFreeCell", sheet: "Main", address: "M2", value: 2 })
    b = edit(b, { type: "setFreeCell", sheet: "Main", address: "N1", value: "=M1 * 10 + $M$1" })
    const res = fillIntents(model(b).sheets[0], { row: 0, col: 13, rows: 1, cols: 1 }, { row: 0, col: 13, rows: 2, cols: 1 })
    if (!res.ok) throw new Error(res.error)
    b = res.intents.reduce(edit, b)
    expect(model(b).sheets[0].cells.N2).toMatchObject({ formula: "=M2 * 10 + $M$1", value: 21 })
    expect(shiftFormula("=SUM(A1:B2)+'S 1'!C3", 1, 1)).toBe("=SUM(B2:C3)+'S 1'!D4")
  })
})

describe("addBlock", () => {
  it("adds builders the new code uses to the SDK import", () => {
    const s = `import { workbook, sheet } from "@xl2/sdk"\nexport default workbook("x", [sheet("s", [])])\n`
    const b = edit({ source: s, files: {} }, { type: "addBlock", sheet: "s", code: 'chart.bar("c", { data: "t", x: "a", y: "b" })' })
    expect(b.source).toContain('import { workbook, sheet, chart } from "@xl2/sdk"')
  })
})
