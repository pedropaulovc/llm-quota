/**
 * Credential discovery across every local store, plus token refresh with
 * write-back to the store a credential came from.
 *
 * Stores read:
 *   ~/.omp/agent/agent.db          (sqlite, table auth_credentials)
 *   ~/.claude/.credentials.json    (Claude Code active login)
 *   ~/.claude/cred-profiles/*.json (saved Claude Code profiles)
 *   ~/.codex/auth.json             (Codex CLI login)
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeJwtExpiryMs, refreshClaudeToken, refreshCodexToken, type RefreshedTokens } from "./oauth.ts";
import type { Account, Provider, ProbeOptions, SourceKind } from "./types.ts";

/** Refresh when the access token has less than this much life left. */
const REFRESH_SKEW_MS = 120_000;

interface OmpRow {
	id: number;
	provider: string;
	data: string;
	disabled_cause: string | null;
}

interface OmpData {
	access?: unknown;
	refresh?: unknown;
	expires?: unknown;
	accountId?: unknown;
	email?: unknown;
	orgId?: unknown;
	orgName?: unknown;
}

interface ClaudeOauth {
	accessToken?: unknown;
	refreshToken?: unknown;
	expiresAt?: unknown;
	subscriptionType?: unknown;
}

interface ClaudeStore {
	claudeAiOauth?: ClaudeOauth;
	account?: {
		accountUuid?: unknown;
		emailAddress?: unknown;
		organizationUuid?: unknown;
		organizationName?: unknown;
	};
	email?: unknown;
}

interface CodexStore {
	auth_mode?: unknown;
	tokens?: {
		access_token?: unknown;
		refresh_token?: unknown;
		account_id?: unknown;
	};
}

function str(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value;
}

