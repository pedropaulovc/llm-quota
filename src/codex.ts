/**
 * ChatGPT (Codex) subscription quota probe.
 *
 * Usage: GET https://chatgpt.com/backend-api/wham/usage
 *
 * The payload reports plan windows under `rate_limit`, per-model meters under
 * `additional_rate_limits[]`, and a pay-as-you-go balance under `credits`.
 * Window resets are epoch SECONDS; `credits.balance` is a decimal string
 * denominated in CREDITS, not dollars.
 */

import type { Account, AccountQuota, Credits, ProbeOptions, QuotaWindow } from "./types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";

/** ChatGPT sells overage in credits: 25 credits per US dollar. */
export const CREDITS_PER_USD = 25;

/** Credit balances are reported in credits; renderers that show dollars convert here. */
export function creditsToUsd(credits: number): number {
	return credits / CREDITS_PER_USD;
}

/** Wire shape of `wham/usage`. Every value is unverified network data. */
interface RawWhamUsage {
	plan_type?: unknown;
	email?: unknown;
	account_id?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	model_usage?: unknown;
	credits?: unknown;
	spend_control?: unknown;
}

interface RawRateLimit {
	limit_reached?: unknown;
	primary_window?: unknown;
	secondary_window?: unknown;
}

interface RawWindow {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
	reset_after_seconds?: unknown;
}

interface RawAdditionalLimit {
	limit_name?: unknown;
	rate_limit?: unknown;
}

interface RawCredits {
	has_credits?: unknown;
	unlimited?: unknown;
	overage_limit_reached?: unknown;
	balance?: unknown;
}

interface RawSpendControl {
	reached?: unknown;
}

interface RawModelUsage {
	available?: unknown;
}

interface RawTokenClaims {
	[AUTH_CLAIM]?: unknown;
}

interface RawAuthClaim {
	chatgpt_account_id?: unknown;
}

interface NormalizedUsage {
	windows: QuotaWindow[];
	credits?: Credits;
	notes: string[];
	plan?: string;
}

/** Window duration in seconds → stable id fragment: 18000 → "5h", 604800 → "weekly". */
function windowSpan(seconds: unknown): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
	if (seconds === 18000) return "5h";
	if (seconds === 604800) return "weekly";
	return `${Math.round(seconds / 3600)}h`;
}

function readWindow(
	raw: unknown,
	now: number,
	meter: { idPrefix?: string; labelPrefix?: string; primary: boolean; limitReached: boolean },
): QuotaWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const window = raw as RawWindow;
	if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;
	const span = windowSpan(window.limit_window_seconds);
	if (span === undefined) return undefined;

	const resetAt =
		typeof window.reset_at === "number" && Number.isFinite(window.reset_at) ? window.reset_at * 1000 : undefined;
	const resetAfter =
		typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)
			? now + window.reset_after_seconds * 1000
			: undefined;
	// Named meters sit next to the plan rows, so their label must carry the duration too.
	const duration = span === "weekly" ? "7d" : span;

	return {
		id: meter.idPrefix === undefined ? span : `${meter.idPrefix}-${span}`,
		label: meter.labelPrefix === undefined ? span : `${meter.labelPrefix} ${duration}`,
		usedPercent: window.used_percent,
		resetsAt: resetAt ?? resetAfter,
		exhausted: meter.limitReached || window.used_percent >= 100,
		primary: meter.primary,
	};
}

/**
 * Pure normalizer for the usage body. `now` backs the `reset_after_seconds`
 * fallback. Throws `unexpected usage payload` when nothing meterable can be read.
 */
