/**
 * Browser helper for Nyggis accounts. Copy into client-side code.
 *
 * Access tokens last 10 minutes. When an API call returns 401 token_expired, this refreshes the
 * session once (POST to the auth service, which sets fresh cookies) and retries the request.
 */
const AUTH_ORIGIN = 'https://auth.nyggis.com';

let refreshing: Promise<boolean> | null = null;

function refresh(origin: string): Promise<boolean> {
	refreshing ??= fetch(`${origin}/refresh`, { method: 'POST', credentials: 'include' })
		.then((r) => r.ok)
		.catch(() => false)
		.finally(() => (refreshing = null));
	return refreshing;
}

export async function fetchWithRefresh(input: RequestInfo | URL, init?: RequestInit, origin = AUTH_ORIGIN): Promise<Response> {
	const res = await fetch(input, init);
	if (res.status !== 401) return res;
	const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
	if (body?.error !== 'token_expired') return res;
	return (await refresh(origin)) ? fetch(input, init) : res;
}
