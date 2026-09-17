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
 * Stable grouping key. Two accounts are provably the same only when they share
 * a provider and an account id, or a provider and an email. A candidate with
 * neither is keyed by its source so it can never absorb — or be absorbed by —
 * a different account.
 */
export function identityKey(account: Account): string {
	const accountId = account.accountId;
	if (accountId !== undefined) return `${account.provider}|acct:${accountId}`;
	const email = account.email;
	if (email !== undefined) return `${account.provider}|email:${email.toLowerCase()}`;
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
 * Pick the survivor of one provably-identical group: the credential with the
 * most token life left, an omp row winning ties because it carries both tokens
 * and full metadata. Display-only fields missing from the survivor are filled
 * from its twins — those describe the same account, so they cannot mislabel it.
 * Tokens are never taken from a discarded twin.
 */
function collapseGroup(group: Account[]): Account {
	let winner: Account | undefined;
	for (const candidate of group) {
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
	for (const twin of group) {
		merged.email ??= twin.email;
		merged.plan ??= twin.plan;
		merged.orgName ??= twin.orgName;
	}
	merged.label = merged.email ?? merged.label;
	return merged;
}

/** Collapse candidates that are provably the same account. */
export function dedupeAccounts(accounts: Account[]): Account[] {
	const groups = new Map<string, Account[]>();
	for (const account of accounts) {
		const key = identityKey(account);
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, [account]);
			continue;
		}
		group.push(account);
	}
	return sortAccounts([...groups.values()].map(collapseGroup));
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
 * Return `account` when its access token is still usable, otherwise refresh it,
 * persist the rotated pair back to the originating store, and return a new
 * `Account`. Never mutates the input.
 */
export async function ensureFreshToken(account: Account, opts: ProbeOptions): Promise<Account> {
	if (account.expiresAt === undefined) return account;
	if (account.expiresAt - Date.now() > REFRESH_SKEW_MS) return account;
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
