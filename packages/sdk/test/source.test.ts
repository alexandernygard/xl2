import { describe, expect, it } from "vitest"
import { applyIntent, coerceInput, csvToTableCode, formulaSource, locate, run, salesExample, type EditIntent } from "../src"

const src = `import { workbook, sheet, table, col, param } from "@xl2/sdk"

// a comment that must survive
export default workbook("T", [
  sheet("S", [
    param("rate", 0.1),
    table("objs", {
      columns: {
        name: col.text(),
        qty: col.number(),
        total: col.formula((r) => r.qty * 2),
        note: col.text(),
      },
      rows: [
        { name: "a", qty: 1 },
        { name: "b", qty: 2, note: "x" },
      ],
    }),
    table("tuples", {
      columns: { k: col.text(), dbl: col.formula((r) => r.v * 2), v: col.number() },
      rows: [["x", 1], ["y"]],
    }),
    table("empty", { columns: { a: col.number() }, rows: [] }),
  ]),
])
`

function edit(source: string, intent: EditIntent) {
  const r = applyIntent(source, intent)
  if (!r.ok) throw new Error(r.error)
  return r.source
}

function values(source: string, tableName: string) {
  const r = run(source)
  if (!r.ok) throw r.error
  const t = r.model.sheets[0].blocks.find((b) => b.type === "table" && b.name === tableName)
  return (t as any).rows
}

describe("applyIntent", () => {
  it("sets object-row cells in place, and adds missing keys", () => {
    let s = edit(src, { type: "setCell", table: "objs", row: 0, column: "qty", value: 42 })
    expect(s).toContain('{ name: "a", qty: 42 }')
    s = edit(s, { type: "setCell", table: "objs", row: 0, column: "note", value: 'say "hi"' })
    expect(s).toContain('{ name: "a", qty: 42, note: "say \\"hi\\"" }')
    expect(s).toContain("// a comment that must survive")
    expect(values(s, "objs")[0]).toEqual(["a", 42, 84, 'say "hi"'])
  })

  it("maps tuple rows by data-column order, skipping formulas, and pads short tuples", () => {
    let s = edit(src, { type: "setCell", table: "tuples", row: 0, column: "v", value: 7 })
    expect(s).toContain('["x", 7]')
    s = edit(s, { type: "setCell", table: "tuples", row: 1, column: "v", value: 3 })
    expect(s).toContain('["y", 3]')
    expect(values(s, "tuples")).toEqual([
      ["x", 14, 7],
      ["y", 6, 3],
    ])
  })

  it("refuses to edit formula cells", () => {
    const r = applyIntent(src, { type: "setCell", table: "objs", row: 0, column: "total", value: 1 })
    expect(r.ok).toBe(false)
  })

  it("adds and deletes rows following the existing style", () => {
    let s = edit(src, { type: "addRow", table: "objs", values: { name: "c" } })
    expect(s).toContain('{ name: "b", qty: 2, note: "x" },\n        { name: "c", qty: null, note: null },')
    s = edit(s, { type: "addRow", table: "tuples" })
    expect(s).toContain('[["x", 1], ["y"], [null, null]]')
    s = edit(s, { type: "addRow", table: "empty", values: { a: 5 } })
    expect(values(s, "empty")).toEqual([[5]])
    s = edit(s, { type: "deleteRow", table: "objs", row: 0 })
    expect(values(s, "objs").map((r: any[]) => r[0])).toEqual(["b", "c"])
    s = edit(s, { type: "addRow", table: "objs", values: { name: "mid" }, at: 1 })
    expect(values(s, "objs").map((r: any[]) => r[0])).toEqual(["b", "mid", "c"])
    s = edit(s, { type: "addRow", table: "objs", values: { name: "top" }, at: 0 })
    expect(values(s, "objs").map((r: any[]) => r[0])).toEqual(["top", "b", "mid", "c"])
    s = edit(s, { type: "deleteRow", table: "objs", row: 0 })
    s = edit(s, { type: "deleteRow", table: "objs", row: 1 })
    s = edit(s, { type: "deleteRow", table: "objs", row: 1 })
    expect(values(s, "objs").map((r: any[]) => r[0])).toEqual(["b"])
    s = edit(s, { type: "deleteRow", table: "objs", row: 0 })
    expect(values(s, "objs")).toEqual([])
  })

  it("adds and deletes columns, including tuple values", () => {
    let s = edit(src, { type: "addColumn", table: "objs", column: "price", kind: "currency", label: "Price" })
    expect(s).toContain('price: col.currency({ label: "Price" }),')
    expect(run(s).ok).toBe(true)
    s = edit(src, { type: "deleteColumn", table: "tuples", column: "k" })
    expect(values(s, "tuples")).toEqual([
      [2, 1],
      [0, null],
    ])
  })

  it("sets params and adds sheets and blocks", () => {
    let s = edit(src, { type: "setParam", name: "rate", value: 0.25 })
    expect(s).toContain('param("rate", 0.25)')
    s = edit(s, { type: "addSheet", name: "New" })
    s = edit(s, { type: "addBlock", sheet: "New", code: csvToTableCode("people", "Name,Age\nAda,36\nAlan,41") })
    const r = run(s)
    if (!r.ok) throw r.error
    expect(r.model.sheets[1].name).toBe("New")
    expect((r.model.sheets[1].blocks[0] as any).rows).toEqual([
      ["Ada", 36],
      ["Alan", 41],
    ])
  })

  it("edits the bundled example and keeps it valid", () => {
    const s = edit(salesExample, { type: "setCell", table: "sales", row: 2, column: "units", value: 200 })
    const r = run(s)
    expect(r.ok).toBe(true)
  })
})

describe("locate / formulaSource", () => {
  it("finds cell literals and formula definitions", () => {
    const cell = locate(src, { type: "cell", table: "objs", row: 1, column: "note" })!
    expect(src.slice(cell.start, cell.end)).toBe('"x"')
    const f = locate(src, { type: "cell", table: "objs", row: 0, column: "total" })!
    expect(src.slice(f.start, f.end)).toBe("total: col.formula((r) => r.qty * 2)")
    expect(formulaSource(src, "objs", "total")).toBe("(r) => r.qty * 2")
  })
})

describe("coerceInput", () => {
  it("parses typed input per column kind", () => {
    expect(coerceInput("1,234.5", "number")).toEqual({ ok: true, value: 1234.5 })
    expect(coerceInput("12%", "number")).toEqual({ ok: true, value: 0.12 })
    expect(coerceInput("12", "percent")).toEqual({ ok: true, value: 0.12 })
    expect(coerceInput("$9.50", "currency")).toEqual({ ok: true, value: 9.5 })
    expect(coerceInput("yes", "boolean")).toEqual({ ok: true, value: true })
    expect(coerceInput("", "number")).toEqual({ ok: true, value: null })
    expect(coerceInput("abc", "number").ok).toBe(false)
    expect(coerceInput("Z", "select", ["A"]).ok).toBe(false)
  })
})
