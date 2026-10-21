import { describe, expect, it } from "vitest"
import { callSignature, formulaCaret, formulaRefSpans, formulaSuggestions, type FormulaNames } from "../src"

const names: FormulaNames = {
  tables: [{ name: "sales", columns: [{ key: "region", label: "Region" }, { key: "units", label: "Units" }] }],
  params: [{ name: "growth", label: "Growth" }],
}

describe("formula help", () => {
  it("finds reference spans", () => {
    const f = "=SUM(B2:B9) + $C$1 * Other!A1 + 'My sheet'!D4 + \"A1\""
    expect(formulaRefSpans(f).map((s) => f.slice(s.start, s.end))).toEqual(["B2:B9", "$C$1", "Other!A1", "'My sheet'!D4"])
    expect(formulaRefSpans(f)[2]).toMatchObject({ sheet: "Other", from: "A1" })
  })

  it("knows the call and argument at the caret", () => {
    const f = "=IF(B2 > 1, SUM(C1, "
    const at = formulaCaret(f, f.length)
    expect(at.call).toMatchObject({ name: "SUM", argIndex: 1 })
    expect(at.canPoint).toBe(true)
    expect(formulaCaret("=IF(B2 > 1", 10).call).toMatchObject({ name: "IF", argIndex: 0 })
    expect(formulaCaret("=B2", 3).canPoint).toBe(false)
    expect(callSignature({ name: "SUM", argIndex: 3 })?.active).toBe(0)
    expect(callSignature({ name: "IF", argIndex: 2 })?.args[2]).toBe("[otherwise]")
  })

  it("suggests functions, names, methods and columns", () => {
    expect(formulaSuggestions("=su", 3, names)[0]).toMatchObject({ label: "SUM", insert: "SUM(", from: 1 })
    expect(formulaSuggestions("=1 + sa", 7, names).map((s) => s.label)).toEqual(["sales"])
    expect(formulaSuggestions("=gro", 4, names)[0]).toMatchObject({ kind: "param", insert: "growth" })
    expect(formulaSuggestions("=sales.su", 9, names)[0]).toMatchObject({ label: "sum", insert: 'sum("' })
    expect(formulaSuggestions('=sales.sum("u', 13, names)).toEqual([expect.objectContaining({ label: "units", insert: 'units"' })])
    expect(formulaSuggestions("=B2", 3, names)).toEqual([])
    expect(formulaSuggestions("=", 1, names)).toEqual([])
  })
})
