/**
 * Terminal and JSON rendering for discovered account quotas.
 *
 * The terminal view is built for a human scanning several accounts at once:
 * one block per account, one aligned line per metered window, and a bar whose
 * fill is the quota still available. Columns are sized from the whole data set
 * so every window line in the output shares a left edge.
 *
 * Both views quote provider and store text, so every such string is redacted
 * on the way out (see `redact`) and no credential can reach the output.
 */

import type { AccountQuota, Credits, Provider, QuotaWindow } from "./types.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD_RED = "\x1b[1;31m";

const PROVIDER_ORDER: Provider[] = ["claude", "codex"];
const PROVIDER_TITLE: Record<Provider, string> = { claude: "CLAUDE", codex: "CODEX" };

const FULL = "█";
const HALF = "▌";
const EMPTY = "─";
const BAR_WIDE = 24;
const BAR_NARROW = 12;
/** Below this the bar is shrunk rather than letting lines wrap. */
const NARROW_COLUMNS = 92;

/** Layout widths measured across every rendered window line. */
interface Widths {
	window: number;
	percent: number;
	bar: number;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const totalMinutes = Math.round(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
	if (totalMinutes > 0) return `${totalMinutes}min`;
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export function renderTable(quotas: AccountQuota[], opts: { color: boolean; now?: number }): string {
	const now = opts.now ?? Date.now();
	const terminal = process.stdout.columns;
	const columns = typeof terminal === "number" && terminal > 0 ? terminal : 100;
	const widths = measure(quotas, columns < NARROW_COLUMNS ? BAR_NARROW : BAR_WIDE, columns);
	const out: string[] = [];

	for (const provider of PROVIDER_ORDER) {
		const group = quotas.filter((quota) => quota.account.provider === provider);
		if (group.length === 0) continue;
		if (out.length > 0) out.push("");
		out.push(paint(PROVIDER_TITLE[provider], BOLD, opts.color));
		for (const [index, quota] of group.entries()) {
			out.push(...accountBlock(quota, widths, columns, now, opts.color).slice(index === 0 ? 1 : 0));
		}
	}

	if (out.length === 0) return paint("no accounts", DIM, opts.color);
	return out.join("\n");
}

function accountBlock(quota: AccountQuota, widths: Widths, columns: number, now: number, color: boolean): string[] {
	const lines = ["", `  ${heading(quota, color)}`];
	const failure = errorOf(quota);
	if (failure !== undefined) {
		for (const line of wrap(failure, columns - 4)) lines.push(`    ${paint(line, RED, color)}`);
		return lines;
	}
	for (const window of orderWindows(quota.windows)) lines.push(windowLine(window, widths, now, color));
	if (quota.credits !== undefined) lines.push(creditsLine(quota.credits, widths, color));
	for (const note of quota.notes) {
		for (const line of wrap(`· ${redact(note)}`, columns - 4)) lines.push(`    ${paint(line, DIM, color)}`);
	}
	return lines;
}

/** Break on word boundaries so a long provider error stays inside the terminal. */
function wrap(text: string, width: number): string[] {
	if (width < 20 || text.length <= width) return [text];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line.length === 0) {
			line = word;
			continue;
		}
		if (line.length + 1 + word.length <= width) {
			line = `${line} ${word}`;
			continue;
		}
		lines.push(line);
		line = word;
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

/** `email · plan · store, store` — identity first, provenance dimmed after it. */
function heading(quota: AccountQuota, color: boolean): string {
	const account = quota.account;
	const source = account.sourceTag + (quota.refreshed === true ? " ↻" : "");
	const meta = [account.plan, source].filter((part): part is string => part !== undefined && part.length > 0);
	const name = paint(account.label, quota.windows.some((entry) => entry.exhausted === true) ? BOLD_RED : BOLD, color);
	if (meta.length === 0) return name;
	return `${name} ${paint(`· ${meta.join(" · ")}`, DIM, color)}`;
}

function windowLine(window: QuotaWindow, widths: Widths, now: number, color: boolean): string {
	const remaining = remainingOf(window);
	const tint = colorFor(remaining, window.exhausted === true);
	const label = clip(window.label, widths.window).padEnd(widths.window);
	const percent = `${remaining}%`.padStart(widths.percent);
	const reset = window.resetsAt === undefined ? "" : `resets in ${formatDuration(window.resetsAt - now)}`;
	const flag = window.exhausted === true ? paint("EXHAUSTED", RED, color) : "";
	// Reset first: it is on every line, so leading with it keeps the countdowns in
	// one column instead of indenting them past a sibling's EXHAUSTED flag.
	const tail = [paint(reset, DIM, color), flag].filter((part) => part.length > 0).join(paint(" · ", DIM, color));
	return `    ${paint(label, DIM, color)}  ${paint(bar(remaining, widths.bar), tint, color)} ${paint(percent, tint, color)}  ${tail}`.trimEnd();
}

/**
 * Overage credits are not a window — they have no allowance to fill — so the
 * bar column stays blank and the balance sits under the percentages.
 */
function creditsLine(credits: Credits, widths: Widths, color: boolean): string {
	const label = "credits".padEnd(widths.window);
	const cap = credits.limitReached === true ? paint(" cap reached", RED, color) : "";
	return `    ${paint(label, DIM, color)}  ${" ".repeat(widths.bar)} ${paint(amountOf(credits), CYAN, color)}${cap}`.trimEnd();
}

function amountOf(credits: Credits): string {
	if (credits.currency === "credits") {
		const usd = credits.usd === undefined ? "" : ` (≈$${credits.usd.toFixed(2)})`;
		return `${credits.balance.toFixed(2)}${usd}`;
	}
	if (credits.currency === "USD") return `$${credits.balance.toFixed(2)}`;
	return `${credits.balance.toFixed(2)} ${credits.currency}`;
}

/** Fill is quota REMAINING, with a half block for the trailing fraction. */
function bar(remaining: number, width: number): string {
	const halves = Math.round((remaining / 100) * width * 2);
	const full = Math.floor(halves / 2);
	const half = halves % 2 === 1 ? HALF : "";
	const filled = FULL.repeat(Math.min(width, full)) + half;
	return filled + EMPTY.repeat(Math.max(0, width - full - half.length));
}

/**
 * Column widths that keep the longest possible line inside the terminal: the
 * label column absorbs whatever the bar, percentage and reset tail leave over.
 */
function measure(quotas: AccountQuota[], bar: number, columns: number): Widths {
	let window = "credits".length;
	let percent = 2;
	for (const quota of quotas) {
		if (errorOf(quota) !== undefined) continue;
		for (const entry of quota.windows) {
			window = Math.max(window, entry.label.length);
			percent = Math.max(percent, `${remainingOf(entry)}%`.length);
		}
	}
	// 4 indent + label + 2 + bar + 1 + percent + 2 + the widest possible tail.
	const budget = columns - (9 + bar + percent + "resets in 00h 00min · EXHAUSTED".length);
	return { window: Math.max(8, Math.min(window, budget)), percent, bar };
}

/** Shorten an over-long meter name; the id in `--json` stays complete. */
function clip(text: string, width: number): string {
	if (text.length <= width) return text;
	return `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function renderJson(quotas: AccountQuota[]): string {
	const now = Date.now();
	return JSON.stringify(
		{
			generatedAt: new Date(now).toISOString(),
			accounts: quotas.map((quota) => ({
				provider: quota.account.provider,
				label: quota.account.label,
				plan: quota.account.plan ?? null,
				source: quota.account.sourceTag,
				windows: orderWindows(quota.windows).map((window) => ({
					id: window.id,
					label: window.label,
					usedPercent: window.usedPercent,
					remainingPercent: remainingOf(window),
					resetsAt: window.resetsAt === undefined ? null : new Date(window.resetsAt).toISOString(),
					resetsIn: window.resetsAt === undefined ? null : Math.max(0, Math.round((window.resetsAt - now) / 1000)),
					exhausted: window.exhausted === true,
					primary: window.primary === true,
				})),
				credits: quota.credits
					? {
							balance: quota.credits.balance,
							currency: quota.credits.currency,
							usd: quota.credits.usd ?? (quota.credits.currency === "USD" ? quota.credits.balance : null),
							limitReached: quota.credits.limitReached === true,
						}
					: null,
				notes: quota.notes.map(redact),
				error: errorOf(quota) ?? null,
			})),
		},
		null,
		2,
	);
}

/** Primary (request-gating) windows first, model-scoped meters after. */
function orderWindows(windows: QuotaWindow[]): QuotaWindow[] {
	const primary = windows.filter((window) => window.primary === true);
	return [...primary, ...windows.filter((window) => window.primary !== true)];
}

function remainingOf(window: QuotaWindow): number {
	return Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)));
}

function colorFor(remaining: number, exhausted: boolean): string {
	if (exhausted || remaining < 20) return RED;
	if (remaining < 50) return YELLOW;
	return GREEN;
}

const REDACTED = "<redacted>";

/**
 * Provider and store strings are printed verbatim, and some of them quote an
 * HTTP body: omp's disabled cause embeds the token endpoint's response, which
 * can echo the credential that was rejected. Every such string passes through
 * here first, so no secret reaches the terminal or `--json`. Prose, emails,
 * URLs, uuids and ISO timestamps carry no unbroken 40-character run of the
 * base64url alphabet, so they survive intact.
 */
const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/g,
	/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	/\b(?:app|rt)_[A-Za-z0-9_-]{6,}/g,
	/\boai-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g,
	/[A-Za-z0-9_-]{40,}/g,
];

function redact(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
	return out;
}

/** A store-disabled credential outranks any probe error text. */
function errorOf(quota: AccountQuota): string | undefined {
	const cause = quota.account.disabledCause;
	if (cause !== undefined) return `disabled: ${redact(cause.replace(/\s+/g, " ").trim())}`;
	if (quota.error !== undefined) return redact(quota.error.replace(/\s+/g, " ").trim());
	return undefined;
}

function paint(text: string, color: string | undefined, enabled: boolean): string {
	if (!enabled || color === undefined || text.length === 0) return text;
	return `${color}${text}${RESET}`;
}

