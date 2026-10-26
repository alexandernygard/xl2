/**
 * Nyggis accounts: per-user Claude API limits for apps that call Claude with their own key. Copy this
 * file next to auth.ts; it has no dependencies. Source of truth: github.com/alexandernygard/auth/client/usage.ts.
 *
 * - `check(user)` before a call: is the user under today's limit? The limit comes from the app's
 *   published config (admin console → the app → AI), by role, so changing it needs no deploy.
 * - `record(user, response)` after a call: adds the response's tokens and list-price cost to the
 *   shared ai-usage database, where the admin console's AI usage page reads it.
 * - Calls never go through the auth service. Two calls in flight at once can both pass `check`, so a
 *   user can go over by about one call; the Anthropic workspace's spend limit is the hard cap.
 */
import type { Auth, User } from './auth';

export interface ModelPrice {
	/** USD per million tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Anthropic first-party list prices (October 2026), matched to the model id by prefix, longest first.
 * Cache writes are the 5-minute rate. Prices change: check the pricing page and pass `pricing` to override.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
	'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-opus-4': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** The `usage` object on every Claude API response (and on `finalMessage()` of a stream). */
export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

export interface UsageRow {
	appId: string;
	userId: string;
	day: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** Where usage is kept. `d1UsageStore` on Workers; `memoryUsageStore` for local development and tests. */
export interface UsageStore {
	spent(appId: string, userId: string, day: string): Promise<number>;
	add(row: UsageRow): Promise<void>;
}

/** The parts of a D1 binding this file uses, so it type-checks without @cloudflare/workers-types. */
interface D1Like {
	prepare(sql: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null>; run(): Promise<unknown> } };
}

/** The shared ai-usage D1 database (schema: usage-migrations/ in the auth repo). Bind it as AI_USAGE. */
export function d1UsageStore(db: D1Like): UsageStore {
	return {
		async spent(appId, userId, day) {
			const row = await db
				.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_daily WHERE app_id = ? AND user_id = ? AND day = ?')
				.bind(appId, userId, day)
				.first<{ usd: number }>();
			return row?.usd ?? 0;
		},
		async add(r) {
			await db
				.prepare(
					`INSERT INTO usage_daily (app_id, user_id, day, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at)
					 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (app_id, user_id, day, model) DO UPDATE SET
					   requests = requests + 1,
					   input_tokens = input_tokens + excluded.input_tokens,
					   output_tokens = output_tokens + excluded.output_tokens,
					   cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
					   cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
					   cost_usd = cost_usd + excluded.cost_usd,
					   updated_at = excluded.updated_at`,
				)
				.bind(r.appId, r.userId, r.day, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.costUsd, Date.now())
				.run();
		},
	};
}

export function memoryUsageStore(): UsageStore & { rows: UsageRow[] } {
	const rows: UsageRow[] = [];
	return {
		rows,
		async spent(appId, userId, day) {
			return rows.filter((r) => r.appId === appId && r.userId === userId && r.day === day).reduce((sum, r) => sum + r.costUsd, 0);
		},
		async add(row) {
			rows.push(row);
		},
	};
}

export type UsageCheck =
	| { allowed: true; spentUsd: number; limitUsd: number; resetsAt: string }
	/** `login`: signed out (only signed-in users get the app's key). `limit`: today's limit is used up. */
	| { allowed: false; reason: 'login' | 'limit'; spentUsd: number; limitUsd: number; resetsAt: string };

export interface MeterOptions {
	auth: Auth;
	store: UsageStore;
	/** Used when neither the user's role nor the app has a limit in the admin console. Default $0.50 a day. */
	fallbackDailyUsd?: number;
	pricing?: Record<string, ModelPrice>;
}

const today = (now = new Date()) => now.toISOString().slice(0, 10);
const tomorrow = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

export function priceFor(model: string, pricing: Record<string, ModelPrice> = DEFAULT_PRICING): ModelPrice | undefined {
	const key = Object.keys(pricing)
		.filter((k) => model.startsWith(k))
		.sort((a, b) => b.length - a.length)[0];
	return key ? pricing[key] : undefined;
}

/** List-price cost of one response in USD. Unknown models are priced as the most expensive known one, never as free. */
export function costOf(model: string, usage: ClaudeUsage, pricing: Record<string, ModelPrice> = DEFAULT_PRICING): number {
	const price = priceFor(model, pricing) ?? Object.values(pricing).reduce((a, b) => (b.output > a.output ? b : a));
	return (
		(usage.input_tokens * price.input +
			usage.output_tokens * price.output +
			(usage.cache_read_input_tokens ?? 0) * price.cacheRead +
			(usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
		1_000_000
	);
}

export function createMeter(options: MeterOptions) {
	const { auth, store } = options;
	const pricing = options.pricing ?? DEFAULT_PRICING;
	const fallback = options.fallbackDailyUsd ?? 0.5;

	/** Today's limit for this user: their role's, else the app's, else the fallback. */
	async function limitFor(user: User): Promise<number> {
		const config = await auth.config();
		const role = user.role ? config.roles.find((r) => r.role === user.role) : undefined;
		return role?.ai_daily_usd ?? config.ai_daily_usd ?? fallback;
	}

	return {
		limitFor,

		async check(user: User | null): Promise<UsageCheck> {
			const resetsAt = tomorrow();
			if (!user) return { allowed: false, reason: 'login', spentUsd: 0, limitUsd: 0, resetsAt };
			const [limitUsd, spentUsd] = await Promise.all([limitFor(user), store.spent(auth.appId, user.id, today())]);
			if (spentUsd >= limitUsd) return { allowed: false, reason: 'limit', spentUsd, limitUsd, resetsAt };
			return { allowed: true, spentUsd, limitUsd, resetsAt };
		},

		/** Pass the Claude response (or anything with `model` and `usage`). Uses the model that actually answered. */
		async record(user: User, response: { model: string; usage: ClaudeUsage }): Promise<number> {
			const costUsd = costOf(response.model, response.usage, pricing);
			await store.add({
				appId: auth.appId,
				userId: user.id,
				day: today(),
				model: response.model,
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
				cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
				cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
				costUsd,
			});
			return costUsd;
		},
	};
}

export type Meter = ReturnType<typeof createMeter>;

/** The JSON error an API route sends when `check` says no: 401 when signed out, 429 at the limit. */
export function usageDenied(check: Extract<UsageCheck, { allowed: false }>, loginUrl?: string): Response {
	const headers = { 'Cache-Control': 'no-store' };
	if (check.reason === 'login') return Response.json({ error: 'unauthenticated', loginUrl }, { status: 401, headers });
	return Response.json(
		{ error: 'ai_limit', spentUsd: check.spentUsd, limitUsd: check.limitUsd, resetsAt: check.resetsAt },
		{ status: 429, headers: { ...headers, 'Retry-After': String(Math.max(60, Math.ceil((Date.parse(check.resetsAt) - Date.now()) / 1000))) } },
	);
}
