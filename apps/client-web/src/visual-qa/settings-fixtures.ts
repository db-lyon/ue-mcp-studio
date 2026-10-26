/**
 * Settings states for the visual QA harness: every section, and the states
 * each one has (connected or not, an older ue-mcp, a fresh ledger, warnings).
 * Each answer is what the agent's own route would send; main.tsx answers the
 * rest of a section's reads from its defaults.
 */
import type { CacheExplainer, NativeOverview, PlanMeter, PriceTable, StudioSettings, UsageRow, UsageSummary, UsageWarning } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const day = (back: number) => {
  const d = new Date(Date.now() - back * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const midnight = (back: number) => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - back).toISOString();
};

const row = (key: string, label: string, budgetTokens: number, o: Partial<UsageRow> = {}): UsageRow => ({
  key, label, budgetTokens, tokens: { input: Math.round(budgetTokens * 0.8), cacheRead: budgetTokens * 3, cacheWrite: Math.round(budgetTokens * 0.1), output: Math.round(budgetTokens * 0.1) },
  cachedShare: 0.76, calls: 40, runs: 6, cost: null, costPartial: false, ...o,
});

const SUMMARY: UsageSummary = {
  from: midnight(6),
  to: midnight(-1),
  groupBy: "agent",
  total: row("total", "All", 2_480_000, { calls: 212, runs: 31, cost: 4.82, costPartial: true }),
  rows: [
    row("main", "Main agent", 1_620_000, { lastModel: "claude-sonnet-5-5", runs: 22, cost: 3.1, costPartial: true }),
    row("worker", "Studio's worker", 540_000, { lastModel: "claude-haiku-5-5", runs: 6, cost: 1.72 }),
    row("playtest-runner", "Playtest runner", 260_000, { lastModel: "claude-sonnet-5-5", runs: 2, cost: null }),
    row("scout", "scout", 60_000, { lastModel: "gpt-6-luna", runs: 1, tokens: { input: 50_000, cacheRead: null, cacheWrite: null, output: 10_000 }, cachedShare: null, cost: null }),
  ],
  days: [6, 5, 4, 3, 2, 1, 0].map((b, i) => ({ day: day(b), byKey: { main: [180, 260, 90, 310, 240, 330, 210][i] * 1000, worker: [60, 90, 0, 120, 80, 130, 60][i] * 1000, "playtest-runner": [0, 0, 0, 140, 0, 120, 0][i] * 1000, scout: b === 2 ? 60_000 : 0 } })),
  previous: { budgetTokens: 1_900_000, cachedShare: 0.81, cost: 3.6, costPartial: true, runs: 35, calls: 240 },
  ledgerStarts: ago(60 * 24 * 40),
  sessions: [
    { id: "s1", title: "Dress the cave with rocks and fog", agents: ["main", "worker"], budgetTokens: 1_210_000, cost: 2.4, turns: 9, last: ago(50) },
    { id: "s2", title: "Fix the gate trigger so the playtest passes on every attempt", agents: ["main", "playtest-runner"], budgetTokens: 880_000, cost: null, turns: 5, last: ago(60 * 26) },
    { id: "s3", title: "Door playtest", agents: ["main", "scout"], budgetTokens: 390_000, cost: 0.62, turns: 3, last: ago(60 * 70) },
  ],
};

const EMPTY_SUMMARY: UsageSummary = {
  ...SUMMARY,
  total: { ...row("total", "All", 0), tokens: { input: null, cacheRead: null, cacheWrite: null, output: null }, cachedShare: null, calls: 0, runs: 0 },
  rows: [], days: SUMMARY.days.map((d) => ({ day: d.day, byKey: {} })), previous: null, ledgerStarts: null, sessions: [],
};

const PLANS: PlanMeter[] = [
  { route: "claude", name: "Claude sign-in", signedIn: true, reportedAt: ago(12), tokens: { input: 1_300_000, cacheRead: 4_100_000, cacheWrite: 120_000, output: 210_000 },
    windows: [
      { kind: "five_hour", label: "Five-hour window", used: 0.62, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), status: "allowed" },
      { kind: "seven_day", label: "Seven-day window", used: 0.84, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), status: "warning" },
    ] },
  { route: "chatgpt", name: "ChatGPT sign-in", signedIn: true, reportedAt: null, tokens: { input: null, cacheRead: null, cacheWrite: null, output: null }, windows: [] },
];