export function normalizeCodexUsage(payload: unknown, now: number = Date.now()): NormalizedUsage {
	if (typeof payload !== "object" || payload === null) throw new Error("unexpected usage payload");
	const usage = payload as RawWhamUsage;

	const windows: QuotaWindow[] = [];
	if (typeof usage.rate_limit === "object" && usage.rate_limit !== null) {
		const plan = usage.rate_limit as RawRateLimit;
		const limitReached = plan.limit_reached === true;
		const primary = readWindow(plan.primary_window, now, { primary: true, limitReached });
		if (primary !== undefined) windows.push(primary);
		const secondary = readWindow(plan.secondary_window, now, { primary: true, limitReached });
		if (secondary !== undefined) windows.push(secondary);
	}

	const additional = Array.isArray(usage.additional_rate_limits) ? usage.additional_rate_limits : [];
	for (const entry of additional) {
		if (typeof entry !== "object" || entry === null) continue;
		const extra = entry as RawAdditionalLimit;
		const name = extra.limit_name;
		if (typeof name !== "string" || name.length === 0) continue;
		if (typeof extra.rate_limit !== "object" || extra.rate_limit === null) continue;
		const limit = extra.rate_limit as RawRateLimit;

		const meter = {
			idPrefix: name
				.toLowerCase()
				.replace(/[^a-z0-9.]+/g, "-")
				.replace(/^-+|-+$/g, ""),
			labelPrefix: name,
			primary: false,
			limitReached: limit.limit_reached === true,
		};
		const main = readWindow(limit.primary_window, now, meter);
		if (main !== undefined) windows.push(main);
		const trailing = readWindow(limit.secondary_window, now, meter);
		if (trailing !== undefined && trailing.usedPercent > 0) windows.push(trailing);
	}
	if (windows.length === 0) throw new Error("unexpected usage payload");

	const notes: string[] = [];
	let credits: Credits | undefined;
	if (typeof usage.credits === "object" && usage.credits !== null) {
		const wallet = usage.credits as RawCredits;
		const raw = wallet.balance;
		const balance = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
		const nothingToShow = wallet.has_credits === false && balance === 0;
		if (Number.isFinite(balance) && !nothingToShow) {
			credits = {
				balance,
				currency: "credits",
				usd: creditsToUsd(balance),
				limitReached: wallet.overage_limit_reached === true,
			};
		}
		if (wallet.unlimited === true) notes.push("unlimited credits");
	}

	if (typeof usage.spend_control === "object" && usage.spend_control !== null) {
		if ((usage.spend_control as RawSpendControl).reached === true) notes.push("spend cap reached");
	}

	if (typeof usage.model_usage === "object" && usage.model_usage !== null) {
		for (const [model, state] of Object.entries(usage.model_usage)) {
			if (typeof state !== "object" || state === null) continue;
			if ((state as RawModelUsage).available === false) notes.push(`${model} unavailable`);
		}
	}

	const plan = typeof usage.plan_type === "string" && usage.plan_type.length > 0 ? usage.plan_type : undefined;
	return { windows, credits, notes, plan };
}

/** The access token is a JWT whose auth claim carries the account the usage API wants. */
function accountIdFromToken(accessToken: string): string | undefined {
	const segment = accessToken.split(".")[1];
	if (segment === undefined || segment.length === 0) return undefined;
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	try {
		const claims: unknown = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
		if (typeof claims !== "object" || claims === null) return undefined;
		const auth = (claims as RawTokenClaims)[AUTH_CLAIM];
		if (typeof auth !== "object" || auth === null) return undefined;
		const id = (auth as RawAuthClaim).chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** `accessToken` is passed only so a body that echoes it never reaches the report. */
async function httpError(response: Response, accessToken: string): Promise<string> {
	if (response.status === 401) return "HTTP 401 (token rejected — re-login)";
	const body = await response.text().catch(() => "");
	const snippet = body.replaceAll(accessToken, "<token>").replace(/\s+/g, " ").trim().slice(0, 160);
	if (snippet.length === 0) return `HTTP ${response.status}`;
	return `HTTP ${response.status}: ${snippet}`;
}

function failure(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `timed out after ${Math.round(timeoutMs / 100) / 10}s`;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Fetch and normalize one ChatGPT account's quota. Never throws. */
export async function probeCodex(account: Account, opts: ProbeOptions): Promise<AccountQuota> {
	const accountId = account.accountId ?? accountIdFromToken(account.accessToken);
	if (accountId === undefined) {
		return { account, windows: [], notes: [], error: "no chatgpt-account-id in credential or token — re-login" };
	}

	const call = opts.fetch ?? fetch;
	try {
		const response = await call(USAGE_URL, {
			headers: {
				authorization: `Bearer ${account.accessToken}`,
				"chatgpt-account-id": accountId,
				accept: "application/json",
			},
			signal: AbortSignal.timeout(opts.timeoutMs),
		});
		if (!response.ok) {
			const error = await httpError(response, account.accessToken);
			return { account: { ...account, accountId }, windows: [], notes: [], error };
		}

		const payload: unknown = await response.json();
		const { windows, credits, notes, plan } = normalizeCodexUsage(payload);
		// normalizeCodexUsage proved `payload` is an object; its own fields stay unverified.
		const reported = payload as RawWhamUsage;
		const email = typeof reported.email === "string" && reported.email.length > 0 ? reported.email : undefined;

		return {
			account: {
				...account,
				accountId,
				email: account.email ?? email,
				plan: account.plan ?? plan,
				label: account.email === undefined && email !== undefined ? email : account.label,
			},
			windows,
			credits,
			notes,
		};
	} catch (error) {
		return { account, windows: [], notes: [], error: failure(error, opts.timeoutMs) };
	}
}
