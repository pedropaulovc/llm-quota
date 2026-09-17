# llm-quota

Prints the remaining subscription quota for **every** Claude and Codex account stored locally, probing all of them concurrently.

```
$ llm-quota
CLAUDE
  pedro@vezza.com.br      max 20x  claude-code, omp#10  5h 98% (4h27m)  7d 42% (4d7h)
                                                        Fable 7d 0% EXHAUSTED (4d7h)
  pedro@vza.net           max 20x  omp#11               5h 94% (4h17m)  7d 20% (1d13h)
                                                        Fable 7d 21% (1d13h)
  pedropaulovc@gmail.com  max      omp#6                disabled: oauth refresh failed …

CODEX
  pedro@vezza.com.br      pro      omp#1                weekly 0% EXHAUSTED (2d16h)
                                                        GPT-5.3-Codex-Spark 5h 100% (5h0m)
                                                        credits 446.70 (≈$17.87)
  pedropaulovc@gmail.com  pro      omp#9                weekly 0% EXHAUSTED (2d14h)
                                                        GPT-5.3-Codex-Spark 5h 100% (5h0m)
    gpt-6-astra unavailable
```

Percentages are **remaining**, not used. The parenthesised time is until that window rolls over.

## Install

```sh
bun install       # nothing to fetch; the CLI has zero runtime dependencies
bun link          # exposes `llm-quota` on PATH
```

Requires Bun (uses `bun:sqlite` and the built-in fetch).

## Usage

```
llm-quota [--json] [--no-refresh] [--only claude|codex] [--all-sources] [--timeout <sec>]

  --json            machine-readable output (never includes tokens)
  --no-refresh      do not refresh expired access tokens, report them as errors
  --only <provider> restrict to "claude" or "codex"
  --all-sources     keep every store's copy of an account instead of deduping
  --timeout <sec>   per-request timeout, default 20
```

Exit code is 0 when at least one account reported, 1 when every account failed, 2 on a bad argument.

## Credential stores

Accounts are discovered from all four stores, then deduped so one subscription renders once (the source column lists every store it was found in; `--all-sources` disables this):

| Store | Accounts |
|---|---|
| `~/.omp/agent/agent.db` (`auth_credentials`) | Claude + Codex, several of each |
| `~/.claude/.credentials.json` | the active Claude Code login |
| `~/.claude/cred-profiles/*.json` | saved Claude profile snapshots |
| `~/.codex/auth.json` | the active `codex` CLI login |

A store that is missing is skipped; a store that is malformed reports on stderr and never hides the other accounts.

## Quota sources

- Claude: `GET https://api.anthropic.com/api/oauth/usage` for the windows, `/api/oauth/profile` for the account identity and plan (only when the store does not already know them, issued concurrently with the usage request).
- Codex: `GET https://chatgpt.com/backend-api/wham/usage`, which reports the plan windows, reserve meters such as Spark, and the credit balance.

`wham/usage` describes the **plan allowance** only: a spent weekly window reports exhausted even while a positive credit balance keeps funding requests as overage, which is why the credit line is shown next to the windows. ChatGPT sells overage at **25 credits per USD**, so balances render as credits with the dollar equivalent alongside.

## Token refresh

Access tokens are short-lived (Anthropic ~8h), so an expired token is refreshed automatically before probing and the rotated token is written back to the store it came from.

Refresh tokens **rotate**: dropping the new one bricks the login. Write-back is therefore mandatory and careful — SQLite rows are updated inside an `IMMEDIATE` transaction that re-reads the row and yields to a concurrent writer (omp refreshing the same credential) rather than clobbering it, and JSON files are patched field-wise then atomically renamed with mode 0600, preserving unrelated keys such as `mcpOAuth`.

Use `--no-refresh` to guarantee the tool only reads.

An Anthropic OAuth grant family dies ~30 days after the interactive login regardless of rotation; those accounts surface as `refresh failed: invalid_grant` and need a re-login.

Tokens are never printed, logged, or included in `--json` output, and are stripped from provider error bodies.
