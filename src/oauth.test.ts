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

	test("redacts the encoded serializations of the sent token a form echo returns", async () => {
		// The codex refresh POSTs `application/x-www-form-urlencoded`, so an error
		// that quotes the submitted credential returns it percent- or form-encoded,
		// and a JSON echo returns it backslash-escaped.
		const secret = 'rt+slash/eq=sp ace"quote';
		const encoded = encodeURIComponent(secret);
		const echoes = [encoded, encoded.replaceAll("%20", "+"), JSON.stringify(secret).slice(1, -1)];
		for (const echo of echoes) {
			const error = await refreshCodexToken(secret, opts(`{"error":"invalid_grant","sent":"${echo}"}`, 400)).catch(
				(reason: Error) => reason,
			);
			expect((error as Error).message).not.toInclude(echo);
			expect((error as Error).message).not.toInclude(secret);
			expect((error as Error).message).toInclude("<token>");
		}
	});

	test("redacts the URLSearchParams escaping the codex form body actually sends", async () => {
		// `URLSearchParams` percent-encodes `~!'()`; `encodeURIComponent` leaves
		// them bare. Redacting only the latter lets an echo of the exact bytes we
		// POSTed survive into the `refresh failed: …` row on stdout.
		const secret = "rt~sub!del'ims(paren)";
		const echo = new URLSearchParams({ refresh_token: secret }).toString().slice("refresh_token=".length);
		expect(echo).not.toBe(encodeURIComponent(secret));
		const error = await refreshCodexToken(secret, opts(`{"error":"invalid_grant","sent":"${echo}"}`, 400)).catch(
			(reason: Error) => reason,
		);
		expect((error as Error).message).not.toInclude(echo);
		expect((error as Error).message).not.toInclude(secret);
		expect((error as Error).message).toInclude("<token>");
	});

	test("rejects a non-positive expires_in instead of persisting a dead token", async () => {
		// Inside the one-day clock-skew tolerance, so the plausibility window
		// alone accepts these: the token is stored already expired.
		const zero = refreshCodexToken(SECRET, opts(`{"access_token":"a","expires_in":0}`, 200));
		await expect(zero).rejects.toThrow("implausible expires_in");
		const negative = refreshClaudeToken(SECRET, opts(`{"access_token":"a","expires_in":-3600}`, 200));
		await expect(negative).rejects.toThrow("implausible expires_in");
	});

	test("rejects an expires_in that parks the expiry beyond any refresh", async () => {
		// A seconds/ms mixup or a bogus huge value makes the credential look valid
		// for millennia: it is never refreshed and every probe 401s forever.
		const millennia = refreshCodexToken(SECRET, opts(`{"access_token":"a","expires_in":253402300799}`, 200));
		await expect(millennia).rejects.toThrow("implausible expires_in");
		const longPast = refreshClaudeToken(SECRET, opts(`{"access_token":"a","expires_in":-999999}`, 200));
		await expect(longPast).rejects.toThrow("implausible expires_in");
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

	test("returns undefined for an exp outside any plausible epoch-ms range", () => {
		// `exp` in ms instead of seconds, or a junk value: a token that looks valid
		// for millennia would never be refreshed.
		const far = Buffer.from(JSON.stringify({ exp: 9_999_999_999_999 })).toString("base64url");
		expect(decodeJwtExpiryMs(`header.${far}.sig`)).toBeUndefined();
	});
});