const WARNINGS: UsageWarning[] = [
  { kind: "budget", severity: "warn", text: "86% of the budget for all agents today", detail: "Warnings start at 80%. At 100% the next call asks you first." },
  { kind: "plan-limit", severity: "warn", text: "Claude sign-in: 84% of the seven-day window limit used", detail: "Past it, Claude sign-in refuses calls until the window resets." },
  { kind: "cache-drop", severity: "info", text: "Claude sign-in: cached reads fell from 81% to 52% of input", detail: "Calls are rereading more at the full input price. A prompt that changes early, such as instructions edited often or a different screenshot size, breaks the cache." },
];

const explainer = (vendor: string, name: string, what: string, howLong: string): CacheExplainer => ({
  vendor, name, what, whoDecides: vendor === "anthropic" ? "The client, by where it places the marks." : "The vendor; the client keeps the prefix stable.",
  cachedReadCost: vendor === "anthropic" ? "About a twentieth to a tenth of the input price, by model; writing the cache costs 1.25 times input." : "A fraction of the input price, with no separate charge to write.",
  howLong, asOf: "2026-10-06", source: "https://example.invalid/caching",
});
const CACHE = {
  explainers: [explainer("anthropic", "Anthropic", "The request up to the cache marks: tools, system prompt and the conversation so far.", "Five minutes from the last use, renewed by each hit.")],
  others: [
    explainer("openai", "OpenAI", "Any repeated prefix of a long enough prompt, found by the vendor without marks.", "Minutes when idle, kept longer off peak, as the vendor decides."),
    explainer("google", "Google", "Repeated prefixes, cached implicitly by the vendor on current Gemini models.", "As the vendor keeps it; implicit caches carry no stated lifetime."),
  ],
};

const PRICES: PriceTable = {
  shippedAsOf: "2026-10-06",
  prices: [
    { vendor: "anthropic", model: "claude-sonnet-5-5", perMTok: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }, asOf: "2026-10-06", source: "https://example.invalid/pricing" },
    { vendor: "anthropic", model: "claude-haiku-5-5", perMTok: { input: 0.1, cacheRead: null, cacheWrite: 0.125, output: 0.5 }, asOf: "2026-10-06", source: "https://example.invalid/pricing" },
    { vendor: "openai", model: "gpt-6-luna", perMTok: { input: 0.1, cacheRead: 0.01, cacheWrite: 0, output: 0.5 }, asOf: "2026-10-25", source: "https://example.invalid/pricing", note: "Short-context rate." },
    { vendor: "google", model: "gemini-3.8-flash", perMTok: { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 }, asOf: "2026-10-22", source: "https://example.invalid/pricing" },
  ],
} as PriceTable;

/** The usage routes, with a summary and the extras a scenario picks. */
function usage(summary: UsageSummary, o: { warnings?: UsageWarning[]; plans?: PlanMeter[]; cache?: typeof CACHE } = {}) {
  return (p: string, url: URL): unknown => {
    if (p === "/v1/ext/studio/usage/summary") return url.searchParams.get("groupBy") === "model" ? BY_MODEL(summary) : summary;
    if (p === "/v1/ext/studio/usage/plans") return { plans: o.plans ?? PLANS };
    if (p === "/v1/ext/studio/usage/warnings") return { warnings: o.warnings ?? [] };
    if (p === "/v1/ext/studio/usage/cache") return o.cache ?? CACHE;
    if (p === "/v1/ext/studio/prices") return PRICES;
    return undefined;
  };
}

/** The same period grouped by model, as the ledger would group it. */
const BY_MODEL = (s: UsageSummary): UsageSummary => {
  const rows = [
    row("anthropic:claude-sonnet-5-5", "Sonnet 5.5", 1_880_000, { lastModel: "claude-sonnet-5-5", runs: 24, cost: 3.1, costPartial: true }),
    row("anthropic:claude-haiku-5-5", "Haiku 5.5", 540_000, { lastModel: "claude-haiku-5-5", runs: 6, cost: 1.72 }),
    row("openai:gpt-6-luna", "GPT-6 Luna", 60_000, { lastModel: "gpt-6-luna", runs: 1, tokens: { input: 50_000, cacheRead: null, cacheWrite: null, output: 10_000 }, cachedShare: null, cost: null }),
  ];
  return {
    ...s, groupBy: "model", rows,
    days: s.days.map((d) => ({ day: d.day, byKey: { "anthropic:claude-sonnet-5-5": (d.byKey.main ?? 0) + (d.byKey["playtest-runner"] ?? 0), "anthropic:claude-haiku-5-5": d.byKey.worker ?? 0, "openai:gpt-6-luna": d.byKey.scout ?? 0 } })),
  };
};

