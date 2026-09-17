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

/** Truncated, secret-free description of a failed token exchange. */
async function refreshFailure(provider: string, response: Response): Promise<Error> {
	const body = await response.text().catch(() => "");
	const detail = body.length > 200 ? `${body.slice(0, 200)}…` : body;
	return new Error(`${provider} token refresh failed: HTTP ${response.status} ${detail}`.trimEnd());
}

function readTokens(provider: string, payload: TokenResponse, sentRefreshToken: string): RefreshedTokens {
	const accessToken = payload.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error(`${provider} token refresh returned no access_token`);
	}
	const expiresIn = payload.expires_in;
	if (typeof expiresIn !== "number") {
		throw new Error(`${provider} token refresh returned no expires_in`);
	}
	const rotated = payload.refresh_token;
	return {
		accessToken,
		// Rotation is optional per response; keeping the sent token is required
		// so a response without one does not brick the grant.
		refreshToken: typeof rotated === "string" && rotated.length > 0 ? rotated : sentRefreshToken,
		expiresAt: Date.now() + expiresIn * 1000,
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
	if (!response.ok) throw await refreshFailure("anthropic", response);
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
	if (!response.ok) throw await refreshFailure("codex", response);
	return readTokens("codex", (await response.json()) as TokenResponse, refreshToken);
}

/**
 * Epoch ms of a JWT's `exp` claim. `undefined` for anything that is not a JWT
 * carrying a numeric `exp` — never throws.
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
		return claims.exp * 1000;
	} catch {
		return undefined;
	}
}
