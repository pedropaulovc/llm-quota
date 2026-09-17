#!/usr/bin/env bun
/**
 * llm-quota — print remaining subscription quota for every locally stored
 * Claude and Codex account, probing all of them concurrently.
 */

import type { Account, AccountQuota, Provider } from "./types.ts";
import { probeClaude } from "./claude.ts";
import { probeCodex } from "./codex.ts";
import { renderJson, renderTable } from "./render.ts";
import { dedupeAccounts, discoverAccounts, ensureFreshToken, identityKey } from "./sources.ts";

const STORES = [
	"~/.omp/agent/agent.db          (table auth_credentials)",
	"~/.claude/.credentials.json",
	"~/.claude/cred-profiles/*.json",
	"~/.codex/auth.json",
];

const USAGE = `llm-quota — remaining quota for every local Claude / Codex account

usage: llm-quota [--json] [--no-refresh] [--only claude|codex] [--all-sources] [--timeout <sec>]

  --json            machine-readable output (never includes tokens)
  --no-refresh      do not refresh expired access tokens, report them as errors
  --only <provider> restrict to "claude" or "codex"
  --all-sources     keep every store's copy of an account instead of deduping
  --timeout <sec>   per-request timeout, default 20
  -h, --help        this message

credential stores consulted:
${STORES.map((store) => `  ${store}`).join("\n")}`;

interface Options {
	json: boolean;
	refresh: boolean;
	allSources: boolean;
	only?: Provider;
	timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { json: false, refresh: true, allSources: false, timeoutMs: 20_000 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
		if (flag === "-h" || flag === "--help") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		if (flag === "--json") {
			opts.json = true;
			continue;
		}
		if (flag === "--no-refresh") {
			opts.refresh = false;
			continue;
		}
		if (flag === "--all-sources") {
			opts.allSources = true;
			continue;
		}
		if (flag === "--only") {
			if (inlineValue === undefined) index += 1;
			const value = inlineValue ?? argv[index];
			if (value !== "claude" && value !== "codex") die(`--only expects "claude" or "codex", got ${describe(value)}`);
			opts.only = value;
			continue;
		}
		if (flag === "--timeout") {
			if (inlineValue === undefined) index += 1;
			const value = inlineValue ?? argv[index];
			const seconds = Number(value);
			if (value === undefined || value === "" || !Number.isFinite(seconds) || seconds <= 0) {
				die(`--timeout expects a positive number of seconds, got ${describe(value)}`);
			}
			opts.timeoutMs = Math.round(seconds * 1000);
			continue;
		}
		die(`unknown argument: ${arg}`);
	}
	return opts;
}

function die(message: string): never {
	process.stderr.write(`llm-quota: ${message}\n\n${USAGE}\n`);
	process.exit(2);
}

function describe(value: string | undefined): string {
	if (value === undefined) return "nothing";
	return `"${value}"`;
}

/** Refresh (unless suppressed) and probe one account; never throws. */
async function resolve(account: Account, opts: Options): Promise<AccountQuota> {
	if (account.disabledCause !== undefined) {
		return { account, windows: [], notes: [], error: `disabled: ${account.disabledCause}` };
	}
	let fresh = account;
	if (opts.refresh) {
		try {
			fresh = await ensureFreshToken(account, { timeoutMs: opts.timeoutMs });
		} catch (error) {
			return { account, windows: [], notes: [], error: `refresh failed: ${reason(error)}` };
		}
	}
	const probe = fresh.provider === "claude" ? probeClaude : probeCodex;
	const quota = await probe(fresh, { timeoutMs: opts.timeoutMs });
	if (fresh.accessToken !== account.accessToken) return { ...quota, refreshed: true };
	return quota;
}

function reason(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Two stores can hold the same subscription (an omp row and the Claude Code
 * credential), but that is only provable once a probe resolves the account's
 * identity — pre-probe the file credential carries no email at all. Collapse
 * those rows here so one account never renders twice, keeping every store it
 * was reached through visible in the source column.
 */
function mergeResolved(quotas: AccountQuota[]): AccountQuota[] {
	const merged = new Map<string, AccountQuota>();
	for (const quota of quotas) {
		const key = identityKey(quota.account);
		const seen = merged.get(key);
		if (seen === undefined) {
			merged.set(key, quota);
			continue;
		}
		const winner = preferred(seen, quota);
		const loser = winner === seen ? quota : seen;
		merged.set(key, {
			...winner,
			account: { ...winner.account, sourceTag: `${winner.account.sourceTag}, ${loser.account.sourceTag}` },
		});
	}
	return [...merged.values()];
}

/** A working probe outranks a failed one; otherwise the richer report wins. */
function preferred(left: AccountQuota, right: AccountQuota): AccountQuota {
	if ((left.error === undefined) !== (right.error === undefined)) return left.error === undefined ? left : right;
	return right.windows.length > left.windows.length ? right : left;
}

function useColor(): boolean {
	const force = process.env.FORCE_COLOR;
	if (force !== undefined && force !== "" && force !== "0") return true;
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
	if (process.env.TERM === "dumb") return false;
	// `Bun.stdout` is a BunFile and never carries `isTTY`; the Node stream does.
	return process.stdout.isTTY === true;
}

const opts = parseArgs(Bun.argv.slice(2));
const discovered = await discoverAccounts();
const selected = opts.only === undefined ? discovered : discovered.filter((account) => account.provider === opts.only);
const accounts = opts.allSources ? selected : dedupeAccounts(selected);

if (accounts.length === 0) {
	const scope = opts.only === undefined ? "" : ` for --only ${opts.only}`;
	process.stderr.write(`llm-quota: no accounts found${scope}. Looked in:\n${STORES.map((store) => `  ${store}`).join("\n")}\n`);
	process.exit(1);
}

const probed = await Promise.all(accounts.map((account) => resolve(account, opts)));
const quotas = opts.allSources ? probed : mergeResolved(probed);
process.stdout.write(`${opts.json ? renderJson(quotas) : renderTable(quotas, { color: useColor() })}\n`);
process.exit(quotas.some((quota) => quota.error === undefined && quota.account.disabledCause === undefined) ? 0 : 1);
