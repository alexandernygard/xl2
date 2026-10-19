// Starter workbooks. Plain source strings, exactly what a user would write.

export const salesExample = `import { workbook, sheet, table, query, col, chart, metric, param, text } from "@xl2/sdk"

export default workbook("Sales plan", [
  sheet("Overview", [
    text("# Q1 sales\\nRevenue by region and product. Change **growth** to see the Q2 forecast move."),
    param("growth", 0.08, { label: "Q2 growth", format: "percent", min: -0.5, max: 1, step: 0.01 }),
    metric("Revenue", (ctx) => ctx.table("sales").sum("revenue"), { format: "currency" }),
    metric("Q2 forecast", (ctx) => ctx.table("sales").sum("forecast"), {
      format: "currency",
      caption: (ctx) => \`at \${(ctx.param("growth") * 100).toFixed(0)}% growth\`,
    }),
    metric("Units", (ctx) => ctx.table("sales").sum("units"), { format: "integer" }),
    table("sales", {
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
    chart.bar("Revenue by region", { data: "byRegion", x: "region", y: ["revenue", "forecast"] }),
    chart.pie("Units by product", { data: "sales", x: "product", y: "units", aggregate: "sum" }),
  ]),
  sheet("By region", [
    query(
      "byRegion",
      (ctx) =>
        ctx
          .table("sales")
          .groupBy("region", { units: "sum", revenue: "sum", forecast: "sum" })
          .sortBy("revenue", "desc"),
      {
        title: "Revenue by region",
        columns: {
          region: { label: "Region", kind: "text" },
          units: { label: "Units" },
          revenue: { label: "Revenue", format: "currency" },
          forecast: { label: "Q2 forecast", format: "currency" },
        },
      },
    ),
  ]),
])
`

export const budgetExample = `import { workbook, sheet, table, col, chart, metric, query } from "@xl2/sdk"

export default workbook(
  "Household budget",
  [
    sheet("Budget", [
      metric("Income", (ctx) => ctx.table("income").sum("amount"), { format: "currency" }),
      metric("Spending", (ctx) => ctx.table("spending").sum("amount"), { format: "currency" }),
      metric("Left over", (ctx) => ctx.table("income").sum("amount") - ctx.table("spending").sum("amount"), {
        format: "currency",
      }),
      metric("Savings rate", (ctx) => 1 - ctx.table("spending").sum("amount") / ctx.table("income").sum("amount"), {
        format: "percent",
      }),
      table("income", {
        title: "Income",
        span: 2,
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
        title: "Spending",
        span: 2,
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
      chart.pie("Spending by category", { data: "spending", x: "category", y: "amount", aggregate: "sum" }),
      chart.bar("Spending by category", {
        data: (ctx) => ctx.table("spending").groupBy("category", { amount: "sum" }).sortBy("amount", "desc"),
        x: "category",
        y: "amount",
        format: "currency",
      }),
    ]),
  ],
  { locale: "nb-NO", currency: "NOK" },
)
`

export const loanExample = `import { workbook, sheet, query, col, chart, metric, param } from "@xl2/sdk"

// An amortization schedule generated entirely by code.
export default workbook("Mortgage", [
  sheet("Loan", [
    param("principal", 3500000, { label: "Loan", format: "currency", step: 50000 }),
    param("rate", 0.051, { label: "Interest", format: "percent", step: 0.001 }),
    param("years", 25, { label: "Years", format: "integer", min: 1, max: 40 }),
    metric("Monthly payment", (ctx) => ctx.table("schedule").first()?.payment ?? 0, { format: "currency" }),
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
    chart.area("Balance over time", { data: "schedule", x: "year", y: "balance", format: "currency", span: 4 }),
  ]),
], { currency: "NOK", locale: "nb-NO" })
`

export const blankExample = `import { workbook, sheet, table, col } from "@xl2/sdk"

export default workbook("Untitled", [
  sheet("Sheet 1", [
    table("data", {
      columns: {
        name: col.text({ label: "Name" }),
        value: col.number({ label: "Value" }),
      },
      rows: [],
    }),
  ]),
])
`

export const examples = [
  { id: "sales", name: "Sales plan", source: salesExample },
  { id: "budget", name: "Household budget", source: budgetExample },
  { id: "loan", name: "Mortgage", source: loanExample },
  { id: "blank", name: "Blank", source: blankExample },
]
