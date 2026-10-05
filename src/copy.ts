/**
 * Every user-facing sentence, from the owner's copy deck (cli-rows.json, [v1] rows). One place, so a
 * wording change is one edit. Row ids in comments.
 */
export const INSTALL_LINE = "npm i -g @darwin.finance/cli";

export const copy = {
  // C.26
  pairingPrompt: (url: string, code: string, minutes: number) =>
    `To connect this terminal to Darwin, open this link and approve with your passkey:\n  ${url}\n  Code: ${code}\nWaiting for you to approve… (the code expires in ${minutes} minutes)`,
  // C.27
  connected: (store: string, profile: string, permissions: string) =>
    `Connected. Your API key is saved in ${store} as profile "${profile}". ${permissions}.`,
  // C.52
  connectedAll: (store: string, profile: string, agent: string) =>
    `Connected. Your API key is saved in ${store} as profile "${profile}". Read: all agents · Trade: all active agents. Commands act on ${agent} unless you pass --agent.`,
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
  // C.37
  paused: "This agent is paused, so it can't trade. Reads still work. Only you can resume it, on the agent's Darwin page.",
  // C.39
  quoteFooter: (quoteId: string, seconds: number, sell: string, amount: string, forTok: string) =>
    `Quote ${quoteId} expires in ${seconds}s. To place it: darwin order --quote ${quoteId} --sell ${sell} --amount ${amount} --for ${forTok}`,
  // C.40
  updateAvailable: (latest: string, current: string) =>
    `Darwin CLI ${latest} is available (you have ${current}). Update: ${INSTALL_LINE}`,
  // C.41
  updateRequired: (minCli: string) =>
    `This version of the Darwin CLI is no longer supported. Update to ${minCli} or later: ${INSTALL_LINE}`,
  // C.42
  snapshotUsed: (realm: string) =>
    `Couldn't load the latest command list from ${realm}; using the one built into this version. Some newer commands may be missing.`,
  // C.45
  mcpNeedsKey: "`darwin mcp` needs an API key: an agent's API key, or one from the MCP page. Chat apps connect to Darwin directly instead.",
  // C.46
  spotSent: (amount: string, sell: string, forTok: string, agent: string, nonce: string) =>
    `Sent: sell ${amount} ${sell} for ${forTok} on ${agent} · counts against today's transaction budget · order ID ${nonce}`,
  // C.47
  envKeySet: "DARWIN_API_KEY is set, so this terminal already has a key and there is nowhere to save a new one. Unset it to log in, or keep using it.",
  // C.54
  allAgentsOff: "API keys for all your agents aren't available on this site yet. Use an API key for one agent.",
  // C.55
  printConfigNpx: "Install the Darwin CLI first (`npm i -g @darwin.finance/cli`), then run `darwin mcp --print-config` again. A saved config must point at an installed copy, not npx.",
  // C.58
  installFirst: "For your key's safety, install the Darwin CLI first: `npm i -g @darwin.finance/cli`, then run `darwin …` again. It won't use your saved keys when run through npx or from a project folder's packages.",
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
} as const;
