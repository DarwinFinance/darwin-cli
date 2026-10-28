/**
 * Every user-facing sentence, from the owner's copy deck (cli-rows.json, [v1] rows). One place, so a
 * wording change is one edit. Row ids in comments.
 */
export const INSTALL_LINE = "npm i -g @darwin.finance/cli";
/** v1.1-c: install, then `darwin setup` once (it installs the verified copy and prints its launcher). */
export const SETUP_LINE = "darwin setup";

/**
 * What a key may do, in Darwin's own words. Darwin sends this text (whoami's and the pairing answer's
 * `permissions`) and the CLI shows Darwin's text when it has it — these are only the fallback, in the
 * same vocabulary (Darwin's market data is readable by every key).
 */
export const PERMISSIONS = {
  agent: "Read: all Darwin market data, plus this agent's account · Trade: this agent",
  agents: "Read: all Darwin market data, plus all agents' accounts · Trade: all active agents",
} as const;

/** Darwin's permission line if it sent a usable one, else the fallback for this kind of key. */
export function permissionsText(server: unknown, kind: "agent" | "agents"): string {
  if (typeof server === "string") {
    const t = server.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "");
    if (t && t.length <= 200) return t;
  }
  return PERMISSIONS[kind];
}

export const copy = {
  // C.26
  pairingPrompt: (url: string, code: string, minutes: number) =>
    `To connect this terminal to Darwin, open this link and approve with your passkey:\n  ${url}\n  Code: ${code}\nWaiting for you to approve… (the code expires in ${minutes} minutes)`,
  // C.27
  connected: (store: string, profile: string, permissions: string) =>
    `Connected. Your API key is saved in ${store} as profile "${profile}". ${permissions}.`,
  // C.52
  connectedAll: (store: string, profile: string, agent: string, permissions: string = PERMISSIONS.agents) =>
    `Connected. Your API key is saved in ${store} as profile "${profile}". ${permissions}. Commands act on ${agent} unless you pass --agent.`,
  // C.28
  noSecretStore:
    "Nothing was started: there's no secure place to keep the API key on this computer, and Darwin shows a key only once. Set DARWIN_API_KEY for this session, or run `darwin login --store file` to keep it in a file only you can read.",
  // C.29
  fileStoreWarning: (path: string) =>
    `Warning: your API key will be saved in a plain file (${path}) that only your user account can read. Anyone who can use your account can trade for this agent with it. Prefer the secret store where you can.`,
  // C.30
  pastePrompt: "Paste your API key (it won't be shown): ",
  // C.31
  keyFileRealm: (fileRealm: string, profileRealm: string) =>
    `This key file is for ${fileRealm}, but this profile is for ${profileRealm}. Nothing was saved.`,
  // C.32
  loggedOut: (profile: string, url: string) =>
    `Removed the API key for "${profile}" from this computer. It still works until you revoke it on the agent's Manage tab: ${url}`,
  // C.33
  whoami: (profile: string, realm: string, agent: string, permissions: string, keyName: string, store: string) =>
    `${profile} · ${realm} · ${agent} · ${permissions} · API key "${keyName}" (stored in ${store})`,
  // C.34
  needAgent:
    "This API key trades for all your active agents. Name one with --agent <name or id>, or set a default: `darwin profile set-agent <name>`. Your agents: `darwin agents`.",
  // C.35 (lean v1: the MCP-page bridge is v1.1, so the `darwin mcp` clause is omitted)
  mcpPageKey: "This API key is from the MCP page: it reads your whole account and can't run agent commands. Log in with an agent's API key.",
  // C.36
  uncertainWrite:
    "Darwin may have received this order, but the answer didn't arrive. Don't run the command again — check `darwin orders` to see whether it went through.",
  // C.36 (v1.1, prepared writes: the retry command follows on its own line)
  uncertainWritePrepared: "Darwin may have received this order, but its result didn't come back.",
  // C.37
  paused: "This agent is paused, so it can't trade. Reads still work. Only you can resume it, on the agent's Darwin page.",
  // C.39
  quoteFooter: (quoteId: string, seconds: number, sell: string, amount: string, forTok: string) =>
    `Quote ${quoteId} expires in ${seconds}s (sell ${amount} ${sell} for ${forTok}). To place it: darwin order --quote ${quoteId}`,
  // C.40
  updateAvailable: (latest: string, current: string, command: string) =>
    `Darwin CLI ${latest} is available (you have ${current}). Update: ${command}`,
  // C.41
  updateRequired: (minCli: string, command: string) =>
    `This version of the Darwin CLI is no longer supported. Update to ${minCli} or later: ${command}`,
  // C.42
  snapshotUsed: (realm: string) =>
    `Couldn't load the latest command list from ${realm}; using the one built into this version. Some newer commands may be missing.`,
  // C.45
  mcpNeedsKey: "`darwin mcp` needs an API key: an agent's API key, or one from the MCP page. Chat apps connect to Darwin directly instead.",
  // C.46
  // (owner beta 2026-10-05: "order ID" named the nonce — the order is Darwin's id; the nonce is labelled)
  spotSent: (amount: string, sell: string, forTok: string, agent: string, orderId: string | null, nonce: string) =>
    `Sent: sell ${amount} ${sell} for ${forTok} on ${agent} · ${orderId ? `order ${orderId} · ` : ""}nonce ${nonce}`,
  // C.47
  envKeySet: "DARWIN_API_KEY is set, so this terminal already has a key and there is nowhere to save a new one. Unset it to log in, or keep using it.",
  // C.54
  allAgentsOff: "API keys for all your agents aren't available on this site yet. Use an API key for one agent.",
  // C.55
  printConfigNpx: "Install the Darwin CLI first (`npm i -g @darwin.finance/cli`) and run `darwin setup` once, then run `<the path it printed> mcp --print-config` again. A saved config must point at your verified copy, not npx or a copy found through PATH.",
  // C.58
  installFirst: "For your key's safety, install the Darwin CLI first: `npm i -g @darwin.finance/cli`, then run `darwin setup` once. It won't use your saved keys when run through npx or from a project folder's packages.",
  // v1.1-c (plan §7): the pinned launcher
  installAndSetup: "`npm i -g @darwin.finance/cli`, then `darwin setup`",
  setupFirst: "For your key's safety, run `darwin setup` once first: it installs a verified copy of the Darwin CLI and prints the path to run it by. Saved keys are only used through that path.",
  useLauncher: (launcher: string) =>
    `For your key's safety, saved keys are only used through your verified Darwin CLI: run ${launcher} instead of \`darwin\` (for example \`${launcher} whoami\`). A plain \`darwin\` is found through PATH, which a project can change.`,
  setupDone: (version: string, launcher: string) =>
    `Installed Darwin CLI ${version}, verified as built by Darwin's release workflow. From now on run it as:\n  ${launcher}`,
  setupNext: (launcher: string, beta: boolean) =>
    `Next: ${launcher} login${beta ? " --beta" : ""}   (or ${launcher} help). A plain \`darwin\` won't use your saved keys.`,
  // C.59
  keyNotSaved: (keyName: string, agent: string, url: string) =>
    `Darwin gave this terminal an API key, but it couldn't be saved, so nobody holds it now. Revoke the API key "${keyName}" on ${agent}'s Manage tab: ${url}. To get a new key for this agent, run \`darwin login --reconnect\`. (A key for all your agents can only be made again by creating a new agent.)`,
  // C.60
  nonceConflict: "That order ID was already used for a different order, so this one was never placed. Run the command again without --nonce.",
  // C.63
  revoked: (name: string, agent: string) =>
    `Revoked the API key "${name}" for ${agent} and removed it from this computer. It can't be used anywhere now.`,
  // C.64
  revokeAllWarning: "This API key trades for all your active agents. Revoking it stops it working for every one of them.",
  // C.65
  revokeNotConfirmed: (agent: string, url: string) =>
    `Couldn't confirm the API key was revoked, so it may still work and it's still saved here. Try again, or revoke it on ${agent}'s Manage tab: ${url}`,
  // C.69
  skillImported: (agent: string, store: string, profile: string) =>
    `Imported the API key for ${agent} that the Darwin skill saved. It's now in ${store} as profile "${profile}". The skill's copy is still there — add --delete-skill-copy to remove it.`,
  // C.71
  skillChanged: "Left the Darwin skill's saved key alone: it changed since the import, so it may be a different key.",

  // ── 1.3.0: account-level (owner) keys. EXACT WORDING, owner 2026-10-27 (approved as proposed); the
  //    lines added or changed for trading with these keys: EXACT WORDING, owner 2026-10-28. ──
  connectedReadOnly: (store: string, profile: string, permissions: string) =>
    `Connected read-only. Your API key is saved in ${store} as profile "${profile}". ${permissions}.`,
  // EXACT WORDING, owner 2026-10-28 (trading with account-level keys).
  connectedOwner: (store: string, profile: string, permissions: string) =>
    `Connected. Your account-level API key is saved in ${store} as profile "${profile}". ${permissions}. Name the Agentic Sub-Account a command acts on with --agent <name or id> (\`darwin agents\` lists them).`,
  readOnlyTry: "Try: darwin account portfolio · darwin agents · darwin balances --agent <name> · darwin market-status",
  readOnlyRefusal:
    "This Darwin connection is read-only: it reads market data and your account, but it can't trade. Nothing was sent. To trade from the terminal, connect an agent with `darwin login`.",
  // EXACT WORDING, owner 2026-10-28: a site where Darwin doesn't take an account-level key's trades yet.
  ownerTradingUnavailable:
    "Darwin doesn't take trades from an account-level API key on this site yet, so nothing was sent. To trade from the terminal here, connect an agent with `darwin login`.",
  readOnlyUnsupported:
    "Darwin can't connect this terminal read-only here, so nothing was started. On Darwin's Agents page, create a Read-Only API Key, then import it with `darwin login --with-key`.",
  readOnlyPickupBad: (keyName: string, url: string) =>
    `Darwin answered this read-only connection with an API key that isn't read-only, so it wasn't saved. Revoke the API key "${keyName}" on Darwin's Agents page: ${url}`,
  readOnlyKeyNotReadOnly:
    "Darwin says this API key can trade, so it wasn't saved as read-only. Nothing was saved. Use a Read-Only API Key, or leave out --read-only.",
  needAgentOwner:
    "This API key is for your whole Darwin account. Name an agent with --agent <name or id>, or set a default: `darwin profile set-agent <name>`. Your agents: `darwin agents`.",
  accountNeedsOwnerKey:
    "`darwin account` reads your whole Darwin account, which needs an account-level API key (`darwin login --read-only`). This profile's key is for an agent: try `darwin balances`.",
  ownerKeyRefused:
    "Darwin refused this API key. It may have been revoked or expired, or account-level API keys may not be available on this site yet.",
  ownerImportRefused: (realm: string) =>
    `${realm} refused this API key (revoked, expired, for the other site, or account-level API keys aren't available there yet). Nothing was saved.`,
  ownerLoggedOut: (profile: string, url: string) =>
    `Removed the API key for "${profile}" from this computer. It still works until you revoke it on Darwin's Agents page: ${url}`,
  // EXACT WORDING, owner 2026-10-28.
  ownerNoPrepared: "`darwin retry` and `darwin cancel` are for orders, and a read-only API key places none.",
  ownerKeyNotSaved: (keyName: string, url: string) =>
    `Darwin gave this terminal an API key, but it couldn't be saved, so nobody holds it now. Revoke the API key "${keyName}" on Darwin's Agents page: ${url}, then run \`darwin login --read-only\` again.`,
  unaskedOwnerKey: (keyName: string, url: string) =>
    `Darwin answered this pairing with an account-level API key it didn't ask for, so it wasn't saved. Revoke the API key "${keyName}" on Darwin's Agents page: ${url}`,
  ownerScopeUnknown: "Darwin's description of this API key isn't one this version of the Darwin CLI knows, so it wasn't saved. Update the CLI and try again.",
  keyFileScopeMismatch: "This key file doesn't match what Darwin says the key may do, so it wasn't saved.",
} as const;

/** Darwin's permission line for an account-level key if it sent a usable one, else the fallback. */
export function ownerPermissionsText(server: unknown, scope: keyof typeof OWNER_PERMISSIONS): string {
  if (typeof server === "string") {
    const t = server.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "");
    if (t && t.length <= 200) return t;
  }
  return OWNER_PERMISSIONS[scope];
}

/** What an account-level key may do, when Darwin didn't say (fallbacks in Darwin's own vocabulary). */
export const OWNER_PERMISSIONS = {
  none: "Read: all Darwin market data, plus your whole account · Trade: none",
  agent: "Read: all Darwin market data, plus your whole account · Trade: one agent",
  all_active: "Read: all Darwin market data, plus your whole account · Trade: all active agents",
} as const;
