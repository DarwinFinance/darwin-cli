# Changelog

## 1.3.0 — unreleased

Account-level (owner) API keys, and a native read-only connection.

- **`darwin login --read-only`**: pair a READ-ONLY account-level key (Darwin's pairing asks for
  `credential: 2` and `read_only: "only"`). The CLI stops unless Darwin echoes exactly that, and
  saves the key only when the pickup is exactly Darwin's read-only answer (`credential: "owner_key"`,
  `trade: {scope: "none"}`, `read_only: true`). A read-only start drops any older pairing waiting here.
- **Account-level keys** (`darwinAI_mcp_…`) are accepted from `DARWIN_API_KEY`, `--with-key`,
  `--key-file` (version 2) and `--from-skill`. They never reach the agent tool runner: reads go to
  Darwin's owner REST routes (agent reads with `X-Darwin-Agent`; market data through
  `/api/agent/v1/data/{tool}`).
- **Trading with an account-level key that trades** (one Agentic Sub-Account or all): every trading
  command, `retry` and `cancel` run through Darwin's owner CLI door (`/api/agent/v1/owner-cli/*`) — the
  same server-side conversion and check-then-send as an agent key's — naming the sub-account with
  `--agent` (optional for a one-sub-account key). Never through the agent tool runner. Needs a Darwin
  site with that door (DarwinFinance/darwin#7463); elsewhere the CLI refuses the trade and sends nothing.
- **A read-only key's trades are refused before anything is sent**: writes, quotes, `pause`, `retry`,
  `cancel`. `darwin logout --revoke` revokes any account-level key (Darwin's owner-key self-revoke).
- **`darwin account portfolio|perps|earn|agents|watchlists|alerts`**: the whole account (needs an
  account-level key).
- `whoami`, `profile`, `doctor`, `help`, `docs`, `hello` and `darwin mcp` (reads only) understand
  account-level keys.
- Output with an account-level key is the route's own JSON as `{status, data}`: strings are not
  wrapped `{untrusted}`, epochs have no ISO twin, balances are in atoms with decimals.
- Note: a profile written by 1.3.0 for an account-level key (`kind = "owner"`) is unreadable to an
  older CLI, which then reports the config as incomplete. Remove that profile with 1.3.0
  (`darwin profile remove <name>`) before going back to an older version.