function num(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

/**
 * Post-probe merge key for the CLI, applied once a probe has resolved an
 * account's identity and every row carries an account id or an email. Two
 * accounts are the same only when they share a provider and an account id, or a
 * provider and an email — and, when both stores know it, the same organization:
 * one email can hold a Team seat and a personal Max plan, two separate grants
 * with separate quotas. An orgId that merely repeats the account id (omp records
 * the ChatGPT account id in both fields, Codex having no organization) carries
 * no identity and is ignored, so a store that reports no organization still
 * matches its twin. A candidate with no id at all is keyed by its source so it
 * can never absorb — or be absorbed by — a different account. Pre-probe
 * grouping needs more than one key per account and lives in `dedupeAccounts`.
 */
export function identityKey(account: Account): string {
	const accountId = account.accountId;
	const orgId = account.orgId;
	const org = orgId === undefined || orgId === accountId ? "" : `|org:${orgId}`;
	if (accountId !== undefined) return `${account.provider}|acct:${accountId}${org}`;
	const email = account.email;
	if (email !== undefined) return `${account.provider}|email:${email.toLowerCase()}${org}`;
	return `${account.provider}|src:${account.sourceTag}`;
}

/**
 * A malformed store must never hide the accounts held by the others, so every
 * store is read behind this reporter.
 */
function readStore(path: string, read: () => void): void {
	try {
		read();
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		process.stderr.write(`llm-quota: skipping unreadable credential store ${path}: ${reason}\n`);
	}
}

function ompProvider(provider: string): Provider | undefined {
	if (provider === "anthropic") return "claude";
	if (provider === "openai-codex") return "codex";
	return undefined;
}

function ompAccount(dbPath: string, row: OmpRow): Account | undefined {
	const provider = ompProvider(row.provider);
	if (provider === undefined) return undefined;
	const data = JSON.parse(row.data) as OmpData;
	const accessToken = str(data.access);
	if (accessToken === undefined) return undefined;
	const accountId = str(data.accountId);
	const email = str(data.email);
	const sourceTag = `omp#${row.id}`;
	return {
		provider,
		label: email ?? accountId ?? sourceTag,
		accountId,
		email,
		// omp stores the Codex plan in orgName; for Anthropic it is a real org name.
		plan: provider === "codex" ? str(data.orgName) : undefined,
		orgId: str(data.orgId),
		orgName: provider === "claude" ? str(data.orgName) : undefined,
		source: { kind: "omp", dbPath, rowId: row.id },
		sourceTag,
		accessToken,
		refreshToken: str(data.refresh),
		expiresAt: num(data.expires),
		disabledCause: str(row.disabled_cause),
	};
}

function claudeFileAccount(source: SourceKind, filePath: string, sourceTag: string, label: string): Account | undefined {
	const store = JSON.parse(readFileSync(filePath, "utf8")) as ClaudeStore;
	const oauth = store.claudeAiOauth;
	if (oauth === undefined) return undefined;
	const accessToken = str(oauth.accessToken);
	if (accessToken === undefined) return undefined;
	const email = str(store.account?.emailAddress) ?? str(store.email);
	return {
		provider: "claude",
		label: email ?? label,
		accountId: str(store.account?.accountUuid),
		email,
		plan: str(oauth.subscriptionType),
		orgId: str(store.account?.organizationUuid),
		orgName: str(store.account?.organizationName),
		source,
		sourceTag,
		accessToken,
		refreshToken: str(oauth.refreshToken),
		expiresAt: num(oauth.expiresAt),
	};
}

function codexCliAccount(filePath: string): Account | undefined {
	const store = JSON.parse(readFileSync(filePath, "utf8")) as CodexStore;
	if (store.auth_mode !== "chatgpt") return undefined;
	const accessToken = str(store.tokens?.access_token);
	if (accessToken === undefined) return undefined;
	const accountId = str(store.tokens?.account_id);
	return {
		provider: "codex",
		label: accountId ?? "codex-cli (local)",
		accountId,
		source: { kind: "codex-cli", filePath },
		sourceTag: "codex-cli",
		accessToken,
		refreshToken: str(store.tokens?.refresh_token),
		expiresAt: decodeJwtExpiryMs(accessToken),
	};
}

function sortAccounts(accounts: Account[]): Account[] {
	return accounts.sort((a, b) => {
		if (a.provider !== b.provider) return a.provider === "claude" ? -1 : 1;
		if (a.label !== b.label) return a.label < b.label ? -1 : 1;
		return a.sourceTag < b.sourceTag ? -1 : 1;
	});
}

export function discoverAccounts(opts?: { home?: string }): Account[] {
	const home = opts?.home ?? process.env.HOME;
	if (home === undefined) throw new Error("cannot locate credential stores: HOME is not set");
	const found: Account[] = [];

	const dbPath = join(home, ".omp", "agent", "agent.db");
	if (existsSync(dbPath)) {
		readStore(dbPath, () => {
			const db = new Database(dbPath, { readonly: true });
			try {
				const rows = db
					.query<OmpRow, []>(
						"SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE provider IN ('anthropic','openai-codex') ORDER BY id",
					)
					.all();
				for (const row of rows) {
					readStore(`${dbPath}#${row.id}`, () => {
						const account = ompAccount(dbPath, row);
						if (account !== undefined) found.push(account);
					});
				}
			} finally {
				db.close();
			}
		});
	}

	const claudeCodePath = join(home, ".claude", ".credentials.json");
	if (existsSync(claudeCodePath)) {
		readStore(claudeCodePath, () => {
			const account = claudeFileAccount(
				{ kind: "claude-code", filePath: claudeCodePath },
				claudeCodePath,
				"claude-code",
				"claude-code (local)",
			);
			if (account !== undefined) found.push(account);
		});
	}

	const profileDir = join(home, ".claude", "cred-profiles");
	if (existsSync(profileDir)) {
		readStore(profileDir, () => {
			for (const entry of readdirSync(profileDir).sort()) {
				if (!entry.endsWith(".json")) continue;
				const profile = entry.slice(0, -".json".length);
				const filePath = join(profileDir, entry);
				readStore(filePath, () => {
					const account = claudeFileAccount(
						{ kind: "claude-profile", filePath, profile },
						filePath,
						`claude-profile:${profile}`,
						`claude-profile:${profile}`,
					);
					if (account !== undefined) found.push(account);
				});
			}
		});
	}

	const codexPath = join(home, ".codex", "auth.json");
	if (existsSync(codexPath)) {
		readStore(codexPath, () => {
			const account = codexCliAccount(codexPath);
			if (account !== undefined) found.push(account);
		});
	}

	return sortAccounts(found);
}

/**
 * Pick the survivor of one provably-identical group. A credential the store
 * already marked dead (omp's `disabled_cause`) loses to any live twin, so a
 * fresh login is never reported as a disabled account; among candidates that are
 * all live — or all dead — the one with the most token life left wins, an omp
 * row taking ties because it carries both tokens and full metadata.
 * Display-only fields and identifiers missing from the survivor are filled from
 * its twins — every member of a group is provably the same account, so a twin's
 * account id or organization cannot mislabel the survivor, and filling them
 * keeps the post-probe merge key strong even when the survivor is the credential
 * that knew only an email. Tokens are never taken from a discarded twin.
 */
function collapseGroup(group: Account[]): Account {
	const live = group.filter((candidate) => candidate.disabledCause === undefined);
	let winner: Account | undefined;
	for (const candidate of live.length === 0 ? group : live) {
		if (winner === undefined) {
			winner = candidate;
			continue;
		}
		const challenger = candidate.expiresAt ?? -Infinity;
		const held = winner.expiresAt ?? -Infinity;
		if (challenger > held) {
			winner = candidate;
			continue;
		}
		if (challenger < held) continue;
		if (candidate.source.kind === "omp" && winner.source.kind !== "omp") winner = candidate;
	}
	if (winner === undefined) throw new Error("cannot collapse an empty identity group");
	const merged: Account = { ...winner };
	const tags = [winner.sourceTag];
	for (const twin of group) {
		merged.accountId ??= twin.accountId;
		merged.email ??= twin.email;
		merged.plan ??= twin.plan;
		merged.orgId ??= twin.orgId;
		merged.orgName ??= twin.orgName;
		// Every store this subscription was found in stays visible: a dead omp row
		// beside a fresh login is exactly what a user needs to see to know which
		// store to re-authorize.
		if (!tags.includes(twin.sourceTag)) tags.push(twin.sourceTag);
	}
	merged.sourceTag = tags.join(", ");
	merged.label = merged.email ?? merged.label;
	return merged;
}

/**
 * The identifiers one candidate knows, normalized for comparison. An orgId that
 * merely repeats the account id (omp records the ChatGPT account id in both
 * fields, Codex having no organization) is not organization identity and is
 * dropped, so a store that reports no organization still matches its twin.
 */
interface Identifiers {
	accountId: string | undefined;
	email: string | undefined;
	orgId: string | undefined;
}

interface Candidate {
	account: Account;
	ids: Identifiers;
	/** Identity-derived sort key: fixes the processing order of a candidate set. */
	order: string;
}

function candidateOf(account: Account): Candidate {
	const accountId = account.accountId;
	const orgId = account.orgId;
	const ids: Identifiers = {
		accountId,
		email: account.email?.toLowerCase(),
		orgId: orgId === accountId ? undefined : orgId,
	};
	const order = [
		account.provider,
		ids.accountId ?? "",
		ids.email ?? "",
		ids.orgId ?? "",
		account.sourceTag,
		account.label,
	].join("\u0000");
	return { account, ids, order };
}

function shares(left: Identifiers, right: Identifiers): boolean {
	if (left.accountId !== undefined && left.accountId === right.accountId) return true;
	if (left.email !== undefined && left.email === right.email) return true;
	return left.orgId !== undefined && left.orgId === right.orgId;
}

/** Any identifier both candidates know, disagreeing: two different accounts. */
function conflicts(left: Identifiers, right: Identifiers): boolean {
	if (left.accountId !== undefined && right.accountId !== undefined && left.accountId !== right.accountId) return true;
	if (left.email !== undefined && right.email !== undefined && left.email !== right.email) return true;
	return left.orgId !== undefined && right.orgId !== undefined && left.orgId !== right.orgId;
}

/**
 * Whether two groups may become one: every cross pair agrees on the identifiers
 * both sides know, and at least one pair shares one.
 */
function compatible(left: Candidate[], right: Candidate[]): boolean {
	let shared = false;
	for (const held of left) {
		for (const twin of right) {
			if (held.account.provider !== twin.account.provider) return false;
			if (conflicts(held.ids, twin.ids)) return false;
			if (shares(held.ids, twin.ids)) shared = true;
		}
	}
	return shared;
}

/**
 * One round of grouping: join every pair of groups whose placement is certain.
 * A group compatible with two groups that disagree with each other has no
 * provable home — a `~/.claude` credential knowing only an email, against the
 * two org grants that email holds, could be either — so it joins nothing this
 * round and neither do its suitors, leaving it to be probed on its own and
 * merged by identity once the profile answers. Returns `undefined` when nothing
 * moved, which ends the fixpoint.
 */
function mergeRound(groups: Candidate[][]): Candidate[][] | undefined {
	const partners = new Map<Candidate[], Candidate[][]>(
		groups.map((members) => [members, groups.filter((other) => other !== members && compatible(members, other))]),
	);
	const ambiguous = new Set<Candidate[]>(
		groups.filter((members) => {
			const suitors = partners.get(members) ?? [];
			return suitors.some((one) =>
				suitors.some(
					(two) => one !== two && one.some((held) => two.some((twin) => conflicts(held.ids, twin.ids))),
				),
			);
		}),
	);
	const holder = new Map<Candidate[], Candidate[]>(groups.map((members) => [members, members]));
	let joined = false;
	for (const members of groups) {
		if (ambiguous.has(members)) continue;
		for (const partner of partners.get(members) ?? []) {
			if (ambiguous.has(partner)) continue;
			const held = holder.get(members);
			const other = holder.get(partner);
			if (held === undefined || other === undefined || held === other) continue;
			// Two groups compatible with a third are not compatible with each other.
			if (held.some((a) => other.some((b) => conflicts(a.ids, b.ids)))) continue;
			const union = [...held, ...other];
			for (const [key, value] of holder) {
				if (value === held || value === other) holder.set(key, union);
			}
			joined = true;
		}
	}
	if (!joined) return undefined;
	const next: Candidate[][] = [];
	for (const members of groups) {
		const group = holder.get(members);
		if (group === undefined || next.includes(group)) continue;
		next.push(group);
	}
	return next;
}

/**
 * Collapse candidates that are provably the same account, by union over shared
 * identifiers: two candidates of one provider join a group when they share any
 * identifier both know (account id, email, organization) and no identifier both
 * know disagrees. Partial records therefore group before any probe runs — an omp
 * row holding an account id, an email and an org beside a `~/.claude`
 * credential that knows only the same email is one subscription, where a
 * single-key lookup saw two — while a differing account id, email or
 * organization keeps two grants apart even when another identifier matches.
 * Groups merge only where the placement is unambiguous: a candidate that fits
 * two grants which disagree with each other is left alone rather than assigned
 * by a coin flip that would discard the other grant's token. A candidate with no
 * identifier at all stands alone. Candidates are processed in an order derived
 * from their identity rather than from discovery, so the same set always groups
 * the same way whatever order it arrives in.
 */
export function dedupeAccounts(accounts: Account[]): Account[] {
	const candidates = accounts.map(candidateOf).sort((a, b) => {
		if (a.order === b.order) return 0;
		return a.order < b.order ? -1 : 1;
	});
	let groups: Candidate[][] = candidates.map((candidate) => [candidate]);
	for (;;) {
		const next = mergeRound(groups);
		if (next === undefined) break;
		groups = next;
	}
	return sortAccounts(groups.map((group) => collapseGroup(group.map((member) => member.account))));
}

function withTokens(account: Account, tokens: RefreshedTokens): Account {
	return {
		...account,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
	};
}

/** Write to a sibling temp file with 0600 then rename over the original. */
function writeJsonAtomic(filePath: string, value: unknown): void {
	const tmp = `${filePath}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, filePath);
}

function persistClaudeFile(filePath: string, tokens: RefreshedTokens): void {
	const store = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	const oauth = store["claudeAiOauth"];
	if (oauth === null || typeof oauth !== "object") {
		throw new Error(`${filePath}: no claudeAiOauth block to update`);
	}
	const block = oauth as Record<string, unknown>;
	block["accessToken"] = tokens.accessToken;
	block["refreshToken"] = tokens.refreshToken;
	block["expiresAt"] = tokens.expiresAt;
	writeJsonAtomic(filePath, store);
}

function persistCodexFile(filePath: string, tokens: RefreshedTokens): void {
	const store = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	const held = store["tokens"];
	if (held === null || typeof held !== "object") {
		throw new Error(`${filePath}: no tokens block to update`);
	}
	const block = held as Record<string, unknown>;
	block["access_token"] = tokens.accessToken;
	block["refresh_token"] = tokens.refreshToken;
	store["last_refresh"] = new Date().toISOString();
	writeJsonAtomic(filePath, store);
}

/**
 * Store the rotated tokens in omp's database unless omp refreshed the same row
 * first: in that race the row already holds a newer grant, so this run's result
 * is abandoned and the stored credential is returned instead.
 */
function persistOmp(account: Account, dbPath: string, rowId: number, tokens: RefreshedTokens): Account {
	const db = new Database(dbPath);
	// The omp agent writes this database concurrently; wait out its locks
	// instead of failing the refresh we already paid a network round trip for.
	db.run("PRAGMA busy_timeout = 5000");
	try {
		const select = db.query<OmpRow, [number]>(
			"SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE id = ?",
		);
		const update = db.query<unknown, [string, string, number, number]>(
			"UPDATE auth_credentials SET data = json_set(data,'$.access',?,'$.refresh',?,'$.expires',?), updated_at = strftime('%s','now') WHERE id = ?",
		);
		const commit = db.transaction((): Account => {
			const row = select.get(rowId);
			if (row === null) throw new Error(`${account.sourceTag}: credential row disappeared`);
			const stored = ompAccount(dbPath, row);
			if (stored !== undefined && stored.accessToken !== account.accessToken) return stored;
			update.run(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, rowId);
			return withTokens(account, tokens);
		});
		return commit.immediate();
	} finally {
		db.close();
	}
}

/**
 * Refresh unconditionally, persist the rotated pair back to the originating
 * store, and return a new `Account`; never mutates the input. Callers that only
 * want a usable token should go through `ensureFreshToken`; this entry point
 * exists for the caller that has proof the access token is dead (a 401) even
 * though the store reported no expiry. Throws when the credential cannot be
 * refreshed at all: the store already marked it disabled, or it holds no
 * refresh token.
 */
export async function refreshAccount(account: Account, opts: ProbeOptions): Promise<Account> {
	if (account.disabledCause !== undefined) {
		throw new Error(`token expired and ${account.sourceTag} is disabled (${account.disabledCause}); re-login required`);
	}
	const refreshToken = account.refreshToken;
	if (refreshToken === undefined) {
		throw new Error(`token expired and ${account.sourceTag} has no refresh token; re-login required`);
	}

	const tokens =
		account.provider === "claude"
			? await refreshClaudeToken(refreshToken, opts)
			: await refreshCodexToken(refreshToken, opts);

	const source = account.source;
	if (source.kind === "omp") return persistOmp(account, source.dbPath, source.rowId, tokens);
	if (source.kind === "codex-cli") {
		persistCodexFile(source.filePath, tokens);
		return withTokens(account, tokens);
	}
	persistClaudeFile(source.filePath, tokens);
	return withTokens(account, tokens);
}

/**
 * Return `account` when its access token is still usable — the store reported no
 * expiry, or more than `REFRESH_SKEW_MS` of life remains — otherwise refresh it
 * through `refreshAccount`. Never mutates the input.
 */
export async function ensureFreshToken(account: Account, opts: ProbeOptions): Promise<Account> {
	if (account.expiresAt === undefined) return account;
	if (account.expiresAt - Date.now() > REFRESH_SKEW_MS) return account;
	return refreshAccount(account, opts);
}
