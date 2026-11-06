/**
 * Settings states for the visual QA harness: every section, and the states
 * each one has (connected or not).
 * Each answer is what the agent's own route would send; main.tsx answers the
 * rest of a section's reads from its defaults.
 */
import type { NativeOverview, StudioSettings } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

/**
 * The instant the harness daemon started, fixed so shots taken minutes apart (the web reference and the
 * mobile app's) print the same clock times in Diagnostics.
 */
export const QA_DAEMON_START = Date.parse("2026-11-04T23:20:00Z");
/** The events' clock: the daemon has been up five minutes. */
const before = (ms: number) => new Date(QA_DAEMON_START + 300_000 - ms).toISOString();

/** Settings > Agents with nothing connected: every convention's files found, none read by a route. */
const NATIVE_NONE = (): NativeOverview => ({ ...NATIVE_FULL, main: null, conventions: NATIVE_FULL.conventions.map((c) => ({ ...c, routes: [] })) });

/** Settings > Agents with Claude and Codex files, a subagent and a skill. */
const NATIVE_FULL: NativeOverview = {
  enabled: true,
  main: "claude",
  worker: { model: "Claude Haiku 5.5", effort: "low", starts: "asked" },
  conventions: [
    { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 1240, notes: [], skipped: [{ path: "AGENTS.md", why: "not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md" }],
      instructions: [
        { path: "CLAUDE.md", source: "project", tokens: 980, scope: { kind: "always" } },
        { path: "C:/Users/dev/.claude/CLAUDE.md", source: "user", tokens: 260, scope: { kind: "always" } },
        { path: "Source/StudioE2E/CLAUDE.md", source: "project", tokens: 310, scope: { kind: "folder", folder: "Source/StudioE2E" } },
      ],
      subagents: [{ name: "level-dresser", description: "Places props and foliage in a level from a short brief", path: ".claude/agents/level-dresser.md", source: "project", tokens: 420, model: "haiku", runs: { model: "Haiku 5.5" }, tools: "ue-mcp level and asset tools", effort: null, maxTurns: 30, problems: [] }],
      skills: [{ name: "naming-conventions", description: "Asset prefixes and folder layout for this project", path: ".claude/skills/naming-conventions", source: "project", tokens: 640, implicit: true, problems: [] }] },
    { convention: "codex", routes: [], instructionTokens: 300, notes: [], skipped: [], instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }], subagents: [], skills: [] },
    { convention: "gemini", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    { convention: "agents", routes: [], instructionTokens: 300, notes: [], skipped: [], instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }], subagents: [], skills: [] },
  ],
} as NativeOverview;

/** Settings > Agents with long skill and subagent descriptions, and one name too long to share its line with Open file. */
const LONG_SKILL = "Drive every open PR and issue in a GitHub repo to a terminal state (merge, close-with-fix, reject, approve, request changes, label planned/limitation) by orchestrating one subagent per item, then gate completion on a zero-context adversarial auditor.";
const NATIVE_LONG: NativeOverview = {
  ...NATIVE_FULL,
  conventions: NATIVE_FULL.conventions.map((c) => c.convention !== "claude" ? c : {
    ...c,
    subagents: [{ ...c.subagents[0], description: "Places props and foliage in a level from a short brief, checking each placement against the navmesh and the art direction notes before it commits anything to the level." }],
    skills: [
      { name: "triage-all", description: LONG_SKILL, path: "~/.claude/skills/triage-all", source: "user", tokens: 1500, implicit: true, problems: [] },
      { name: "pcg-level-assemblies-and-their-graphs", description: "Builds PCG level assemblies from a layout sketch.", path: ".claude/skills/pcg-level-assemblies-and-their-graphs", source: "project", tokens: 900, implicit: true, problems: [] },
    ],
  }),
} as NativeOverview;

const NOTHING_CONNECTED: Partial<StudioSettings> ={ route: null, connected: {} as StudioSettings["connected"] };


/** Settings > Notifications' reads: the project's state, and remote control's answer (a paid plan unless given). */
function notifyGet(state: unknown, remote: { available: boolean; signedIn: boolean } = { available: true, signedIn: true }): Scenario["get"] {
  return (p) => (p === "/v1/ext/studio/notifications" ? state : p === "/v1/ext/studio/remote/available" ? remote : undefined);
}

