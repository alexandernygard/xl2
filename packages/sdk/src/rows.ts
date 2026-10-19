import type { Aggregate, Row, Rows } from "./types"

function num(v: any): number {
  if (typeof v === "number") return v
  if (v === null || v === undefined || v === "") return 0
  if (typeof v === "boolean") return v ? 1 : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function aggregate(values: any[], agg: Aggregate): any {
  switch (agg) {
    case "sum":
      return values.reduce((a, v) => a + num(v), 0)
    case "avg":
      return values.length ? values.reduce((a, v) => a + num(v), 0) / values.length : 0
    case "min":
      return values.length ? Math.min(...values.map(num)) : 0
    case "max":
      return values.length ? Math.max(...values.map(num)) : 0
    case "count":
      return values.filter((v) => v !== null && v !== undefined && v !== "").length
    case "first":
      return values[0]
    case "last":
      return values[values.length - 1]
  }
}

function keyFn(key: string | ((row: Row) => any)) {
  return typeof key === "function" ? key : (r: Row) => r[key]
}

export class RowList implements Rows {
  constructor(private readonly rows: Row[]) {}

  get length() {
    return this.rows.length
  }
  toArray() {
    return this.rows
  }
  column(key: string) {
    return this.rows.map((r) => r[key])
  }
  sum(key: string) {
    return aggregate(this.column(key), "sum")
  }
  avg(key: string) {
    return aggregate(this.column(key), "avg")
  }
  min(key: string) {
    return aggregate(this.column(key), "min")
  }
  max(key: string) {
    return aggregate(this.column(key), "max")
  }
  count(key?: string) {
    return key ? aggregate(this.column(key), "count") : this.rows.length
  }
  first() {
    return this.rows[0]
  }
  last() {
    return this.rows[this.rows.length - 1]
  }
  at(index: number) {
    return this.rows.at(index)
  }
  filter(pred: (row: Row, index: number) => boolean) {
    return new RowList(this.rows.filter(pred))
  }
  map(fn: (row: Row, index: number) => Row) {
    return new RowList(this.rows.map(fn))
  }
  sortBy(key: string | ((row: Row) => any), dir: "asc" | "desc" = "asc") {
    const get = keyFn(key)
    const sign = dir === "asc" ? 1 : -1
    return new RowList(
      [...this.rows].sort((a, b) => {
        const x = get(a)
        const y = get(b)
        if (x === y) return 0
        if (x === null || x === undefined) return 1
        if (y === null || y === undefined) return -1
        return (x < y ? -1 : 1) * sign
      }),
    )
  }
  take(n: number) {
    return new RowList(this.rows.slice(0, n))
  }
  groupBy(
    key: string | ((row: Row) => any),
    aggregates: Record<string, Aggregate | [string, Aggregate] | ((rows: Rows) => any)>,
  ) {
    const get = keyFn(key)
    const keyName = typeof key === "string" ? key : "key"
    const groups = new Map<any, Row[]>()
    for (const r of this.rows) {
      const k = get(r)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(r)
    }
    const out: Row[] = []
    for (const [k, rows] of groups) {
      const rec: Row = { [keyName]: k }
      const list = new RowList(rows)
      for (const [name, spec] of Object.entries(aggregates)) {
        if (typeof spec === "function") rec[name] = spec(list)
        else if (Array.isArray(spec)) rec[name] = aggregate(list.column(spec[0]), spec[1])
        else rec[name] = aggregate(list.column(name), spec)
      }
      out.push(rec)
    }
    return new RowList(out)
  }
  lookup(keyColumn: string, keyValue: any, returnColumn?: string) {
    const r = this.rows.find((row) => row[keyColumn] === keyValue)
    if (!r) return undefined
    return returnColumn ? r[returnColumn] : r
  }
  [Symbol.iterator]() {
    return this.rows[Symbol.iterator]()
  }
}
