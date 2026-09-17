/**
 * OAuth refresh for the two subscription providers.
 *
 * Both providers ROTATE refresh tokens: the caller MUST persist
 * `RefreshedTokens.refreshToken` or the grant family is lost.
 */

import type { ProbeOptions } from "./types.ts";

const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DAY_MS = 86_400_000;
/**
 * Bounds for expiries derived from network data. A finite but absurd
 * `expires_in`/`exp` (a seconds-vs-milliseconds mixup, or `9e15`) multiplies
 * into a timestamp millennia out: the credential then looks valid forever, is
 * never refreshed, and every later probe reports HTTP 401 instead of healing.
 */
const MAX_REFRESH_LIFE_MS = 400 * DAY_MS;
/** How stale a decoded JWT `exp` may be and still be a real timestamp. */
const MAX_JWT_AGE_MS = 3_650 * DAY_MS;

export interface RefreshedTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
}

/**
 * Truncated, secret-free description of a failed token exchange. The sent
 * refresh token is redacted: an OAuth error body may echo the credential it
 * rejected, and this message reaches stdout as a `refresh failed: …` row.
 */
async function refreshFailure(provider: string, response: Response, sentRefreshToken: string): Promise<Error> {
	const encoded = encodeURIComponent(sentRefreshToken);
	// An error body can echo the credential in any serialization the request
	// used: raw, percent-encoded, the exact `URLSearchParams` form the codex
	// refresh POSTs (it escapes `~!'()`, which `encodeURIComponent` leaves
	// bare), form-encoded (`+` for space), or JSON-escaped. Longest first, so a
	// shorter encoding never truncates a longer one into a surviving tail.
	const variants = [
		...new Set([
			sentRefreshToken,
			encoded,
			encoded.replaceAll("%20", "+"),
			new URLSearchParams({ t: sentRefreshToken }).toString().slice(2),
			JSON.stringify(sentRefreshToken).slice(1, -1),
		]),
	]
		.filter((variant) => variant.length > 0)
		.sort((a, b) => b.length - a.length);
	let body = await response.text().catch(() => "");
	for (const variant of variants) body = body.replaceAll(variant, "<token>");
	const detail = body.length > 200 ? `${body.slice(0, 200)}…` : body;
	return new Error(`${provider} token refresh failed: HTTP ${response.status} ${detail}`.trimEnd());
}

function readTokens(provider: string, payload: TokenResponse, sentRefreshToken: string): RefreshedTokens {
	const accessToken = payload.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error(`${provider} token refresh returned no access_token`);
	}
	const expiresIn = payload.expires_in;
	// `typeof NaN === "number"`, and `{"expires_in":1e309}` parses to Infinity;
	// either would persist as a NaN/null expiry and refresh on every later run.
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
		throw new Error(`${provider} token refresh returned no usable expires_in`);
	}
	// The window below tolerates an expiry up to a day in the past for clock
	// skew, so `0` or `-3600` would sail through it: the CLI would persist an
	// already-dead token and probe with it anyway.
	if (expiresIn <= 0) {
		throw new Error(`${provider} token refresh returned an implausible expires_in`);
	}
	const rotated = payload.refresh_token;
	const now = Date.now();
	const expiresAt = now + expiresIn * 1000;
	if (!Number.isFinite(expiresAt) || expiresAt < now - DAY_MS || expiresAt > now + MAX_REFRESH_LIFE_MS) {
		throw new Error(`${provider} token refresh returned an implausible expires_in`);
	}
	return {
		accessToken,
		// Rotation is optional per response; keeping the sent token is required
		// so a response without one does not brick the grant.
		refreshToken: typeof rotated === "string" && rotated.length > 0 ? rotated : sentRefreshToken,
		expiresAt,
	};
}

export async function refreshClaudeToken(refreshToken: string, opts: ProbeOptions): Promise<RefreshedTokens> {
	const doFetch = opts.fetch ?? fetch;
	const response = await doFetch(CLAUDE_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			"anthropic-beta": "oauth-2025-04-20",
		},
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLAUDE_CLIENT_ID,
		}),
		signal: AbortSignal.timeout(opts.timeoutMs),
	});
	if (!response.ok) throw await refreshFailure("anthropic", response, refreshToken);
	return readTokens("anthropic", (await response.json()) as TokenResponse, refreshToken);
}

export async function refreshCodexToken(refreshToken: string, opts: ProbeOptions): Promise<RefreshedTokens> {
	const doFetch = opts.fetch ?? fetch;
	const response = await doFetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CODEX_CLIENT_ID,
			scope: "openid profile email",
		}).toString(),
		signal: AbortSignal.timeout(opts.timeoutMs),
	});
	if (!response.ok) throw await refreshFailure("codex", response, refreshToken);
	return readTokens("codex", (await response.json()) as TokenResponse, refreshToken);
}

/**
 * Epoch ms of a JWT's `exp` claim. `undefined` for anything that is not a JWT
 * carrying a numeric `exp` inside a plausible epoch-ms band — never throws, so
 * an unreadable token is treated as "expiry unknown" and gets refreshed.
 */
export function decodeJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (payload === undefined || payload.length === 0) return undefined;
	try {
		const json = Buffer.from(payload, "base64url").toString("utf8");
		const claims = JSON.parse(json) as { exp?: unknown };
		if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return undefined;
		const expiresAt = claims.exp * 1000;
		const now = Date.now();
		if (!Number.isFinite(expiresAt) || expiresAt < now - MAX_JWT_AGE_MS || expiresAt > now + MAX_REFRESH_LIFE_MS) {
			return undefined;
		}
		return expiresAt;
	} catch {
		return undefined;
	}
}
