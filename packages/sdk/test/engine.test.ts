import { describe, expect, it } from "vitest"
import {
  chart,
  col,
  evaluate,
  examples,
  metric,
  param,
  query,
  run,
  sheet,
  table,
  workbook,
  type TableModel,
} from "../src"

const sales = table("sales", {
  columns: {
    region: col.text(),
    units: col.number(),
    price: col.currency(),
    revenue: col.formula((r) => r.units * r.price),
    share: col.formula((r, ctx) => r.revenue / ctx.table("sales").sum("revenue"), { format: "percent" }),
  },
  rows: [
    { region: "N", units: 10, price: 2 },
    ["S", 5, 4],
  ],
  totals: { units: "sum", revenue: "sum" },
})

function tableOf(model: ReturnType<typeof evaluate>, name: string) {
  return model.sheets.flatMap((s) => s.blocks).find((b) => b.type === "table" && b.name === name) as TableModel
}

describe("evaluate", () => {
  it("computes formulas, mixed row shapes, self-references and totals", () => {
    const m = evaluate(workbook("t", [sheet("a", [sales])]))
    const t = tableOf(m, "sales")
    expect(t.rows).toEqual([
      ["N", 10, 2, 20, 0.5],
      ["S", 5, 4, 20, 0.5],
    ])
    expect(t.totals).toEqual([null, 15, null, 40, null])
    expect(t.columns.map((c) => c.computed)).toEqual([false, false, false, true, true])
  })

  it("resolves queries, params, metrics and charts across sheets in any order", () => {
    const m = evaluate(
      workbook("t", [
        sheet("first", [
          metric("Top", (ctx) => ctx.table("byRegion").first()?.revenue),
          chart.bar("c", { data: "sales", x: "region", y: "revenue", aggregate: "sum" }),
        ]),
        sheet("second", [
          param("k", 2),
          query("byRegion", (ctx) =>
            ctx
              .table("sales")
              .map((r) => ({ region: r.region, revenue: r.revenue * ctx.param("k") }))
              .sortBy("revenue", "desc"),
          ),
          sales,
        ]),
      ]),
    )
    const [metricB, chartB] = m.sheets[0].blocks
    expect(metricB).toMatchObject({ type: "metric", value: 40 })
    expect(chartB).toMatchObject({ type: "chart", data: [{ region: "N", revenue: 20 }, { region: "S", revenue: 20 }] })
    expect(tableOf(m, "byRegion").columns.map((c) => c.key)).toEqual(["region", "revenue"])
  })

  it("isolates errors to cells and detects cycles", () => {
    const m = evaluate(
      workbook("t", [
        sheet("a", [
          table("t", {
            columns: {
              a: col.number(),
              boom: col.formula(() => {
                throw new Error("nope")
              }),
              loop1: col.formula((r) => r.loop2),
              loop2: col.formula((r) => r.loop1),
              div: col.formula((r) => r.a / 0),
              usesBoom: col.formula((r) => r.boom + 1),
            },
            rows: [[1]],
          }),
          metric("bad", (ctx) => ctx.table("missing").sum("x")),
        ]),
      ]),
    )
    const [, boom, l1, l2, div, uses] = tableOf(m, "t").rows[0]
    expect(boom).toEqual({ error: "nope" })
    expect(l1).toMatchObject({ error: expect.stringMatching(/Circular/) })
    expect(l2).toMatchObject({ error: expect.stringMatching(/Circular/) })
    expect(div).toEqual({ error: "#DIV/0" })
    expect(uses).toEqual({ error: "nope" })
    expect(m.sheets[0].blocks[1]).toMatchObject({ error: 'Unknown table "missing"' })
  })

  it("supports running totals through ctx.prev", () => {
    const m = evaluate(
      workbook("t", [
        sheet("a", [
          table("ledger", {
            columns: {
              amount: col.number(),
              balance: col.formula((r, ctx) => (ctx.prev?.balance ?? 0) + r.amount),
            },
            rows: [[10], [5], [-3]],
          }),
        ]),
      ]),
    )
    expect(tableOf(m, "ledger").rows.map((r) => r[1])).toEqual([10, 15, 12])
  })
})

describe("run (compile + execute source)", () => {
  it("runs every bundled example without errors", () => {
    for (const ex of examples) {
      const r = run(ex.source)
      if (!r.ok) throw new Error(`${ex.id}: ${r.error.message}`)
      const errors = r.model.sheets
        .flatMap((s) => s.blocks)
        .filter((b) => "error" in b && b.error)
      expect(errors, ex.id).toEqual([])
    }
  })

  it("reports syntax and import errors", () => {
    const syntax = run("export default workbook(")
    expect(syntax.ok).toBe(false)
    const imp = run('import fs from "fs"\nexport default fs')
    expect(imp.ok || imp.error.message).toMatch(/Only "@xl2\/sdk"/)
    const shape = run("export default 42")
    expect(shape.ok || shape.error.message).toMatch(/export default workbook/)
  })
})
