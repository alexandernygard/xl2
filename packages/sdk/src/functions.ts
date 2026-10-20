// Spreadsheet functions with familiar names. Available in cell formulas
// ("=SUM(B2:B9)") and importable from "@xl2/sdk" for use in code.
// Ranges arrive as flat arrays; errors inside a range propagate as thrown errors.

type V = any

const flat = (args: V[]): V[] => args.flat(Infinity)
const nums = (args: V[]): number[] =>
  flat(args).filter((v) => typeof v === "number" || typeof v === "boolean").map(Number)

function toNumber(v: V): number {
  if (typeof v === "number") return v
  if (v === null || v === undefined || v === "") return 0
  if (typeof v === "boolean") return v ? 1 : 0
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`#VALUE: "${v}" is not a number`)
  return n
}

function criteria(c: V): (v: V) => boolean {
  if (typeof c === "function") return c
  if (typeof c === "string") {
    const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c)
    if (m) {
      const rhs = m[2].trim() === "" || Number.isNaN(Number(m[2])) ? m[2] : Number(m[2])
      switch (m[1]) {
        case "<=":
          return (v) => v <= rhs
        case ">=":
          return (v) => v >= rhs
        case "<":
          return (v) => v < rhs
        case ">":
          return (v) => v > rhs
        case "<>":
          return (v) => v !== rhs
        default:
          return (v) => v === rhs
      }
    }
  }
  return (v) => v === c
}

function day(v: V): Date {
  if (v instanceof Date) return v
  const d = new Date(typeof v === "number" ? v : String(v))
  if (Number.isNaN(d.getTime())) throw new Error(`#VALUE: "${v}" is not a date`)
  return d
}
const iso = (d: Date) => d.toISOString().slice(0, 10)

export const SUM = (...a: V[]) => nums(a).reduce((s, n) => s + n, 0)
export const AVERAGE = (...a: V[]) => {
  const n = nums(a)
  if (!n.length) throw new Error("#DIV/0")
  return SUM(n) / n.length
}
export const MIN = (...a: V[]) => (nums(a).length ? Math.min(...nums(a)) : 0)
export const MAX = (...a: V[]) => (nums(a).length ? Math.max(...nums(a)) : 0)
export const COUNT = (...a: V[]) => flat(a).filter((v) => typeof v === "number").length
export const COUNTA = (...a: V[]) => flat(a).filter((v) => v !== null && v !== undefined && v !== "").length
export const PRODUCT = (...a: V[]) => nums(a).reduce((s, n) => s * n, 1)
export const MEDIAN = (...a: V[]) => {
  const n = nums(a).sort((x, y) => x - y)
  if (!n.length) throw new Error("#NUM")
  const m = n.length >> 1
  return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2
}

export const ROUND = (v: V, digits = 0) => {
  const f = 10 ** digits
  return Math.round(toNumber(v) * f) / f
}
export const ROUNDUP = (v: V, digits = 0) => {
  const f = 10 ** digits
  const n = toNumber(v)
  return (Math.sign(n) * Math.ceil(Math.abs(n) * f)) / f
}
export const ROUNDDOWN = (v: V, digits = 0) => {
  const f = 10 ** digits
  return Math.trunc(toNumber(v) * f) / f
}
export const ABS = (v: V) => Math.abs(toNumber(v))
export const SQRT = (v: V) => Math.sqrt(toNumber(v))
export const POWER = (v: V, p: V) => toNumber(v) ** toNumber(p)
export const MOD = (v: V, d: V) => toNumber(v) % toNumber(d)

export const IF = (cond: V, then: V, otherwise: V = false) => (cond ? then : otherwise)
export const IFERROR = (v: V | (() => V), fallback: V) => {
  try {
    return typeof v === "function" ? v() : v
  } catch {
    return fallback
  }
}
export const AND = (...a: V[]) => flat(a).every(Boolean)
export const OR = (...a: V[]) => flat(a).some(Boolean)
export const NOT = (v: V) => !v