/** Settings > Remote control on a paid, online computer with one paired phone, and the PIN lock as given, scrolled to it. */
function remoteLockGet(lock: { pin: boolean; whole: boolean; sensitive: boolean; idleMinutes: number }): Partial<Scenario> {
  return {
    get: (p) =>
      p === "/v1/ext/studio/remote/available" ? { available: true, signedIn: true }
      : p === "/v1/ext/studio/remote/status" ? { enabled: true, relay: "https://remote.ue-mcp.com", state: "online", login: "dev", since: new Date(Date.now() - 60_000).toISOString() }
      : p === "/v1/ext/studio/remote/browsers" ? { browsers: [{ id: "KKFspqyVlDozkcbPOh9SZA", label: "Android", addedAt: "2026-11-03T19:15:57.234Z" }] }
      : p === "/v1/ext/studio/remote/lock" ? lock
      : undefined,
    scroll: ".pin-lock",
  };
}

/** Settings > Notifications as the agent answers it: the defaults, with one session muted. */
const NOTIFY_STATE = {
  project: "StudioE2E",
  prefs: {
    events: { "turn.finished": true, "turn.failed": true, "approval.waiting": true, "dialog.waiting": true, "playtest.needs-you": true, "playtest.finished": true, "subagent.finished": false, "context.limit": false, "project.offline": false, "project.online": false },
    mutedSessions: ["qa-muted"],
  },
  recent: [],
  titles: { "qa-muted": "Bake lighting overnight" },
};

const page = (title: string, section: string, o: Partial<Scenario> = {}): Scenario => ({ title, hash: `#/settings/${section}`, index: { playtests: [], listed: true }, height: 2600, ...o });

/**
 * What Studio 0.1.23 and an older ue-mcp answer, which the newest UI bundle on
 * the machine reads when the daemon serves it beside them (#151): no usage,
 * approvals, review or route order; no playtest runs; no agent files or
 * context strategy routes; an install report and update check missing parts.
 */
/** The theme being shot: the settings answer is where the app reads it. */
const shotTheme = () => new URL(location.href).searchParams.get("theme") ?? "ue-mcp";