/** Settings > Agents with nothing connected: every convention's files found, none read by a route. */
const NATIVE_NONE = (): NativeOverview => ({ ...NATIVE_FULL, main: null, conventions: NATIVE_FULL.conventions.map((c) => ({ ...c, routes: [] })) });

/** Settings > Agents with Claude and Codex files, a subagent and a skill. */
const NATIVE_FULL: NativeOverview = {
  enabled: true,
  main: "claude",
  worker: { model: "Claude Haiku 5.5", effort: "low", starts: "asked", fromSettings: false },
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

const NOTHING_CONNECTED: Partial<StudioSettings> = { route: null, connected: {} as StudioSettings["connected"] };

const page = (title: string, section: string, o: Partial<Scenario> = {}): Scenario => ({ title, hash: `#/settings/${section}`, index: { playtests: [], listed: true }, height: 2600, ...o });

export const SETTINGS_SCENARIOS: Record<string, Scenario> = {
  "settings-list": page("Settings at narrow width: the list of sections, each with its state; wide opens Agents", "", { hash: "#/settings" }),
  "settings-agents": page("Agents: main agent, worker, and the project's Claude files with a subagent and a skill", "agents", { get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_FULL : undefined) }),
  "settings-agents-not-connected": page("Agents with nothing connected: the main agent cannot run yet, and no route reads the project's files", "agents", { settings: NOTHING_CONNECTED, get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_NONE() : undefined) }),
  "settings-agents-files-off": page("Agents with the project's own files switched off", "agents", { settings: { usage: { projectInstructions: false } } as Partial<StudioSettings> }),
  "settings-models": page("Models & accounts: Claude signed in, no keys", "models"),
  "settings-models-nothing": page("Models & accounts with nothing connected", "models", { settings: NOTHING_CONNECTED }),
  "settings-approvals": page("Approvals & review: shell and files ask, review on", "approvals"),
  "settings-approvals-older": page("Approvals & review on an older ue-mcp: the destructive row and the shared rows unavailable", "approvals", {
    settings: { destructiveKnown: false },
    get: (p) => (p === "/v1/ext/studio/agent-settings" ? { feedbackTool: true, feedbackMode: null, dialogMode: null, playtestRuns: "manual" } : undefined),
  }),
  "settings-project": page("Project: ready, Micro for other clients, one MCP client", "project"),
  "settings-project-attention": page("Project needing attention, with the context strategy set by the environment", "project", {
    get: (p) => p === "/v1/install"
      ? { ...INSTALL, plugin: { ...INSTALL.plugin, installedVersion: "1.4.9" }, ok: false, problems: [{ code: "plugin-outdated", what: "The bridge plugin is older than this ue-mcp", fix: "Run npx ue-mcp update, then rebuild the project." }] }
      : p === "/v1/ext/studio/context-strategy" ? { ...CONTEXT, fromFile: true, envOverride: "full" } : undefined,
  }),
  "settings-usage": page("Usage: a week recorded, warnings, plan meters, every tile compared with the week before, cache for connected and priced vendors", "usage", { get: usage(SUMMARY, { warnings: WARNINGS }) }),
  "settings-usage-cache-open": page("Usage, the priced but not connected vendors' cache explainers opened", "usage", { get: usage(SUMMARY), clicks: [".cache-priced > summary"] }),
  "settings-usage-plan-only": page("Usage where the week before ran only on plans: cost says so instead of a percentage", "usage", { get: usage({ ...SUMMARY, previous: { ...SUMMARY.previous!, cost: null } }) }),
  "settings-usage-fresh": page("Usage on a fresh machine: nothing recorded, no comparison", "usage", { get: usage(EMPTY_SUMMARY, { plans: [] }) }),
  "settings-usage-group-model": page("Usage grouped by model, after picking it", "usage", { get: usage({ ...SUMMARY, groupBy: "model" }), clicks: ["[aria-label='Group by'] button:nth-child(2)"] }),
  "settings-general": page("General: themes and updates", "general"),
  "settings-diagnostics": page("Diagnostics: the editor and daemon, and the event log, empty because the harness sends no events", "diagnostics"),
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

export const CONTEXT = { strategy: "micro", fromFile: false, envOverride: null, seeds: { micro: 2180, lean: 18740, full: 50920 }, seedSource: "measured on this ue-mcp" };
