/**
 * Anthropic subscription quota probe.
 *
 * Usage:    GET https://api.anthropic.com/api/oauth/usage
 * Identity: GET https://api.anthropic.com/api/oauth/profile
 *
 * The usage payload carries both a modern `limits[]` array and the legacy
 * scalar buckets (`five_hour`, `seven_day`, ...). `limits[]` wins when present.
 */

import type { Account, AccountQuota, Credits, ProbeOptions, QuotaWindow } from "./types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** Wire shape of `/api/oauth/usage`. Every value is unverified network data. */
interface RawUsage {
	limits?: unknown;
	five_hour?: unknown;
	seven_day?: unknown;
	seven_day_opus?: unknown;
	seven_day_sonnet?: unknown;
	seven_day_oauth_apps?: unknown;
	spend?: unknown;
	extra_usage?: unknown;
}

interface RawLimit {
	kind?: unknown;
	percent?: unknown;
	severity?: unknown;
	resets_at?: unknown;
	scope?: unknown;
}

interface RawScope {
	model?: unknown;
}

interface RawScopedModel {
	display_name?: unknown;
}

interface RawBucket {
	utilization?: unknown;
	resets_at?: unknown;
	locked_reason?: unknown;
}

interface RawSpend {
	enabled?: unknown;
	severity?: unknown;
	balance?: unknown;
	used?: unknown;
}

interface RawExtraUsage {
	spend_limit_reached?: unknown;
}

interface RawMoney {
	amount_minor?: unknown;
	currency?: unknown;
	exponent?: unknown;
}

/**
 * Wire shape of `/api/oauth/profile`; the id/email live at either nesting level.
 * The usage endpoint never reports the plan, so the tier is read from here.
 */
interface RawProfile {
	uuid?: unknown;
	email?: unknown;
	account?: unknown;
	organization?: unknown;
}

interface RawProfileAccount {
	uuid?: unknown;
	email?: unknown;
	has_claude_max?: unknown;
	has_claude_pro?: unknown;
}

interface RawProfileOrganization {
	uuid?: unknown;
	name?: unknown;
	organization_type?: unknown;
	rate_limit_tier?: unknown;
}

export interface ClaudeIdentity {
	accountId?: string;
	email?: string;
	plan?: string;
	/** Organization uuid: part of the identity key, since one email can hold two grants. */
	orgId?: string;
	orgName?: string;
}

interface NormalizedUsage {
	windows: QuotaWindow[];
	credits?: Credits;
	notes: string[];
}

