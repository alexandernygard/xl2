import * as React from "react"
import { fetchWithRefresh } from "./auth/browser"

// Who's signed in, as the Worker sees it, and how much of today's assistant allowance they've used.
// The assistant uses the app's Claude key, so it needs a Nyggis account.

export type AccountState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "signed-out"; loginUrl: string }
  | { status: "signed-in"; name: string | null; email: string; logoutUrl: string; spentUsd: number; limitUsd: number }

interface AccountResponse {
  user: { name: string | null; email: string } | null
  loginUrl: string
  logoutUrl: string
  spentUsd?: number
  limitUsd?: number
}

export function useAccount(): { state: AccountState; reload: () => void } {
  const [state, setState] = React.useState<AccountState>({ status: "loading" })
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    let live = true
    fetchWithRefresh("/api/account", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const a = (await res.json()) as AccountResponse
        if (!live) return
        // Back to this page after signing in.
        const loginUrl = a.loginUrl.replace(/next=[^&]*/, `next=${encodeURIComponent(location.href)}`)
        setState(
          a.user
            ? { status: "signed-in", name: a.user.name, email: a.user.email, logoutUrl: a.logoutUrl, spentUsd: a.spentUsd ?? 0, limitUsd: a.limitUsd ?? 0 }
            : { status: "signed-out", loginUrl },
        )
      })
      .catch(() => live && setState({ status: "unavailable" }))
    return () => {
      live = false
    }
  }, [version])
  return { state, reload: React.useCallback(() => setVersion((v) => v + 1), []) }
}