const OLD_AGENT: Partial<Scenario> = {
  missing: ["/v1/ext/studio/native", "/v1/ext/studio/context-strategy", "/v1/ext/studio/endpoints"],
  get: (p) => {
    if (p === "/v1/ext/studio/settings") return { provider: "anthropic", model: "claude-sonnet-5-5", route: "claude", effort: "high", gatewayUrl: "https://api.ue-mcp.com", theme: shotTheme(), askBeforeChanges: true, composerHeight: null, dialogPolicy: { kind: "wait" }, connected: { claude: true }, account: null };
    if (p === "/v1/ext/studio/agent-settings") return { feedbackTool: true, feedbackMode: { mode: "interactive", project: false }, dialogMode: { mode: null, project: false } };
    if (p === "/v1/ext/studio/models") return { providers: [{ id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5" }] }, { id: "openai", name: "OpenAI" }] };
    if (p === "/v1/install") return { ok: false, plugin: { deployed: true, installedVersion: "1.4.0", enabledInUproject: true }, problems: [{ code: "bridge_version_mismatch", what: "The installed plugin is v1.4.0." }] };
    if (p === "/v1/update") return { server: "1.4.0", latest: "1.4.11", target: "1.4.11" };
    if (p === "/v1/ext/studio/updates") return { studio: { installed: "0.1.23", latest: "0.1.23", available: false } };
    if (p === "/v1/health") return { ok: true, pid: 1, version: "1.4.0", apiVersion: 1, projectRoot: "c:/projects/studioe2e", startedAt: "2026-10-28T09:00:00Z", clients: 0 };
    return undefined;
  },
};

/** Every settings answer empty but the theme being shot, as a missing or unreadable settings file with an agent that sends what it read. */
const EMPTY: Partial<Scenario> = {
  get: (p) => (p === "/v1/ext/studio/settings" ? { theme: shotTheme() } : ["/v1/ext/studio/agent-settings", "/v1/ext/studio/models", "/v1/ext/studio/native", "/v1/ext/studio/context-strategy"].includes(p) ? {} : undefined),
};

const SECTIONS = ["general", "agents", "models", "approvals", "project", "diagnostics"] as const;

export const OLD_DATA_SCENARIOS: Record<string, Scenario> = Object.fromEntries(SECTIONS.flatMap((s) => [
  [`settings-old-${s}`, page(`${s} with Studio 0.1.23's and an older ue-mcp's answers: every part renders, nothing blank`, s, { ...OLD_AGENT, fullPage: true })],
  [`settings-empty-${s}`, page(`${s} with every settings answer empty`, s, { ...EMPTY, fullPage: true })],
]));

/** Settings > General's account card as the account service answers: email sign-in offered or not, and the account's ways to sign in. */
const methods = (email: boolean): Scenario["get"] => (p) => (p === "/v1/ext/studio/auth/methods" ? { email, github: true } : p === "/v1/ext/studio/remote/available" ? { available: false, signedIn: false } : undefined);
const EMAIL_TYPED: Partial<Scenario> = {
  get: methods(true),
  types: [{ into: ".account-email input", text: "dev@example.com" }],
  afterType: { clicks: [".account-email button.primary"], wait: 700 },
};
const CODE_SENT = (p: string) => (p === "/v1/ext/studio/auth/email/start" ? { status: 200, body: { ok: true, expiresInSeconds: 600 } } : undefined);
const signedIn = (account: NonNullable<StudioSettings["account"]>): Partial<Scenario> => ({
  settings: { account },
  get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: false, signedIn: true } : p === "/v1/ext/studio/auth/methods" ? { email: true, github: true } : undefined),
});

export const ACCOUNT_SCENARIOS: Record<string, Scenario> = {
  "settings-account-email": page("General, signed out, email sign-in offered: Create an account or sign in, the email field and Send code, Continue with GitHub below", "general", { get: methods(true) }),
  "settings-account-code-sent": page("General after Send code: the 6-digit code entry for the address, Resend code, Change email and the expiry", "general", { ...EMAIL_TYPED, post: CODE_SENT }),
  "settings-account-code-error": page("General after a wrong code: the account service's one error inline, the code entry still there", "general", {
    ...EMAIL_TYPED,
    post: (p) => CODE_SENT(p) ?? (p === "/v1/ext/studio/auth/email/verify" ? { status: 400, body: { error: "That code is wrong or has expired. Request a new one." } } : undefined),
    then: { types: [{ into: ".account-code input", text: "123450" }], clicks: [".account-code button.primary"], wait: 700 },
  }),
  "settings-account-rate-limited": page("General when Send code is rate limited: the service's message with the wait, and Send code held until it passes", "general", {
    ...EMAIL_TYPED,
    post: (p) => (p === "/v1/ext/studio/auth/email/start" ? { status: 429, body: { error: "Too many codes requested for this address.", retryAfter: 600 } } : undefined),
  }),
  "settings-account-email-only": page("General signed in by email only: the address, Link GitHub, and Remove email held as the only way to sign in", "general", signedIn({ login: "dev@example.com", via: "studio", email: "dev@example.com", github: null })),
  "settings-account-github-only": page("General signed in with GitHub only: the login, Add email, and Unlink GitHub held as the only way to sign in", "general", signedIn({ login: "octocat", via: "studio", email: null, github: "octocat" })),
  "settings-account-both": page("General with email and GitHub both linked: Change and Remove email, Unlink GitHub", "general", signedIn({ login: "octocat", via: "studio", email: "cat@example.com", github: "octocat" })),
  "settings-account-email-off": page("General, signed out, email sign-in not offered yet: the GitHub sign-in alone, as before", "general", { get: methods(false) }),
};

export const SETTINGS_SCENARIOS: Record<string, Scenario> = {
  ...ACCOUNT_SCENARIOS,
  "settings-list": page("Settings at narrow width: the list of sections, each with its state; wide opens Agents", "", { hash: "#/settings" }),
  "settings-agents": page("Agents: main agent, worker, and the project's Claude files with a subagent and a skill", "agents", { get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_FULL : undefined) }),
  "settings-agents-long": page("Agents with long skill and subagent descriptions, and a skill name too long to share its line", "agents", { get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_LONG : undefined) }),
  "settings-agents-not-connected": page("Agents with nothing connected: the main agent cannot run yet, and no route reads the project's files", "agents", { settings: NOTHING_CONNECTED, get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_NONE() : undefined) }),
  "settings-agents-files-off": page("Agents with the project's own files switched off", "agents", { settings: { usage: { projectInstructions: false } } as Partial<StudioSettings> }),
  "settings-models": page("Models & accounts: Claude signed in, no keys", "models"),
  "settings-models-nothing": page("Models & accounts with nothing connected", "models", { settings: NOTHING_CONNECTED }),
  "settings-approvals": page("Approvals & review: shell and files ask, review on", "approvals"),
  "settings-project": page("Project: ready, Micro for other clients, one MCP client", "project"),
  "settings-project-attention": page("Project needing attention, with the context strategy set by the environment", "project", {
    get: (p) => p === "/v1/install"
      ? { ...INSTALL, plugin: { ...INSTALL.plugin, installedVersion: "1.4.9" }, ok: false, problems: [{ code: "bridge_version_mismatch", what: "The installed plugin is v1.4.9 and this package ships v1.4.11.", fix: "Run 'npx ue-mcp deploy C:/Projects/StudioE2E/StudioE2E.uproject' to sync the source, then rebuild." }] }
      : p === "/v1/ext/studio/context-strategy" ? { ...CONTEXT, fromFile: true, envOverride: "full" } : undefined,
  }),
  "settings-project-rebuild": page("Project with a bridge updated while the editor was open: needs a rebuild, with the Rebuild button", "project", {
    get: (p) => p === "/v1/install"
      ? {
          ...INSTALL,
          ok: false,
          plugin: { ...INSTALL.plugin, pendingBuild: { version: "1.4.11-beta.9", at: "2026-10-27T10:00:00Z", reason: "editor running" } },
          problems: [{ code: "bridge_build_stale", what: "The compiled plugin is older than its source, so handlers added since the last build answer 'Unknown method'.", fix: "Rebuild with the editor STOPPED: project(action='build')." }],
        }
      : undefined,
  }),
  "settings-project-yaml": page("Project with Advanced open: ue-mcp.yml highlighted, focused, with a line longer than the box", "project", {
    get: (p) => (p === "/v1/ext/studio/config" ? { path: "C:/Projects/StudioE2E/ue-mcp.yml", exists: true, text: YAML } : undefined),
    click: "details.advanced > summary",
    scroll: "details.advanced",
    focus: ".yaml-editor textarea",
  }),
  "settings-general": page("General: themes and updates", "general"),
  "settings-notifications": page("Notifications in Studio's window on a paid plan: this device's choices, every event at its default, one muted session", "notifications", {
    studioWindow: true,
    get: notifyGet(NOTIFY_STATE),
  }),
  "settings-notifications-quiet": page("Notifications with quiet hours on, details hidden, the project muted here, and two events changed for the project", "notifications", {
    studioWindow: true,
    storage: { "studio.notify.device": JSON.stringify({ enabled: true, mutedProjects: ["StudioE2E"], quiet: { on: true, from: "22:30", to: "07:00" }, privacy: "minimal", sound: "default", vibrate: "default", onlyWhenAway: true }) },
    get: notifyGet({ ...NOTIFY_STATE, prefs: { ...NOTIFY_STATE.prefs, events: { ...NOTIFY_STATE.prefs.events, "turn.finished": false, "subagent.finished": true } } }),
  }),
  "settings-notifications-off": page("Notifications turned off on this device: its other choices disabled, the project's events still shown", "notifications", {
    studioWindow: true,
    storage: { "studio.notify.device": JSON.stringify({ enabled: false }) },
    get: notifyGet({ ...NOTIFY_STATE, prefs: { ...NOTIFY_STATE.prefs, mutedSessions: [] }, titles: {} }),
  }),
  "settings-notifications-free": page("Notifications in Studio's window for an account without a paid plan: this computer's notifications only, nothing about paired devices or the remote-only events, and one line saying phone and browser notifications come with remote control", "notifications", {
    studioWindow: true,
    get: notifyGet(NOTIFY_STATE, { available: false, signedIn: true }),
  }),
  "settings-notifications-signed-out": page("Notifications in Studio's window with no ue-mcp account signed in: this computer's notifications only, no plan line", "notifications", {
    studioWindow: true,
    get: notifyGet(NOTIFY_STATE, { available: false, signedIn: false }),
  }),
  "settings-notifications-remote": page("Notifications in a paired browser that has not allowed notifications yet: the Allow button", "notifications", {
    remotePage: true,
    get: (p) => (p === "/v1/ext/studio/notifications" ? NOTIFY_STATE : undefined),
  }),
  "settings-general-signed-in": page("General with the ue-mcp account signed in from the panel, no paid plan: the login and Sign out", "general", {
    settings: { account: { login: "dev", via: "studio" } },
    get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: false, signedIn: true } : undefined),
  }),
  "settings-general-paid": page("General with a paid ue-mcp account: Manage plan beside Sign out", "general", {
    settings: { account: { login: "dev", via: "studio" } },
    get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: true, signedIn: true } : undefined),
  }),
  "settings-general-login-paid": page("General with a paid ue-mcp account from ue-mcp login: Manage plan and the login note under the account", "general", {
    settings: { account: { login: "db-lyon", via: "ue-mcp-login" } },
    get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: true, signedIn: true } : undefined),
  }),
  "settings-general-signing-in": page("General with the ue-mcp account sign-in started: the GitHub code and link", "general", {
    get: (p) => (p === "/v1/ext/studio/signin/studio" ? { state: "pending", url: "https://github.com/login/device", userCode: "ABCD-1234", expiresAt: "2030-01-01T00:00:00Z" } : undefined),
  }),
  "settings-general-remote": page("General in a paired browser: Updates shows what is newer with no Update button and the channel disabled, and no Sign out, since those run on the computer", "general", {
    remotePage: true,
    settings: { account: { login: "dev", via: "studio" } },
    get: (p) => (p === "/v1/ext/studio/updates"
      ? { channel: "beta", studio: { installed: "0.1.25-beta.18", latest: "0.1.25-beta.19", available: true }, plugin: { installed: "0.1.7", latest: "0.1.7", available: false, newer: false, location: "project" } }
      : undefined),
  }),
  "settings-models-remote": page("Models & accounts in a paired browser: sign-ins, API keys, custom endpoints and the gateway read only, with the note that they change on the computer", "models", { remotePage: true, fullPage: true }),
  "settings-approvals-remote": page("Approvals & review in a paired browser: the ask-first rules and the dialog policy read only; playtests, feedback and turn review still change", "approvals", { remotePage: true }),
  "settings-project-remote": page("Project in a paired browser: the context strategy and ue-mcp.yml read only", "project", {
    remotePage: true,
    get: (p) => (p === "/v1/ext/studio/config" ? { path: "C:/Projects/StudioE2E/ue-mcp.yml", exists: true, text: YAML } : undefined),
    click: "details.advanced > summary",
    scroll: "details.advanced",
  }),
  "settings-remote-pin-off": page("Remote control with the PIN lock off: what it does and Set a PIN", "remote", remoteLockGet({ pin: false, whole: false, sensitive: false, idleMinutes: 15 })),
  "settings-remote-pin-new": page("Remote control setting a PIN: the PIN twice, digits only", "remote", { ...remoteLockGet({ pin: false, whole: false, sensitive: false, idleMinutes: 15 }), clicks: [".pin-lock .pin-lock-actions button.primary"] }),
  "settings-remote-pin-on": page("Remote control with a PIN, both switches on: Studio locks on paired devices after the idle time, and sensitive actions ask", "remote", remoteLockGet({ pin: true, whole: true, sensitive: true, idleMinutes: 15 })),
  "settings-remote-pin-change": page("Remote control changing the PIN: the current PIN, then the new one twice", "remote", { ...remoteLockGet({ pin: true, whole: true, sensitive: true, idleMinutes: 15 }), clicks: [".pin-lock .pin-lock-actions button:nth-child(1)"] }),
  "settings-remote-pin-remove": page("Remote control removing the PIN: asks for the current PIN first", "remote", { ...remoteLockGet({ pin: true, whole: true, sensitive: true, idleMinutes: 15 }), clicks: [".pin-lock .pin-lock-actions button:nth-child(2)"] }),
  "settings-remote-pin-weaken": page("Remote control turning Ask for sensitive actions off: held until the current PIN", "remote", { ...remoteLockGet({ pin: true, whole: true, sensitive: true, idleMinutes: 15 }), clicks: ['.pin-lock button[aria-label="Ask for sensitive actions"]'] }),
  "settings-remote-pin-forgot": page("Remote control Forgot PIN: the confirm that every paired device goes with it", "remote", { ...remoteLockGet({ pin: true, whole: true, sensitive: true, idleMinutes: 15 }), clicks: [".pin-lock .pin-forgot-link"] }),
  "settings-remote-signin": page("Remote control on a signed-out computer: the ue-mcp account sign-in inline", "remote", {
    get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: false, signedIn: false } : undefined),
  }),
  "settings-remote-free": page("Remote control for an account without a paid plan: what it does, the price before tax, and the Upgrade action with the monthly or yearly choice", "remote", {
    get: (p) => (p === "/v1/ext/studio/remote/available" ? { available: false, signedIn: true } : undefined),
  }),
  ...OLD_DATA_SCENARIOS,
  "settings-diagnostics": page("Diagnostics: the editor and daemon, and the event log, empty because the harness sends no events", "diagnostics"),
  "settings-diagnostics-events": {
    ...page("Diagnostics: the event log with events, short and long payloads, one opened", "diagnostics"),
    events: [
      { type: "editor.connected", at: before(240_000), data: { project: "StudioE2E", port: 64666 } },
      { type: "studio.session.changed", at: before(180_000), data: { sessionId: "qa-session", status: "running", waitingCause: null } },
      { type: "studio.transcript.added", at: before(120_000), data: { sessionId: "qa-session", entry: { kind: "tool", call: { id: "t-build", name: "shell", input: { command: "npx ue-mcp project build_project --target StudioE2EEditor --configuration Development" }, outcome: "error", result: "Build failed: DoorComponent.cpp(43): error C2065: 'Alpha': undeclared identifier" } } } },
      { type: "studio.remote.available", at: before(60_000), data: {} },
      { type: "client.attached", at: before(30_000), data: { client: "studio-window", version: "0.1.25-beta.15" } },
    ],
    // Newest first: the transcript event, with the long payload, is third.
    clicks: [".log-event:nth-child(3) .log-data > summary"],
    scroll: ".log",
  },
};