/** Both OAuth endpoints must be called with exactly these headers. */
function oauthHeaders(accessToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${accessToken}`,
		"anthropic-beta": "oauth-2025-04-20",
		accept: "application/json",
		"content-type": "application/json",
		"user-agent": "claude-cli/2.0.0 (external, cli)",
	};
}

/**
 * Anthropic money objects hold minor units scaled by `exponent` (cents when 2).
 * `undefined` for any shape that cannot yield a real amount: dropping the
 * balance is correct, rendering a negative or NaN one as money is not.
 */
function moneyAmount(value: unknown): { amount: number; currency: string } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const money = value as RawMoney;
	const minor = money.amount_minor;
	if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return undefined;
	const exponent = money.exponent === undefined ? 2 : money.exponent;
	if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) return undefined;
	const amount = minor / 10 ** exponent;
	if (!Number.isFinite(amount)) return undefined;
	return { amount, currency: typeof money.currency === "string" ? money.currency : "USD" };
}

function windowsFromLimits(limits: readonly unknown[]): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	for (const row of limits) {
		if (typeof row !== "object" || row === null) continue;
		const limit = row as RawLimit;
		if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) continue;

		const resets = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : Number.NaN;
		const metered = {
			usedPercent: limit.percent,
			resetsAt: Number.isFinite(resets) ? resets : undefined,
			exhausted: limit.percent >= 100 || limit.severity === "exhausted",
		};

		if (limit.kind === "session") {
			windows.push({ id: "5h", label: "5h", primary: true, ...metered });
			continue;
		}
		if (limit.kind === "weekly_all") {
			windows.push({ id: "7d", label: "7d", primary: true, ...metered });
			continue;
		}
		if (limit.kind !== "weekly_scoped") continue;

		if (typeof limit.scope !== "object" || limit.scope === null) continue;
		const model = (limit.scope as RawScope).model;
		if (typeof model !== "object" || model === null) continue;
		const name = (model as RawScopedModel).display_name;
		if (typeof name !== "string" || name.length === 0) continue;

		const id = name
			.toLowerCase()
			.replace(/[^a-z0-9.]+/g, "-")
			.replace(/^-+|-+$/g, "");
		windows.push({ id: `${id}-7d`, label: `${name} 7d`, primary: false, ...metered });
	}
	return windows;
}

/** Pre-`limits[]` payloads only expose the scalar buckets. */
function windowsFromBuckets(usage: RawUsage): QuotaWindow[] {
	const buckets = [
		{ raw: usage.five_hour, id: "5h", label: "5h", primary: true },
		{ raw: usage.seven_day, id: "7d", label: "7d", primary: true },
		{ raw: usage.seven_day_opus, id: "opus-7d", label: "Opus 7d", primary: false },
		{ raw: usage.seven_day_sonnet, id: "sonnet-7d", label: "Sonnet 7d", primary: false },
	];

	const windows: QuotaWindow[] = [];
	for (const bucket of buckets) {
		if (typeof bucket.raw !== "object" || bucket.raw === null) continue;
		const scalar = bucket.raw as RawBucket;
		if (typeof scalar.utilization !== "number" || !Number.isFinite(scalar.utilization)) continue;
		const resets = typeof scalar.resets_at === "string" ? Date.parse(scalar.resets_at) : Number.NaN;
		windows.push({
			id: bucket.id,
			label: bucket.label,
			usedPercent: scalar.utilization,
			resetsAt: Number.isFinite(resets) ? resets : undefined,
			exhausted: scalar.utilization >= 100,
			primary: bucket.primary,
		});
	}
	return windows;
}

/** One window per id (worst utilization wins), primaries first: 5h, 7d, then the rest. */
function collapse(windows: readonly QuotaWindow[]): QuotaWindow[] {
	const worst = new Map<string, QuotaWindow>();
	for (const window of windows) {
		const seen = worst.get(window.id);
		if (seen !== undefined && seen.usedPercent >= window.usedPercent) continue;
		worst.set(window.id, window);
	}
	const rank = (window: QuotaWindow): number => {
		if (window.primary !== true) return 2;
		return window.id === "5h" ? 0 : 1;
	};
	return [...worst.values()].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/**
 * `locked` note for the first locked bucket. `locked_reason` is free-form
 * provider text that can echo a rejected credential, so it is only quoted when
 * it looks like a reason code (`usage_limit_reached`); anything longer or
 * richer degrades to the bare note rather than printing the provider's string.
 */
function lockedNote(usage: RawUsage): string | undefined {
	const buckets = [usage.five_hour, usage.seven_day, usage.seven_day_opus, usage.seven_day_sonnet, usage.seven_day_oauth_apps];
	for (const raw of buckets) {
		if (typeof raw !== "object" || raw === null) continue;
		const reason = (raw as RawBucket).locked_reason;
		if (typeof reason !== "string" || reason.length === 0) continue;
		if (reason.length > 48 || !/^[a-z0-9_.:-]+$/.test(reason)) return "locked";
		return `locked: ${reason}`;
	}
	return undefined;
}

/**
 * Pure normalizer for the usage body. `now` is accepted for signature parity with
 * the Codex normalizer; Anthropic reports absolute ISO reset timestamps.
 * Throws `unexpected usage payload` when nothing meterable can be read.
 */
export function normalizeClaudeUsage(payload: unknown, now: number = Date.now()): NormalizedUsage {
	void now;
	if (typeof payload !== "object" || payload === null) throw new Error("unexpected usage payload");
	const usage = payload as RawUsage;

	const limits = Array.isArray(usage.limits) ? usage.limits : [];
	const windows = collapse(limits.length > 0 ? windowsFromLimits(limits) : windowsFromBuckets(usage));
	if (windows.length === 0) throw new Error("unexpected usage payload");

	const spend = typeof usage.spend === "object" && usage.spend !== null ? (usage.spend as RawSpend) : undefined;
	const extra =
		typeof usage.extra_usage === "object" && usage.extra_usage !== null ? (usage.extra_usage as RawExtraUsage) : undefined;
	const capReached = spend?.severity === "exhausted" || extra?.spend_limit_reached === true;

	const notes: string[] = [];
	let credits: Credits | undefined;
	if (spend?.enabled === true) {
		const balance = moneyAmount(spend.balance);
		const used = moneyAmount(spend.used);
		if (balance !== undefined) credits = { balance: balance.amount, currency: balance.currency, limitReached: capReached };
		if (balance === undefined && used !== undefined) notes.push(`extra usage: $${used.amount.toFixed(2)} used`);
	}
	if (capReached) notes.push("spend cap reached");

	const locked = lockedNote(usage);
	if (locked !== undefined) notes.push(locked);

	return { windows, credits, notes };
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

/**
 * Subscription tier for display. The profile reports it three ways, most
 * specific first: `default_claude_max_20x` → `max 20x`, `claude_pro` → `pro`.
 */
function displayPlan(organization: RawProfileOrganization | undefined, account: RawProfileAccount | undefined): string | undefined {
	for (const raw of [organization?.rate_limit_tier, organization?.organization_type]) {
		if (typeof raw !== "string" || raw.length === 0) continue;
		const tier = raw.replace(/^default_/, "").replace(/^claude_/, "").replaceAll("_", " ").trim();
		if (tier.length > 0) return tier;
	}
	if (account?.has_claude_max === true) return "max";
	if (account?.has_claude_pro === true) return "pro";
	return undefined;
}

/**
 * Best-effort account identity so multiple Anthropic credentials render as
 * distinguishable rows. Never throws and never gates the usage probe.
 */
export async function fetchClaudeIdentity(accessToken: string, opts: ProbeOptions): Promise<ClaudeIdentity> {
	const call = opts.fetch ?? fetch;
	try {
		const response = await call(PROFILE_URL, {
			headers: oauthHeaders(accessToken),
			signal: AbortSignal.timeout(opts.timeoutMs),
		});
		if (!response.ok) return {};
		const payload: unknown = await response.json();
		if (typeof payload !== "object" || payload === null) return {};
		const profile = payload as RawProfile;
		const nested =
			typeof profile.account === "object" && profile.account !== null ? (profile.account as RawProfileAccount) : undefined;
		const organization =
			typeof profile.organization === "object" && profile.organization !== null
				? (profile.organization as RawProfileOrganization)
				: undefined;

		const uuid = typeof profile.uuid === "string" && profile.uuid.length > 0 ? profile.uuid : nested?.uuid;
		const address = typeof profile.email === "string" && profile.email.length > 0 ? profile.email : nested?.email;
		const orgId = organization?.uuid;
		const orgName = organization?.name;
		return {
			accountId: typeof uuid === "string" && uuid.length > 0 ? uuid : undefined,
			email: typeof address === "string" && address.length > 0 ? address : undefined,
			plan: displayPlan(organization, nested),
			orgId: typeof orgId === "string" && orgId.length > 0 ? orgId : undefined,
			orgName: typeof orgName === "string" && orgName.length > 0 ? orgName : undefined,
		};
	} catch {
		return {};
	}
}

/** Fetch and normalize one Anthropic account's quota. Never throws. */
export async function probeClaude(account: Account, opts: ProbeOptions): Promise<AccountQuota> {
	const call = opts.fetch ?? fetch;
	const usage = call(USAGE_URL, {
		headers: oauthHeaders(account.accessToken),
		signal: AbortSignal.timeout(opts.timeoutMs),
	});
	// The usage endpoint reports neither identity nor plan, so recover both at once.
	// Unconditional: a store that happens to know an email and a coarse "max" would
	// otherwise render a different plan than its profile-probed twin ("max" vs
	// "max 20x") purely by accident of which store it came from, and the org uuid
	// this returns is what merges a credential with that twin.
	const identity = fetchClaudeIdentity(account.accessToken, opts);

	try {
		const [response, who] = await Promise.all([usage, identity]);
		const resolved: Account = {
			...account,
			accountId: account.accountId ?? who.accountId,
			email: account.email ?? who.email,
			// organization.rate_limit_tier is more precise than a stored subscriptionType.
			plan: who.plan ?? account.plan,
			orgId: account.orgId ?? who.orgId,
			orgName: who.orgName ?? account.orgName,
			// The store's label already reflects any email it knew; only fill a blind one.
			label: account.email === undefined ? who.email ?? account.label : account.label,
		};
		if (!response.ok) {
			return { account: resolved, windows: [], notes: [], error: await httpError(response, account.accessToken) };
		}

		const { windows, credits, notes } = normalizeClaudeUsage(await response.json());
		return { account: resolved, windows, credits, notes };
	} catch (error) {
		return { account, windows: [], notes: [], error: failure(error, opts.timeoutMs) };
	}
}
