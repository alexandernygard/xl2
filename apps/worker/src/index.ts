import { createCollabHandler } from "@alexandernygard/collab/cloudflare"

export { DocRoom } from "@alexandernygard/collab/cloudflare"

interface Env {
  DOC_ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

// Room ids are 22 random base64url characters (128 bits), minted in the browser when a workbook is shared.
// Knowing the id is the permission: anyone with the link can edit. Sign-in and per-user access come later.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

const collab = createCollabHandler<Env>({
  rooms: (env) => env.DOC_ROOM,
  authorize: (_req, _env, docId) => (ROOM_ID.test(docId) ? { userId: "guest" } : { userId: "" }),
})

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await collab(request, env)) ?? env.ASSETS.fetch(request)
  },
}