export const SUMIF = (range: V[], crit: V, sumRange?: V[]) => {
  const test = criteria(crit)
  const r = flat([range])
  const s = sumRange ? flat([sumRange]) : r
  return r.reduce((acc, v, i) => (test(v) ? acc + toNumber(s[i]) : acc), 0)
}
export const COUNTIF = (range: V[], crit: V) => flat([range]).filter(criteria(crit)).length
export const AVERAGEIF = (range: V[], crit: V, avgRange?: V[]) => {
  const n = COUNTIF(range, crit)
  if (!n) throw new Error("#DIV/0")
  return SUMIF(range, crit, avgRange) / n
}
export const XLOOKUP = (value: V, lookup: V[], result: V[], notFound?: V) => {
  const i = flat([lookup]).findIndex((v) => v === value)
  if (i < 0) {
    if (notFound !== undefined) return notFound
    throw new Error(`#N/A: ${value} not found`)
  }
  return flat([result])[i]
}

export const CONCAT = (...a: V[]) => flat(a).map((v) => (v === null || v === undefined ? "" : String(v))).join("")
export const LEN = (v: V) => String(v ?? "").length
export const UPPER = (v: V) => String(v ?? "").toUpperCase()
export const LOWER = (v: V) => String(v ?? "").toLowerCase()
export const TRIM = (v: V) => String(v ?? "").trim()

export const TODAY = () => iso(new Date())
export const DATE = (y: V, m: V, d: V) => iso(new Date(Date.UTC(toNumber(y), toNumber(m) - 1, toNumber(d))))
export const YEAR = (v: V) => day(v).getUTCFullYear()
export const MONTH = (v: V) => day(v).getUTCMonth() + 1
export const DAY = (v: V) => day(v).getUTCDate()
export const EOMONTH = (v: V, months: V = 0) => {
  const d = day(v)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNumber(months) + 1, 0)))
}
export const DAYS = (end: V, start: V) => Math.round((day(end).getTime() - day(start).getTime()) / 86400000)

/** Payment per period for a loan: rate per period, number of periods, present value. */
export const PMT = (rate: V, periods: V, pv: V, fv: V = 0, type: V = 0) => {
  const r = toNumber(rate)
  const n = toNumber(periods)
  const p = toNumber(pv)
  const f = toNumber(fv)
  if (r === 0) return -(p + f) / n
  const q = (1 + r) ** n
  return (-(r * (p * q + f)) / (q - 1)) / (1 + r * toNumber(type))
}
export const FV = (rate: V, periods: V, pmt: V, pv: V = 0) => {
  const r = toNumber(rate)
  const n = toNumber(periods)
  if (r === 0) return -(toNumber(pv) + toNumber(pmt) * n)
  const q = (1 + r) ** n
  return -(toNumber(pv) * q + (toNumber(pmt) * (q - 1)) / r)
}
export const NPV = (rate: V, ...flows: V[]) =>
  nums(flows).reduce((acc, cf, i) => acc + cf / (1 + toNumber(rate)) ** (i + 1), 0)
export const IRR = (flows: V[], guess: V = 0.1) => {
  const cf = nums([flows])
  let r = toNumber(guess)
  for (let i = 0; i < 100; i++) {
    let f = 0
    let df = 0
    cf.forEach((c, t) => {
      f += c / (1 + r) ** t
      df -= (t * c) / (1 + r) ** (t + 1)
    })
    if (Math.abs(f) < 1e-9) return r
    if (df === 0) break
    r -= f / df
  }
  throw new Error("#NUM: IRR did not converge")
}

export const functions = {
  SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, PRODUCT, MEDIAN,
  ROUND, ROUNDUP, ROUNDDOWN, ABS, SQRT, POWER, MOD,
  IF, IFERROR, AND, OR, NOT,
  SUMIF, COUNTIF, AVERAGEIF, XLOOKUP,
  CONCAT, LEN, UPPER, LOWER, TRIM,
  TODAY, DATE, YEAR, MONTH, DAY, EOMONTH, DAYS,
  PMT, FV, NPV, IRR,
}

export const FUNCTION_NAMES = Object.keys(functions)
