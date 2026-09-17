/**
 * Terminal and JSON rendering for discovered account quotas.
 *
 * The table is grouped by provider, one row per account, and stays readable at
 * 100 columns: the window cells are wrapped onto continuation lines aligned
 * under the window column rather than truncated.
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

const LABEL_MAX = 28;
const CAUSE_MAX = 60;
const GAP = "  ";
const PROVIDER_ORDER: Provider[] = ["claude", "codex"];

/** A rendered fragment plus the ANSI prefix it wants when color is enabled. */
interface Cell {
	text: string;
	color?: string;
}

/** Columns shared by every row, plus the trailing wrappable cells. */
interface Row {
	label: Cell;
	plan: string;
	source: string;
	tail: Cell[];
	notes: string[];
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) return `${totalHours}h${totalMinutes % 60}m`;
	return `${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
}

export function renderTable(quotas: AccountQuota[], opts: { color: boolean; now?: number }): string {
	if (quotas.length === 0) return "";
	const now = opts.now ?? Date.now();
	const width = terminalWidth();
	const groups = PROVIDER_ORDER.map((provider) => ({
		provider,
		rows: quotas
			.filter((quota) => quota.account.provider === provider)
			.sort((a, b) => a.account.label.localeCompare(b.account.label))
			.map((quota) => buildRow(quota, now)),
	})).filter((group) => group.rows.length > 0);

	const all = groups.flatMap((group) => group.rows);
	const labelWidth = Math.max(...all.map((row) => row.label.text.length));
	const planWidth = Math.max(...all.map((row) => row.plan.length));
	const sourceWidth = Math.max(...all.map((row) => row.source.length));
	const prefixWidth = labelWidth + GAP.length + planWidth + GAP.length + sourceWidth + GAP.length;
	const tailWidth = Math.max(24, width - prefixWidth - 2);

	const lines: string[] = [];
	for (const group of groups) {
		if (lines.length > 0) lines.push("");
		lines.push(paint(group.provider.toUpperCase(), BOLD, opts.color));
		for (const row of group.rows) {
			const prefix =
				pad(paint(row.label.text, row.label.color, opts.color), row.label.text.length, labelWidth) +
				GAP +
				pad(paint(row.plan, DIM, opts.color), row.plan.length, planWidth) +
				GAP +
				pad(paint(row.source, DIM, opts.color), row.source.length, sourceWidth) +
				GAP;
			const indent = " ".repeat(prefixWidth);
			const wrapped = wrap(row.tail, tailWidth);
			for (const [index, cells] of wrapped.entries()) {
				const rendered = cells.map((cell) => paint(cell.text, cell.color, opts.color)).join(GAP);
				lines.push(`  ${index === 0 ? prefix : indent}${rendered}`);
			}
			for (const note of row.notes) {
				lines.push(`    ${paint(truncate(note, Math.max(40, width - 6)), DIM, opts.color)}`);
			}
		}
	}
	return lines.join("\n");
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
				notes: quota.notes,
				error: errorOf(quota) ?? null,
			})),
		},
		null,
		2,
	);
}

function buildRow(quota: AccountQuota, now: number): Row {
	const label = truncate(quota.account.label, LABEL_MAX);
	const plan = quota.account.plan ?? "—";
	const source = quota.account.sourceTag + (quota.refreshed === true ? " ↻" : "");
	const failure = errorOf(quota);
	if (failure !== undefined) {
		return {
			label: { text: label, color: RED },
			plan,
			source,
			tail: [{ text: failure, color: RED }],
			notes: quota.notes,
		};
	}
	const windows = orderWindows(quota.windows);
	const exhausted = windows.some((window) => window.exhausted === true);
	const tail = windows.map((window) => windowCell(window, now));
	if (quota.credits) tail.push(creditsCell(quota.credits));
	if (tail.length === 0) tail.push({ text: "no windows reported", color: DIM });
	return {
		label: { text: label, color: exhausted ? BOLD_RED : undefined },
		plan,
		source,
		tail,
		notes: quota.notes,
	};
}

function windowCell(window: QuotaWindow, now: number): Cell {
	const remaining = remainingOf(window);
	const reset = window.resetsAt === undefined ? "—" : formatDuration(window.resetsAt - now);
	const flag = window.exhausted === true ? " EXHAUSTED" : "";
	return {
		text: `${window.label} ${remaining}%${flag} (${reset})`,
		color: colorFor(remaining, window.exhausted === true),
	};
}

function creditsCell(credits: Credits): Cell {
	const cap = credits.limitReached === true ? " (cap reached)" : "";
	const amount =
		credits.currency === "credits"
			? `${credits.balance.toFixed(2)}${credits.usd === undefined ? "" : ` (≈$${credits.usd.toFixed(2)})`}`
			: credits.currency === "USD"
				? `$${credits.balance.toFixed(2)}`
				: `${credits.balance.toFixed(2)} ${credits.currency}`;
	return {
		text: `credits ${amount}${cap}`,
		color: credits.limitReached === true ? RED : CYAN,
	};
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
	if (exhausted) return RED;
	if (remaining >= 50) return GREEN;
	if (remaining >= 20) return YELLOW;
	return RED;
}

/** A store-disabled credential outranks any probe error text. */
function errorOf(quota: AccountQuota): string | undefined {
	const cause = quota.account.disabledCause;
	if (cause !== undefined) return `disabled: ${truncate(cause, CAUSE_MAX)}`;
	return quota.error;
}

/**
 * Lay the trailing cells out over as few lines of `width` as possible; a single
 * cell wider than `width` (a long error message) is split on word boundaries.
 */
function wrap(cells: Cell[], width: number): Cell[][] {
	const lines: Cell[][] = [];
	let current: Cell[] = [];
	let used = 0;
	for (const cell of cells) {
		for (const text of split(cell.text, width)) {
			if (current.length > 0 && used + GAP.length + text.length > width) {
				lines.push(current);
				current = [];
				used = 0;
			}
			if (current.length > 0) used += GAP.length;
			current.push({ text, color: cell.color });
			used += text.length;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

function split(text: string, width: number): string[] {
	if (text.length <= width) return [text];
	const chunks: string[] = [];
	let chunk = "";
	for (const word of text.split(" ")) {
		if (chunk.length > 0 && chunk.length + 1 + word.length > width) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk = chunk.length === 0 ? word : `${chunk} ${word}`;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

function pad(rendered: string, visible: number, width: number): string {
	return rendered + " ".repeat(Math.max(0, width - visible));
}

function paint(text: string, color: string | undefined, enabled: boolean): string {
	if (!enabled || color === undefined) return text;
	return `${color}${text}${RESET}`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function terminalWidth(): number {
	const columns = process.stdout.columns;
	if (columns === undefined || columns <= 0) return 100;
	return Math.max(60, columns);
}
