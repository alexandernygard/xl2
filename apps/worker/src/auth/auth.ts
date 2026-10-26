/**
 * Nyggis accounts: client for apps. Copy this file into an app (src/lib/auth.ts or similar);
 * its only dependency is `jose`. Source of truth: github.com/alexandernygard/auth/client/auth.ts.
 *
 * - Verifies the `nyggis_at` cookie (a short-lived ES256 JWT) locally against the public keys
 *   at <origin>/.well-known/jwks.json. No call to the auth service on normal requests.
 * - Reads the app's mode and default role from <origin>/apps/<appId>.json (cached 60 s),
 *   so access changes in the admin console need no deploy.
 * - Works on Cloudflare Workers, Node 18+, Bun, Deno.
 */
import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload } from 'jose';

export const VERSION = 1;

export type Mode = 'public' | 'signed_in' | 'invite_only';

export interface AppConfig {
	id: string;
	name: string;
	url: string | null;
	mode: Mode;
	default_role: string | null;
	/** Claude API spend per signed-in user per UTC day, in USD. A role's limit wins; null means the app decides. See usage.ts. */
	ai_daily_usd?: number | null;
	roles: { role: string; rank: number; description: string | null; ai_daily_usd?: number | null }[];
}

export interface User {
	/** Stable account id (usr_…). Key your data on this, never on email. */
	id: string;
	email: string;
	name: string | null;
	picture: string | null;
	/** Role in this app: explicit grant, else a grant on all apps, else the app's default role. */
	role: string | null;
	/** All explicit grants (app id or '*' → role), e.g. to show links to other apps. */
	grants: Record<string, string>;
	sessionId: string;
}

export type AuthResult = { status: 'allow'; user: User | null } | { status: 'login' | 'deny' | 'refresh' };

export interface AuthOptions {
	appId: string;
	/** Defaults to https://auth.nyggis.com. Use http://localhost:8787 against a local auth Worker. */
	origin?: string;
	/** Used only when the config was never fetched and the auth service is unreachable. Default invite_only (fail closed). */
	fallbackMode?: Mode;
	configTtlMs?: number;
}

interface Claims extends JWTPayload {
	sub: string;
	sid: string;
	email: string;
	name?: string;
	picture?: string;
	grants?: Record<string, string>;
}

export const ACCESS_COOKIE = 'nyggis_at';

export function readCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq !== -1 && part.slice(0, eq).trim() === name) {
			try {
				return decodeURIComponent(part.slice(eq + 1).trim());
			} catch {
				return null;
			}
		}
	}
	return null;
}

/** The access rule. Same logic as the auth service's own `decide`. */
export function decide(config: Pick<AppConfig, 'id' | 'mode' | 'default_role'>, grants: Record<string, string> | null): { allow: true; role: string | null } | { allow: false; reason: 'login' | 'deny' } {
	if (!grants) return config.mode === 'public' ? { allow: true, role: null } : { allow: false, reason: 'login' };
	const explicit = grants[config.id] ?? grants['*'];
	if (explicit) return { allow: true, role: explicit };
	if (config.mode === 'invite_only') return { allow: false, reason: 'deny' };
	return { allow: true, role: config.default_role };
}

