// Starter workbooks. Plain source strings (plus data files), exactly what a user would write.

export interface Example {
  id: string
  name: string
  source: string
  files: Record<string, string>
}

export const salesExample = `import { workbook, sheet, table, query, col, chart, metric, param, text, data } from "@xl2/sdk"

export default workbook("Sales plan", [
  sheet("Overview", [
    text("# Q1 sales\\nRevenue by rep and region. Change **Q2 growth** to move the forecast.", { at: "A1:H3" }),
    param("growth", 0.08, { at: "A5", label: "Q2 growth", format: "percent", min: -0.5, max: 1, step: 0.01 }),
    metric("Revenue", (ctx) => ctx.table("sales").sum("revenue"), { at: "D5:E7", format: "currency" }),
    metric("Q2 forecast", (ctx) => ctx.table("sales").sum("forecast"), {
      at: "F5:G7",
      format: "currency",
      caption: (ctx) => \`at \${(ctx.param("growth") * 100).toFixed(0)}% growth\`,
    }),
    metric("Units", (ctx) => ctx.table("sales").sum("units"), { at: "H5:H7", format: "integer" }),
    table("sales", {
      at: "A10",
      title: "Sales by rep",
      columns: {
        rep: col.text({ label: "Rep" }),
        region: col.select(["North", "South", "East", "West"], { label: "Region" }),
        product: col.text({ label: "Product" }),
        units: col.number({ label: "Units" }),
        price: col.currency({ label: "Unit price" }),
        revenue: col.formula((r) => r.units * r.price, { label: "Revenue", format: "currency" }),
        share: col.formula((r, ctx) => r.revenue / ctx.table("sales").sum("revenue"), { label: "Share", format: "percent" }),
        forecast: col.formula((r, ctx) => r.revenue * (1 + ctx.param("growth")), { label: "Q2 forecast", format: "currency" }),
      },
      rows: [
        { rep: "Ada", region: "North", product: "Widget", units: 120, price: 9.5 },
        { rep: "Linus", region: "South", product: "Gadget", units: 80, price: 24 },
        { rep: "Grace", region: "East", product: "Widget", units: 150, price: 9.5 },
        { rep: "Alan", region: "West", product: "Gizmo", units: 45, price: 59 },
        { rep: "Edsger", region: "North", product: "Gadget", units: 60, price: 24 },
        { rep: "Barbara", region: "South", product: "Gizmo", units: 30, price: 59 },
      ],
      totals: { units: "sum", revenue: "sum", share: "sum", forecast: "sum" },
    }),
    chart.bar("Revenue by region", { data: "byRegion", x: "region", y: ["revenue", "forecast"], at: "J1:O13" }),
    chart.pie("Units by product", { data: "sales", x: "product", y: "units", aggregate: "sum", at: "J15:O27" }),
  ], {
    cells: {
      A6: "Target",
      B6: { value: 6000, format: "currency" },
      A7: "Gap to target",
      B7: { value: "=B6 - sales.sum('revenue')", format: "currency", bold: true },
      A8: "Best rep",
      B8: "=sales.sortBy('revenue', 'desc').first().rep",
    },
    widths: { A: 130 },
  }),
  sheet("By region", [
    query(
      "byRegion",
      (ctx) =>
        ctx
          .table("sales")
          .groupBy("region", { units: "sum", revenue: "sum", forecast: "sum" })
          .sortBy("revenue", "desc"),
      {
        at: "A1",
        title: "Revenue by region",
        columns: {
          region: { label: "Region", kind: "text" },
          units: { label: "Units" },
          revenue: { label: "Revenue", format: "currency" },
          forecast: { label: "Q2 forecast", format: "currency" },
        },
      },
    ),
  ], {
    cells: {
      A9: "Top region share",
      B9: { value: "=C3 / SUM(C3:C6)", format: "percent", bold: true },
    },
  }),
  sheet("Orders", [
    table("orders", {
      at: "A1",
      title: "Orders (orders.csv)",
      columns: {
        date: col.date({ label: "Date" }),
        region: col.select(["North", "South", "East", "West"], { label: "Region" }),
        product: col.text({ label: "Product" }),
        units: col.number({ label: "Units" }),
        price: col.currency({ label: "Unit price" }),
        revenue: col.formula((r) => r.units * r.price, { label: "Revenue", format: "currency" }),
      },
      rows: data("orders.csv"),
      totals: { units: "sum", revenue: "sum" },
    }),
    chart.line("Revenue per order", { data: "orders", x: "date", y: "revenue", format: "currency", at: "H1:O13" }),
  ]),
])
`

const products = [
  ["Widget", 9.5],
  ["Gadget", 24],
  ["Gizmo", 59],
] as const
const regions = ["North", "South", "East", "West"]

/** 24 deterministic orders across Q1. */
const ordersCsv =
  "date,region,product,units,price\n" +
  Array.from({ length: 24 }, (_, i) => {
    const [product, price] = products[(i * 7) % 3]
    const day = new Date(Date.UTC(2026, 0, 3 + i * 3)).toISOString().slice(0, 10)
    return `${day},${regions[(i * 5) % 4]},${product},${10 + ((i * 37) % 90)},${price}`
  }).join("\n") +
  "\n"

