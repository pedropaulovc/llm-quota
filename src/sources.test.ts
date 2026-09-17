import { describe, expect, test } from "bun:test";
import { dedupeAccounts } from "./sources.ts";
import type { Account } from "./types.ts";

const EMAIL = "dev@example.com";

function claude(sourceTag: string, fields: Partial<Account>): Account {
	return {
		provider: "claude",
		label: fields.email ?? sourceTag,
		source: { kind: "omp", dbPath: "/tmp/fixture.db", rowId: 1 },
		sourceTag,
		accessToken: `token-${sourceTag}`,
		...fields,
	};
}

const tokensOf = (accounts: Account[]) => accounts.map((account) => account.accessToken).sort();

describe("dedupeAccounts", () => {
	test("keeps an identity-incomplete credential out of two grants that share its email", () => {
		// One address can hold a Team seat and a personal plan: two grants, two
		// quotas. A Claude Code credential knows only the address until it is
		// probed, so it fits both — and guessing loses whichever grant it displaces.
		const team = claude("omp#11", { email: EMAIL, orgId: "org-team" });
		const personal = claude("omp#12", { email: EMAIL, orgId: "org-personal" });
		const unprobed = claude("claude-code", { email: EMAIL });

		const groups = dedupeAccounts([team, personal, unprobed]);

		expect(groups).toHaveLength(3);
		expect(tokensOf(groups)).toEqual(tokensOf([team, personal, unprobed]));
	});

	test("merges an identity-incomplete credential when only one grant matches", () => {
		const grant = claude("omp#20", { accountId: "acct-a", email: EMAIL, orgId: "org-team" });
		const unprobed = claude("claude-code", { email: EMAIL });

		const [merged, ...rest] = dedupeAccounts([grant, unprobed]);

		expect(rest).toHaveLength(0);
		// The account id the twin knew must survive, or the post-probe merge in
		// cli.ts can no longer recognise this row.
		expect(merged?.accountId).toBe("acct-a");
		expect(merged?.sourceTag).toBe("claude-code, omp#20");
	});

	test("splits candidates whose known identifiers disagree", () => {
		const one = claude("omp#30", { accountId: "acct-a", email: EMAIL });
		const two = claude("omp#31", { accountId: "acct-b", email: EMAIL });

		expect(dedupeAccounts([one, two])).toHaveLength(2);
	});

	test("prefers a live credential over a store that marked one dead", () => {
		const dead = claude("omp#40", {
			accountId: "acct-a",
			email: EMAIL,
			expiresAt: Date.now() + 86_400_000,
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		const live = claude("claude-code", { accountId: "acct-a", email: EMAIL, expiresAt: Date.now() + 60_000 });

		const [merged] = dedupeAccounts([dead, live]);

		expect(merged?.accessToken).toBe(live.accessToken);
		expect(merged?.disabledCause).toBeUndefined();
	});

	test("groups the same input identically whatever order the stores are read in", () => {
		const accounts = [
			claude("omp#11", { email: EMAIL, orgId: "org-team" }),
			claude("omp#12", { email: EMAIL, orgId: "org-personal" }),
			claude("claude-code", { email: EMAIL }),
			claude("claude-profile:work", { accountId: "acct-c", email: "other@example.org" }),
		];
		const shuffles = [
			[0, 1, 2, 3],
			[3, 2, 1, 0],
			[2, 0, 3, 1],
			[1, 3, 0, 2],
		];

		const rendered = shuffles.map((order) =>
			dedupeAccounts(order.map((index) => accounts[index] as Account)).map(
				(account) => `${account.sourceTag}:${account.accessToken}`,
			),
		);

		for (const result of rendered) expect(result).toEqual(rendered[0] as string[]);
	});
});