export function createAuth(options: AuthOptions) {
	const origin = (options.origin ?? 'https://auth.nyggis.com').replace(/\/$/, '');
	const appId = options.appId;
	const ttl = options.configTtlMs ?? 60_000;
	const jwks = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`));
	const fallback: AppConfig = { id: appId, name: appId, url: null, mode: options.fallbackMode ?? 'invite_only', default_role: null, roles: [] };
	let cached: { config: AppConfig; at: number } | undefined;
	let inflight: Promise<AppConfig> | undefined;

	/** This app's published config. Unknown app → invite-only. Unreachable → last known config, else fallback. */
	async function config(): Promise<AppConfig> {
		if (cached && Date.now() - cached.at < ttl) return cached.config;
		inflight ??= (async () => {
			try {
				const res = await fetch(`${origin}/apps/${appId}.json`, { headers: { Accept: 'application/json' } });
				if (res.status === 404) cached = { config: { ...fallback, mode: 'invite_only' }, at: Date.now() };
				else if (res.ok) cached = { config: (await res.json()) as AppConfig, at: Date.now() };
				else if (!cached) return fallback;
			} catch {
				if (!cached) return fallback;
			}
			return cached!.config;
		})().finally(() => (inflight = undefined));
		return inflight;
	}

	/** Verified claims, null when signed out (or the token is invalid), 'expired' when it should be refreshed. */
	async function verifyToken(token: string | null): Promise<Claims | null | 'expired'> {
		if (!token) return null;
		try {
			const { payload } = await jwtVerify(token, jwks, { issuer: origin, audience: 'nyggis', algorithms: ['ES256'] });
			return payload as Claims;
		} catch (e) {
			return e instanceof errors.JWTExpired ? 'expired' : null;
		}
	}

	async function authenticate(request: Request): Promise<AuthResult> {
		const [cfg, claims] = await Promise.all([config(), verifyToken(readCookie(request.headers.get('Cookie'), ACCESS_COOKIE))]);
		if (claims === 'expired') return { status: 'refresh' };
		const d = decide(cfg, claims ? (claims.grants ?? {}) : null);
		if (!d.allow) return { status: d.reason };
		if (!claims) return { status: 'allow', user: null };
		return {
			status: 'allow',
			user: { id: claims.sub, email: claims.email, name: claims.name ?? null, picture: claims.picture ?? null, role: d.role, grants: claims.grants ?? {}, sessionId: claims.sid },
		};
	}

	const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

	return {
		appId,
		origin,
		config,
		authenticate,
		loginUrl: (next: string) => `${origin}/login?${q({ next })}`,
		refreshUrl: (next: string) => `${origin}/refresh?${q({ next })}`,
		logoutUrl: (next?: string) => `${origin}/logout${next ? `?${q({ next })}` : ''}`,
		deniedUrl: () => `${origin}/denied?${q({ app: appId })}`,
		accountUrl: `${origin}/account/`,

		/** Configs of every registered app (for hubs and app switchers). */
		async allApps(): Promise<AppConfig[]> {
			const res = await fetch(`${origin}/apps.json`);
			if (!res.ok) throw new Error(`apps.json ${res.status}`);
			return ((await res.json()) as { apps: AppConfig[] }).apps;
		},

		/**
		 * Verifies a user-event webhook (POST, body = JWT signed by the auth service for this app).
		 * Handle events idempotently: the same event can arrive more than once.
		 */
		async verifyEvent(request: Request): Promise<{ id: string; type: string; userId: string; at: number; data: Record<string, unknown> }> {
			const { payload } = await jwtVerify(await request.text(), jwks, { issuer: origin, audience: appId, algorithms: ['ES256'] });
			if (payload.typ !== 'event') throw new Error('Not an event token');
			return { id: String(payload.jti), type: String(payload.event), userId: String(payload.sub), at: Number(payload.at), data: (payload.data as Record<string, unknown>) ?? {} };
		},
	};
}

export type Auth = ReturnType<typeof createAuth>;

// ---------- helpers shared by the framework adapters ----------

/** A state-changing request that didn't come from this app's own pages. The cookie is shared by every subdomain. */
export function isCrossOriginWrite(request: Request): boolean {
	if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false;
	return request.headers.get('Origin') !== new URL(request.url).origin;
}

/** Browser page navigations get redirects; everything else (fetch, APIs) gets 401/403. */
export function isNavigation(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const mode = request.headers.get('Sec-Fetch-Mode');
	if (mode) return mode === 'navigate';
	return (request.headers.get('Accept') ?? '').includes('text/html') && !new URL(request.url).pathname.startsWith('/api/');
}

export function hasRole(user: User | null, ...roles: string[]): boolean {
	return !!user?.role && roles.includes(user.role);
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
const json = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Runs the auth check for a request. Returns the user (null on public apps when signed out),
 * or the response to send instead: a redirect for page loads, 401/403 JSON otherwise.
 */
export async function guard(auth: Auth, request: Request): Promise<{ user: User | null; response?: undefined } | { response: Response; user?: undefined }> {
	if (isCrossOriginWrite(request)) return { response: json(403, 'bad_origin') };
	const result = await auth.authenticate(request);
	const nav = isNavigation(request);
	switch (result.status) {
		case 'allow':
			return { user: result.user };
		case 'refresh':
			return { response: nav ? redirect(auth.refreshUrl(request.url)) : json(401, 'token_expired') };
		case 'login':
			return { response: nav ? redirect(auth.loginUrl(request.url)) : json(401, 'unauthenticated') };
		case 'deny':
			return { response: nav ? redirect(auth.deniedUrl()) : json(403, 'forbidden') };
	}
}

/** For account-only routes on public apps. */
export function requireUser(auth: Auth, request: Request, user: User | null): Response | null {
	if (user) return null;
	return isNavigation(request) ? redirect(auth.loginUrl(request.url)) : json(401, 'unauthenticated');
}

/** For routes limited to some roles in this app. */
export function requireRole(request: Request, user: User | null, ...roles: string[]): Response | null {
	if (hasRole(user, ...roles)) return null;
	return json(403, 'forbidden');
}

/** Responses that depend on the visitor must never be cached publicly. */
export function privateResponse(response: Response): Response {
	const out = new Response(response.body, response);
	out.headers.set('Cache-Control', 'private, no-store');
	return out;
}
