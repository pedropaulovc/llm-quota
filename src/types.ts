/**
 * Shared contract between credential discovery, provider probes, and rendering.
 *
 * One `Account` is one (provider, subscription) pair discovered from a local
 * credential store. One `AccountQuota` is the normalized answer for it.
 */

export type Provider = "claude" | "codex";

/** Where a credential was discovered, and how to write a rotated token back. */
export type SourceKind =
	| { kind: "omp"; dbPath: string; rowId: number }
	| { kind: "claude-code"; filePath: string }
	| { kind: "claude-profile"; filePath: string; profile: string }
	| { kind: "codex-cli"; filePath: string };

export interface Account {
	provider: Provider;
	/** Human label: email when known, else account id. */
	label: string;
	accountId?: string;
	email?: string;
	/** Subscription tier as the store recorded it ("max", "pro", "plus"). */
	plan?: string;
	/**
	 * Subscription workspace. One email can hold several (a Team seat plus a
	 * personal Max plan), each a separate grant with its own quota, so this
	 * participates in identity.
	 */
	orgId?: string;
	orgName?: string;
	source: SourceKind;
	/** Short source tag for display: "omp#10", "claude-code", "codex-cli". */
	sourceTag: string;
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when `accessToken` expires; undefined when the store omits it. */
	expiresAt?: number;
	/** Set when the store already marked the credential dead (omp disabled_cause). */
	disabledCause?: string;
}

/** One metered window (rolling limit) reported by a provider. */
export interface QuotaWindow {
	/** Stable id: "5h", "7d", "weekly", "opus-7d", "spark-5h". */
	id: string;
	/** Display label: "5h", "7d", "weekly", "Opus 7d". */
	label: string;
	/** 0..100 of the allowance consumed. */
	usedPercent: number;
	/** Epoch ms when the window rolls over, when the provider reports it. */
	resetsAt?: number;
	/** Provider says this window is currently blocking requests. */
	exhausted?: boolean;
	/** True for windows that gate every request (vs. model-scoped meters). */
	primary?: boolean;
}

/** Pay-as-you-go balance that keeps serving after the plan window is spent. */
export interface Credits {
	/** Balance in `currency` units. */
	balance: number;
	/** ISO currency code for money balances, or "credits" for ChatGPT's credit meter. */
	currency: string;
	/** Dollar equivalent, set when `currency` is not already USD. */
	usd?: number;
	limitReached?: boolean;
}

export interface AccountQuota {
	account: Account;
	windows: QuotaWindow[];
	credits?: Credits;
	/** Free-form notes worth surfacing ("extra usage disabled", "spend cap hit"). */
	notes: string[];
	/** Populated instead of windows when the probe failed. */
	error?: string;
	/** Token was refreshed during this run. */
	refreshed?: boolean;
}

export interface ProbeOptions {
	timeoutMs: number;
	fetch?: typeof fetch;
}