export const budgetExample = `import { workbook, sheet, table, col, chart, metric } from "@xl2/sdk"

export default workbook(
  "Household budget",
  [
    sheet("Budget", [
      metric("Income", (ctx) => ctx.table("income").sum("amount"), { at: "A1:B3", format: "currency" }),
      metric("Spending", (ctx) => ctx.table("spending").sum("amount"), { at: "C1:D3", format: "currency" }),
      metric("Left over", (ctx) => ctx.table("income").sum("amount") - ctx.table("spending").sum("amount"), {
        at: "E1:F3",
        format: "currency",
      }),
      metric("Savings rate", (ctx) => 1 - ctx.table("spending").sum("amount") / ctx.table("income").sum("amount"), {
        at: "G1:H3",
        format: "percent",
      }),
      table("income", {
        at: "A5",
        title: "Income",
        columns: {
          source: col.text({ label: "Source" }),
          amount: col.currency({ label: "Monthly" }),
        },
        rows: [
          ["Salary", 52000],
          ["Side project", 4500],
        ],
        totals: { amount: "sum" },
      }),
      table("spending", {
        at: "D5",
        title: "Spending",
        columns: {
          item: col.text({ label: "Item" }),
          category: col.select(["Housing", "Food", "Transport", "Fun", "Other"], { label: "Category" }),
          amount: col.currency({ label: "Monthly" }),
        },
        rows: [
          ["Rent", "Housing", 16500],
          ["Groceries", "Food", 6200],
          ["Transit pass", "Transport", 850],
          ["Eating out", "Fun", 2400],
          ["Streaming", "Fun", 320],
          ["Phone", "Other", 399],
        ],
        totals: { amount: "sum" },
      }),
      chart.pie("Spending by category", { data: "spending", x: "category", y: "amount", aggregate: "sum", at: "H5:L16" }),
      chart.bar("Spending by category", {
        data: (ctx) => ctx.table("spending").groupBy("category", { amount: "sum" }).sortBy("amount", "desc"),
        x: "category",
        y: "amount",
        format: "currency",
        at: "H18:L29",
      }),
    ], {
      cells: {
        A12: "Yearly savings",
        B12: { value: "=(income.sum('amount') - spending.sum('amount')) * 12", format: "currency", bold: true },
      },
      widths: { A: 120, D: 120 },
    }),
  ],
  { locale: "nb-NO", currency: "NOK" },
)
`

export const loanExample = `import { workbook, sheet, query, chart, metric, param } from "@xl2/sdk"

// An amortization schedule generated entirely by code.
export default workbook("Mortgage", [
  sheet("Loan", [
    param("principal", 3500000, { at: "A1", label: "Loan", format: "currency", step: 50000 }),
    param("rate", 0.051, { at: "A2", label: "Interest", format: "percent", step: 0.001 }),
    param("years", 25, { at: "A3", label: "Years", format: "integer", min: 1, max: 40 }),
    metric("Monthly payment", (ctx) => ctx.table("schedule").first()?.payment ?? 0, { at: "D1:E3", format: "currency" }),
    query(
      "schedule",
      (ctx) => {
        const p = ctx.param("principal"), r = ctx.param("rate") / 12, n = ctx.param("years") * 12
        const payment = (p * r) / (1 - Math.pow(1 + r, -n))
        let balance = p
        const rows = []
        for (let year = 1; year <= ctx.param("years"); year++) {
          let interest = 0, principal = 0
          for (let m = 0; m < 12; m++) {
            const i = balance * r
            interest += i
            principal += payment - i
            balance -= payment - i
          }
          rows.push({ year, payment, interest, principal, balance: Math.max(balance, 0) })
        }
        return rows
      },
      {
        at: "A7",
        title: "Yearly schedule",
        columns: {
          year: { label: "Year", format: "integer" },
          payment: { label: "Monthly payment", format: "currency" },
          interest: { label: "Interest paid", format: "currency" },
          principal: { label: "Principal paid", format: "currency" },
          balance: { label: "Balance", format: "currency" },
        },
      },
    ),
    chart.area("Balance over time", { data: "schedule", x: "year", y: "balance", format: "currency", at: "G1:M14" }),
  ], {
    cells: {
      A5: "Total interest",
      B5: { value: "=schedule.sum('interest')", format: "currency", bold: true },
      D5: "Check (PMT)",
      E5: { value: "=-PMT(rate / 12, years * 12, principal)", format: "currency" },
    },
    widths: { A: 120 },
  }),
], { currency: "NOK", locale: "nb-NO" })
`

export const blankExample = `import { workbook, sheet } from "@xl2/sdk"

export default workbook("Untitled", [
  sheet("Sheet 1", [], { cells: {} }),
])
`

export const examples: Example[] = [
  { id: "sales", name: "Sales plan", source: salesExample, files: { "orders.csv": ordersCsv } },
  { id: "budget", name: "Household budget", source: budgetExample, files: {} },
  { id: "loan", name: "Mortgage", source: loanExample, files: {} },
  { id: "blank", name: "Blank", source: blankExample, files: {} },
]
