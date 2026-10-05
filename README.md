# Darwin CLI

Trade and check your [Darwin](https://darwin.finance) agent from a terminal or a script. The Darwin CLI
uses an API key for one of your agents (or, if you made one, for all your active agents), keeps it in
your computer's secret store, and turns every agent action into a command — for coding agents
(Claude Code, Codex, OpenClaw, Cursor, Gemini CLI) and for your own scripts.

Chat apps like Claude or ChatGPT don't use the CLI — they connect to Darwin directly instead.

> **Not on npm yet.** `@darwinfinance/cli` has not been published. Until it is, install from source
> (below) for testing only.

## Install (from source, for testing)

Requires Node.js 20+ and [Bun](https://bun.sh) to build.

```sh
git clone https://github.com/DarwinFinance/darwin-cli.git
cd darwin-cli
bun install
bun run build
npm i -g .
darwin --version
```

Once published, the install line is `npm i -g @darwinfinance/cli`. Always install it — never run it
through `npx`: the CLI refuses to read a saved key when it runs from npx or from a project's
`node_modules`, because a project you are merely working in could substitute its own copy.

## Use

```sh
darwin login          # pairs a new agent: open the link, approve with your passkey
darwin login --beta   # the same against beta.darwin.finance
darwin help           # every command, from Darwin's own catalogue
darwin whoami
```

What each command does is documented by Darwin itself: the command list is fetched from the site you
logged in to (`darwin help`, `darwin <command> --help`, `darwin help --json`), so new commands appear
without a new release of this program. The API reference: <https://darwin.finance/agents/docs>.

`darwin mcp` runs the same commands as a local MCP server for desktop AI clients;
`darwin mcp --print-config claude|cursor|gemini` prints the registration.

## Security model

- **The key stays put.** It lives in the OS secret store (macOS Keychain, Windows Credential Manager,
  Linux Secret Service) — never in the config file. Headless machines can supply one with
  `DARWIN_API_KEY` / `DARWIN_API_KEY_FILE` (read, never written), or opt in to a plain file with
  `darwin login --store file` (owner-only permissions, with a warning). No flag ever takes a key on
  the command line (it would show in `ps` and shell history): `darwin login --with-key` reads stdin.
- **One realm per key.** A key is only ever sent to the Darwin site it belongs to (`darwin.finance`
  or `beta.darwin.finance`), over https. There is no host override; redirects are never followed.
- **Never printed.** Output is scrubbed of anything shaped like a Darwin credential.
- **No more than the key.** Every command is an ordinary agent API call under the key's own limits;
  Darwin signs server-side under the agent's policy. Nothing here can withdraw or move funds between
  your accounts — no such command exists.
- **No silent retries, no prompts.** A write is never re-sent. If its answer is lost, the CLI exits 6
  and says to check `darwin orders` rather than run it again. There is no `[y/N]` prompt; use
  `--dry-run` to see what a command would send. Writes and reads are distinct commands, so your
  agent harness can allow reads and ask before writes.
- **Server text is data.** Text a third party can influence (a token's name, a venue's message) is
  stripped of terminal escapes and shown as `untrusted: …`.
- What a secret store does *not* do: it can't stop malware running as your own user. On macOS the
  keychain item trusts the `node` binary for an npm install.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error — nothing was sent |
| 3 | no key / key refused |
| 4 | refused by Darwin |
| 5 | rate limited |
| 6 | a write's outcome is uncertain — don't re-run; check `darwin orders` |
| 7 | this CLI is too old |
| 8 | network unreachable before sending |
| 10 | the agent is paused |

## Develop

```sh
bun install
bun run check     # typecheck, lint, tests, build
```

MIT licensed.
