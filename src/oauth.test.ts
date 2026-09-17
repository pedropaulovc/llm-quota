import { describe, expect, test } from "bun:test";
import { decodeJwtExpiryMs, refreshClaudeToken, refreshCodexToken } from "./oauth.ts";

const SECRET = "rt-super-secret-value-123";
const opts = (body: string, status: number) => ({
	timeoutMs: 5_000,
	fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
});

describe("refresh", () => {
	test("keeps the sent refresh token out of the error a failed exchange reports", async () => {
		// Token endpoints echo the rejected credential; this message reaches stdout.
		const failing = opts(`{"error":"invalid_grant","sent":"${SECRET}"}`, 400);
		const error = await refreshClaudeToken(SECRET, failing).catch((reason: Error) => reason);
		expect((error as Error).message).not.toInclude(SECRET);
		expect((error as Error).message).toInclude("<token>");
	});

	test("rejects an expiry that would persist as NaN or null", async () => {
		// `typeof NaN === "number"`, and 1e309 parses to Infinity.
		const infinite = refreshCodexToken(SECRET, opts(`{"access_token":"a","expires_in":1e309}`, 200));
		await expect(infinite).rejects.toThrow("no usable expires_in");
		const stringy = refreshCodexToken(SECRET, opts(`{"access_token":"a","expires_in":"3600"}`, 200));
		await expect(stringy).rejects.toThrow("no usable expires_in");
	});

	test("retains the sent refresh token when the response omits a rotated one", async () => {
		// Dropping it here would lose the grant family.
		const rotated = await refreshCodexToken(SECRET, opts(`{"access_token":"new","expires_in":3600}`, 200));
		expect(rotated.refreshToken).toBe(SECRET);
		expect(rotated.accessToken).toBe("new");
		expect(rotated.expiresAt).toBeGreaterThan(Date.now());
	});
});

describe("decodeJwtExpiryMs", () => {
	test("reads the exp claim the codex store relies on for expiry", () => {
		const payload = Buffer.from(JSON.stringify({ exp: 1_790_352_138 })).toString("base64url");
		expect(decodeJwtExpiryMs(`header.${payload}.sig`)).toBe(1_790_352_138_000);
	});

	test("returns undefined for a non-JWT instead of throwing", () => {
		expect(decodeJwtExpiryMs("notajwt")).toBeUndefined();
		expect(decodeJwtExpiryMs("a.!!!not-base64!!!.c")).toBeUndefined();
	});
});
