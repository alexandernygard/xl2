import { createCollabHandler } from "@alexandernygard/collab/cloudflare"
import { createHandler } from "@alexandernygard/ai-kit-server"
import { assistantKit, type Context } from "./assistant"
import { createAuth, guard } from "./auth/auth"
import { createMeter, d1UsageStore } from "./auth/usage"

export { DocRoom } from "@alexandernygard/collab/cloudflare"

interface Env {
  DOC_ROOM: DurableObjectNamespace
  ASSETS: Fetcher
  /** The app's Claude key: a secret set in the Cloudflare dashboard (or `wrangler secret put ANTHROPIC_API_KEY`). */
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  /** The assistant's sessions (ai-kit). */
  DB: D1Database
  /** The shared ai-usage database from the auth repo: per-user spend, shown on auth.nyggis.com → AI usage. */
  AI_USAGE: D1Database
  /** Nyggis accounts. Default https://auth.nyggis.com; http://localhost:8787 in .dev.vars. */
  AUTH_ORIGIN?: string
}

// Room ids are 22 random base64url characters (128 bits), minted in the browser when a workbook is shared.
// Knowing the id is the permission: anyone with the link can edit. Sign-in and per-user access come later.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

const collab = createCollabHandler<Env>({
  rooms: (env) => env.DOC_ROOM,
  authorize: (_req, _env, docId) => (ROOM_ID.test(docId) ? { userId: "guest" } : { userId: "" }),
})

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

/** Routes that start or continue a run, and so call Claude. */
const RUNS = /^\/api\/ai\/sessions\/[^/]+\/(messages|resume|respond|regenerate)$/

let services: ReturnType<typeof setup> | undefined

function setup(env: Env) {
  // The app is public; the assistant needs an account, because it uses the app's key.
  const nyggis = createAuth({ appId: "xl2", origin: env.AUTH_ORIGIN, fallbackMode: "public" })
  const meter = createMeter({ auth: nyggis, store: d1UsageStore(env.AI_USAGE) })
  const kit = assistantKit(env, meter)
  const handler = createHandler<Context>(kit, {
    basePath: "/api/ai",
    agents: ["xl2"],
    // The workbook source rides along with each message.
    clientContext: { maxBytes: 1_000_000 },
    auth: async (req) => {
      const g = await guard(nyggis, req)
      return g.user ? { userId: g.user.id, context: { user: g.user } } : null
    },
  })
  return { nyggis, meter, handler }
}

async function api(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { nyggis, meter, handler } = (services ??= setup(env))
  const url = new URL(req.url)
  const back = new URL("/", req.url).toString()

  if (url.pathname === "/api/account") {
    const result = await nyggis.authenticate(req)
    const urls = { loginUrl: nyggis.loginUrl(back), logoutUrl: nyggis.logoutUrl(back) }
    if (result.status === "refresh") return json(401, { error: "token_expired" })
    const user = result.status === "allow" ? result.user : null
    if (!user) return json(200, { user: null, ...urls })
    const check = await meter.check(user)
    return json(200, { user: { name: user.name, email: user.email }, ...urls, spentUsd: check.spentUsd, limitUsd: check.limitUsd, resetsAt: check.resetsAt })
  }

  if (!url.pathname.startsWith("/api/ai/")) return json(404, { error: "not_found" })
  if (!env.ANTHROPIC_API_KEY) return json(503, { error: "The assistant isn't set up yet: the app has no Claude key." })

  const g = await guard(nyggis, req)
  if (g.response) return g.response
  if (!g.user) return json(401, { error: "Sign in to use the assistant.", code: "unauthenticated", loginUrl: nyggis.loginUrl(back) })
  if (req.method === "POST" && RUNS.test(url.pathname)) {
    const check = await meter.check(g.user)
    if (!check.allowed)
      return json(429, {
        error: `You've used today's assistant allowance ($${check.limitUsd.toFixed(2)}). It resets at midnight UTC.`,
        code: "ai_limit",
        resetsAt: check.resetsAt,
      })
  }
  return handler(req, { waitUntil: (p) => ctx.waitUntil(p) })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/")) return api(request, env, ctx)
    return (await collab(request, env)) ?? env.ASSETS.fetch(request)
  },
}