export const INSTALL = {
  ok: true,
  problems: [],
  project: { engine: "5.7", name: "StudioE2E" },
  plugin: { deployed: true, installedVersion: "1.4.11-beta.4", installKind: "source", packagedVersion: "1.4.11-beta.4", enabledInUproject: true, pluginDir: "C:/Projects/StudioE2E/Plugins/UE_MCP_Bridge" },
  toolchain: { present: true, name: "MSVC 14.44" },
  node: { version: "v22.11.0" },
  clients: [{ id: "claude-code", name: "Claude Code", detected: true, configured: true, pinned: null }, { id: "gemini", name: "Gemini CLI", detected: true, configured: false, pinned: null }],
};

export const CONTEXT = { strategy: "micro", fromFile: false, envOverride: null, seeds: { micro: 2180, lean: 18740, full: 50920 }, };

/** Every kind of token the ue-mcp.yml editor colours, and a line wider than the box. */
const YAML = [
  "# ue-mcp.yml: what ue-mcp does for this project",
  "---",
  "context:",
  "  strategy: micro # micro, lean or full",
  "server:",
  "  mode: daemon",
  "  port: 9867",
  "  timeoutSeconds: 2.5",
  "  paramEcho: false",
  "  proxy: null",
  "defaults: &defaults",
  "  retries: 3",
  "  label: \"Studio E2E\"",
  "flows:",
  "  smoke:",
  "    <<: *defaults",
  "    steps:",
  "      - project.get_status",
  "      - level.list_actors",
  "      - !!str 42",
  "    tags: [qa, nightly, {owner: 'level-team'}]",
  "  notes: |",
  "    Free text: not a key, # not a comment.",
  "    Kept as written.",
  "extraContentRoots: [\"/Game/VeryLongFolderNameThatKeepsGoing/AndGoing/AndGoingPastTheRightEdgeOfTheBox\", \"/Game/Other\"]",
  "",
].join("\n");
