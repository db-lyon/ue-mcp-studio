# Agent composer and settings, next version

Status: proposal for review. Nothing here is built. The interactive mockup that goes with it covers every screen named below.

## Why

Settings grew one card at a time, and it shows:

- **Settings > Agent is not about the agent.** It holds the approval toggle, a Usage card, per-turn review, editor dialogs, playtests and ue-mcp's feedback tool. Several of those are ue-mcp project settings that every MCP client shares, not settings of Studio's agent.
- **Usage assumes one vendor.** The card offers "Give the agent the project's CLAUDE.md", the subagent model is limited to the main model's vendor, and the subagent limit message points at "Settings > Agent > Usage". Nothing is wrong with Claude; the problem is that nothing else is first class.
- **Usage is a settings card, not usage.** It sets limits but never shows what was spent, by whom, or over what time.
- **Subagents are one anonymous worker.** Off, when asked, or automatic, on one model and one effort. There are no named helpers, no personas, no skills, no per-helper tools or budgets.
- **Context strategy is buried.** micro, lean and full are in Project > Project setup, only inside the editor, labelled "for other clients", and applied by re-running init. Studio's own agent has no choice at all: it always uses one fixed gateway tool.

This plan replaces that with a settings layout grouped by the decision the user is making, a provider-agnostic agent composer, one view of project instructions across file conventions, context strategy in plain sight for every client including Studio's own agents, and a usage dashboard.

## Decisions at a glance

1. Settings has seven sections: **Agents, Models & accounts, Approvals & review, Project, Usage, General, Diagnostics.** Every existing setting has one home (section 1.4). A setting that ue-mcp stores for every MCP client carries a "Shared with other clients" badge wherever it appears.
2. An **agent** is a named spec: instructions, model (any vendor, any route), effort, tool scope, context strategy, skills, instruction files. The main agent is one of them. Helpers are the rest. Mixed vendors are in the first release of the composer, not a later phase. Budgets are per machine and edited in one place, Usage > Budgets.
3. **Skills** are SKILL.md folders, the format ue-mcp and its plugins already ship. Studio reads four sources (built in, user, project, plugin) and shows the owner of each. Attaching a skill to an agent either preloads it or offers it on demand.
4. **Delegation** replaces off / when asked / automatic with a per-helper hand-off rule, team limits, and a table of which agent each entry point starts (quick ask, flow steps, assigned playtests).
5. **Templates** seed the composer from what the user has connected, whatever the vendor. A new user never sees a blank page.
6. Teams are **files**. Project agents live in `.ue-mcp/studio/agents/<id>.md` and are checked in. Export writes the same files; import shows a diff before it applies.
7. **Helpers share context when they can, on every vendor.** A prompt cache belongs to one model, so a helper on the same model and route as the main agent can start from the main agent's conversation and reuse its cache: a forked conversation on the Agent SDK, the same prefix on Studio's loop. Every other helper starts fresh with a brief, whatever its vendor. The UI labels every hand-off "shared context" or "fresh start" and lists any other difference in a compatibility strip.
8. **Project instructions** are read from every common convention, shown as one list with sizes and precedence, and injected by Studio the same way on every route. AGENTS.md is the file Studio creates and the shared file that wins.
9. **Context strategy uses ue-mcp's names everywhere: Micro, Lean, Full.** Project sets it for external clients. Each Studio agent has its own choice plus Auto, priced per vendor and per scope from measured data.
10. **Usage** is a dashboard in neutral units: tokens by kind, estimated cost only where a price exists, plan meters for sign-ins, one place to edit every budget, and each vendor's caching explained under the same four headings.

---

## 1. Information architecture

### 1.1 Inventory of today's settings

| # | Setting | Today's place | Stored in |
|---|---------|---------------|-----------|
| 1 | Updates (check, install, channel) | General | daemon |
| 2 | Theme (ue-mcp, Editor orange, Editor) | General > Appearance | settings.json `theme` |
| 3 | Model and vendor | General > Model, chat composer picker | settings.json `provider`, `model` |
| 4 | Effort | General > Model, chat composer | settings.json `effort` |
| 5 | Sign-ins (ChatGPT, Claude via the Claude Code login, Studio plan hidden) | General > Sign-ins | sign-in stores |
| 6 | Studio gateway URL | General > Sign-ins > Advanced | settings.json `gatewayUrl` |
| 7 | API keys (Anthropic, OpenAI, Google) | General > API keys | `~/.ue-mcp/studio/keys/*.key` |
| 8 | Ask before running commands and editing files | Agent > Commands and files | settings.json `askBeforeChanges` |
| 9 | Subagents off / when asked / automatic | Agent > Usage | `usage.subagents` |
| 10 | Subagent model (main model's vendor only) | Agent > Usage | `usage.subagentModel` |
| 11 | Subagent effort | Agent > Usage | `usage.subagentEffort` |
| 12 | Subagents per turn (1 to 16) | Agent > Usage | `usage.subagentsPerTurn` |
| 13 | Give the agent the project's CLAUDE.md | Agent > Usage | `usage.projectInstructions` |
| 14 | Image size (small, standard, full) | Agent > Usage | `usage.imageSize` |
| 15 | Stop a turn after N tokens | Agent > Usage | `usage.turnTokenLimit` |
| 16 | Review each turn (checkpoints), default for new sessions | Agent > Review | settings.json `reviewTurns` |
| 17 | Review on or off for one session | session Checkpoints panel | session |
| 18 | Who answers editor dialogs (dialog mode) | Agent > Editor dialogs | ue-mcp modes (shared) |
| 19 | If nobody answers a dialog (wait, agent after N min, safe default after N min) | Agent > Editor dialogs | settings.json `dialogPolicy` (Studio only) |
| 20 | Playtest runs (manual, automatic) | Agent > Playtests | playtest store |
| 21 | Assign to subagent budget (minutes, tokens) | Agent > Playtests | playtest store |
| 22 | Feedback tool on or off | Agent > Feedback | ue-mcp.yml `disable` (shared) |
| 23 | Feedback mode (ask, file, keep) | Agent > Feedback | ue-mcp modes (shared) |
| 24 | Account, plan, period usage | Account (hidden) | gateway |
| 25 | Install status, bridge plugin facts | Project | daemon |
| 26 | MCP clients configured | Project | daemon |
| 27 | Project setup: other clients, native Unreal tools, context strategy, skills for external clients | Project (editor only) | `ue-mcp init` |
| 28 | ue-mcp.yml text editor | Project | ue-mcp.yml |
| 29 | Status and logs | Diagnostics | daemon |
| 30 | Composer height | dragged divider | settings.json `composerHeight` |

### 1.2 The rule, and testing the proposed grouping

**The rule: a section groups settings by the decision the user is making, never by where the value is stored.** Where a value lives in ue-mcp and therefore applies to every MCP client on the project, the control carries a "Shared with other clients" badge. That badge, not the section, tells the user the blast radius.

The starting proposal was Models & accounts, Agents, Safety, Review, Playtests, Project, Usage. Changes after testing it against the inventory and the rule:

- **Safety and Review merge into "Approvals & review".** Both answer how much the user oversees agents, one before they act and one after. Review alone is one toggle.
- **Playtests is not a section.** Its three settings each belong to a decision that already has a home: who may start a playtest is an approval (Approvals & review), which agent runs assigned playtests is delegation (Agents > Delegation > Who handles what), and what that agent may spend is a budget (Usage > Budgets). A section of one radio and two mirrors is the smell the user described.
- **Feedback goes to Approvals & review.** "Ask me before a report is filed" is an approval of an agent's outward action. It carries the shared badge.
- **Editor dialogs stay in Approvals & review.** The mode (who answers) is shared ue-mcp state with the badge; the timeout policy is Studio's own.
- **Project keeps what configures ue-mcp for every client**: install, bridge, clients, context strategy for external clients, native Unreal tools, skills installed for external clients, ue-mcp.yml.
- **Project instructions belong to Agents.** They are files in the project, but the decision is what agents read.
- **General and Diagnostics stay.** Theme and updates are about Studio; status and logs need a home that is not Project.
- **Usage is a page in Settings, reachable from the chat.** The per-turn usage line and a token chip in the top bar link to it. A fifth top tab was considered and rejected: on a phone the drawer already holds the tabs and recent sessions, and Usage is visited, not lived in.

### 1.3 The seven sections

Desktop: a left rail with the sections under two quiet labels (Work: Agents, Models & accounts, Approvals & review; Project and Studio: Project, Usage, General, Diagnostics). Phone: Settings opens on that list with a one-line status under each name; a section opens full width with a back button; the app drawer reaches the other tabs. The rail shows a status dot where something needs attention (a helper on a fallback model, a budget past its warning threshold, an update).

| Section | Holds |
|---------|-------|
| **Agents** | Team (main and helpers), agent editor, Skills, Delegation (with who handles what), Instructions, Context strategy for Studio's agents. Templates, import and export. |
| **Models & accounts** | Sign-ins with plan status, API keys, custom endpoints, route order, the model catalog with every route that runs each model, Studio gateway URL under Advanced, Studio account when offered. |
| **Approvals & review** | Before it acts: shell commands, file changes, editor restarts, destructive ue-mcp actions, starting playtests (manual or automatic), filing feedback, editor dialogs. After it acts: per-turn review default. |
| **Project** | Install, bridge plugin, MCP clients, context strategy for other clients, native Unreal tools, skills installed for other clients, ue-mcp.yml under Advanced. |
| **Usage** | The dashboard: spend over time, per agent, per session, per model, vendor and route; plan meters; budgets (the only place they are edited); warnings; comparisons; how each vendor caches. |
| **General** | Appearance, Updates. |
| **Diagnostics** | Editor and daemon status, logs. |

### 1.4 Where every existing setting goes

| # | Setting | New home | Change |
|---|---------|----------|--------|
| 1 | Updates | General | none |
| 2 | Theme | General > Appearance | none |
| 3, 4 | Model, effort | Agents > main agent | the main agent's model and effort; the chat picker sets them for the session, with "Make default" |
| 5 | Sign-ins | Models & accounts | adds plan status where the route reports it |
| 6 | Gateway URL | Models & accounts > Advanced | none |
| 7 | API keys | Models & accounts | adds custom OpenAI-compatible endpoints |
| 8 | Ask before commands and files | Approvals & review | split into rows: shell commands, file changes, editor restarts, destructive ue-mcp actions |
| 9 | Subagents mode | Agents > Delegation | the delegation mode |
| 10, 11 | Subagent model, effort | Agents > Worker helper | any vendor, not only the main model's |
| 12 | Subagents per turn | Agents > Delegation | team limit, plus a parallel limit |
| 13 | CLAUDE.md toggle | Agents > Instructions | every convention, per file, per agent |
| 14 | Image size | Agents > agent editor | per agent, team default |
| 15 | Turn token limit | Usage > Budgets | the main agent's per-run budget |
| 16 | Review each turn | Approvals & review | none |
| 17 | Per-session review | session Checkpoints panel | none |
| 18 | Dialog mode | Approvals & review > Editor dialogs | shared badge |
| 19 | Dialog policy | Approvals & review > Editor dialogs | none |
| 20 | Playtest runs | Approvals & review > Starting playtests | Manual or Automatic, as today; shared badge if ue-mcp adopts it |
| 21 | Assign to subagent budget | Usage > Budgets | the Playtest runner agent's per-run budget; "Assign to subagent" on the card becomes "Assign to a helper" |
| 22, 23 | Feedback tool and mode | Approvals & review > Feedback reports | shared badge |
| 24 | Account | Models & accounts > Studio account | its usage feeds the Usage dashboard |
| 25 to 28 | Install, bridge, clients, setup, ue-mcp.yml | Project | context strategy and skills move out of the editor-only form and work from any browser |
| 29 | Status, logs | Diagnostics | none |
| 30 | Composer height | stays UI state | none |

---

## 2. The agent composer

### 2.1 Concepts

- **Agent.** A named spec. Exactly one is the main agent of a team; the main agent is what every new chat talks to.
- **Helper.** Any other agent. The main agent hands it work. Helpers do not hand work to other helpers (2.9). The UI says "helper" everywhere, including the Playtest card.
- **Skill.** A SKILL.md folder: a name, a description saying when to use it, a body, optional supporting files, optional tool needs.
- **Team.** The set of agents in effect for a project, resolved from layers.
- **Template.** A team shape that ships with Studio and is filled from what the user has connected.

### 2.2 Data model

All types live in `packages/shared`.

```ts
/** A vendor in the catalog. Open-ended: the catalog adds vendors without a type change. */
export type VendorId = string; // "anthropic", "openai", "google" and any vendor the catalog adds

/**
 * How a model is reached: a sign-in, the vendor's key, or a custom endpoint
 * the user added (an OpenAI-compatible base URL, a self-hosted server, a cloud platform).
 * A custom endpoint is also its own vendor in the catalog, `endpoint:<id>`, listing the models it reports.
 */
export type RouteId = SignInId | "key" | `endpoint:${string}`;

export interface ModelRef {
  vendor: VendorId;
  model: string;
  /** auto: the first connected route in the user's route order. Never written to shared files. */
  route?: RouteId | "auto";
}

/** What an agent can reach at all. Approvals decide separately whether a reachable tool asks first. */
export interface ToolScope {
  /** ue-mcp categories; "all" or a list such as ["blueprint", "asset"]. */
  ueMcp: "all" | "none" | { only: string[] };
  /** read: only actions ue-mcp marks as reads. */
  ueMcpAccess: "read" | "read-write";
  shell: boolean;
  files: "none" | "read" | "read-write";
  web: { search: boolean; fetch: boolean };
  editorRestart: boolean;
}

/** ue-mcp's own names. See section 4.2. */
export type ContextStrategy = "micro" | "lean" | "full";

/**
 * What a budget counts, everywhere: input + cache writes + output.
 * Cached reads are excluded (every vendor bills them far below fresh input)
 * and reported separately in Usage.
 */
export interface Budget {
  /** One run: a main agent's turn (its own calls, not its helpers'), or one hand-off to a helper. */
  perRunTokens: number | null;
  perRunMinutes: number | null;
  /** The local calendar day, this machine. */
  perDayTokens: number | null;
  onLimit: "stop-and-report" | "ask" | "fallback-model";
}

export interface SkillAttachment {
  skill: string;              // skill id, e.g. "ue-mcp-blueprint" or "ue-mcp-meshy:meshy-import"
  load: "preload" | "on-demand";
}

export interface AgentSpec {
  id: string;                 // slug; also the file name, <id>.md
  name: string;
  /** When to hand work to this agent. The main agent reads it to decide. */
  description: string;
  /** Persona and standing instructions, markdown. */
  instructions: string;
  model: ModelRef | "inherit";
  /** Tried in order when the model is not reachable on this machine. */
  fallbacks: ModelRef[];
  /** Shown and stored in the vendor's own levels; "inherit" takes the main agent's, mapped to the nearest. */
  effort: string | "inherit";
  tools: ToolScope;
  contextStrategy: ContextStrategy | "auto" | "inherit";
  skills: SkillAttachment[];
  /** Which project instruction files this agent reads. */
  instructionFiles: "all" | "none" | { only: string[] };
  imageSize: ImageSize | "inherit";
  /** Model calls before the agent must report; maps to the SDK's maxTurns. */
  maxSteps: number | null;
  /** Helpers only. */
  handoff?: HandoffRule;
  /** Where this definition came from; set by the resolver, not by files. */
  origin?: Origin;
}

export type Origin =
  | { kind: "template"; template: string }
  | { kind: "user"; path: string }
  | { kind: "project"; path: string }
  | { kind: "local"; path: string }; // this machine's overrides of a project agent

export interface HandoffRule {
  /**
   * named: only when the user names this helper.
   * judged: when the main agent judges the description fits.
   * always: every task matching `matches`.
   * split: parallel copies when a task has independent parts (today's automatic worker).
   */
  when: "named" | "judged" | "always" | "split";
  matches?: string[];
  /** Run beside the main agent without blocking its turn. */
  background: boolean;
  /**
   * What the helper starts from.
   * shared: the main agent's conversation so far, then the brief. Only when model and route match the main agent's (a prompt cache belongs to one model).
   *   A cache matches the exact prefix (tools, system prompt, messages), so a shared-context helper keeps the main agent's
   *   system prompt, tool list, preloaded skills and context strategy unchanged. Its own instructions go into the brief
   *   message, and a narrower tool scope is enforced by a permission check on each call, not by removing tools.
   * brief: the brief alone. brief-and-files: the brief and the files the main agent read this turn.
   */
  startWith: "shared" | "brief" | "brief-and-files";
}

export interface DelegationPolicy {
  /** never: no helpers. on-request: only helpers the user names. auto: helpers' rules apply. */
  mode: "never" | "on-request" | "auto";
  maxPerTurn: number;         // 1 to 16, today's subagentsPerTurn
  maxParallel: number;        // 1 to 8
}

/** Entry points other than the chat, and which agent each starts. The chat always starts the main agent. */
export interface Bindings {
  quickAsk: string;           // agent id
  flowSteps: string;
  assignedPlaytests: string;
}

export interface TeamSpec {
  version: 1;
  name: string;
  main: string;
  agents: AgentSpec[];
  delegation: DelegationPolicy;
  bindings: Bindings;
  defaults: { contextStrategy: ContextStrategy | "auto"; imageSize: ImageSize };
}

/** Every budget, edited in Usage > Budgets only. Per machine; the warning threshold applies to all. */
export interface Budgets {
  team: { perDayTokens: number | null; perMonthTokens: number | null; onLimit: "ask" | "stop" };
  agents: Record<string, Budget>;
  warnAt: number;             // 0.5 to 0.95
}

export interface SkillSpec {
  id: string;                 // dir name; plugin skills are "<package-prefix>:<name>"
  name: string;
  description: string;
  body: string;
  files: string[];            // supporting files beside SKILL.md
  /** Tools the skill needs; an agent without them cannot attach it. */
  needs?: Partial<ToolScope>;
  source:
    | { kind: "builtin"; owner: "studio" | "ue-mcp"; version: string }
    | { kind: "user"; path: string }
    | { kind: "project"; path: string }
    | { kind: "plugin"; package: string; version: string; path: string };
  /** Approximate tokens of the body, for the preload cost shown in the UI. */
  tokens: number;
}
```

Budgets are per machine because spend is per machine and per account. They are never written to shared files.

### 2.3 Files and layers

A team resolves from four layers; later wins per agent id and per field:

1. **Template** that seeded the team (read only, ships with Studio).
2. **User**: `~/.ue-mcp/studio/agents/<id>.md`. The user's own helpers, available to add to any project's team.
3. **Project**: `<project>/.ue-mcp/studio/agents/<id>.md` and `<project>/.ue-mcp/studio/team.yml`. Checked in. This is how a team shares a setup.
4. **Local**: the extension's per-project data dir. This machine's overrides (a teammate without a Google key pins the Level dresser to another model), routes and budgets. Never checked in.

An agent file is markdown with YAML frontmatter, the same shape as a skill, so it reads well in review:

```markdown
---
name: Level dresser
description: Places and arranges props, foliage and PCG volumes in a level from a brief or a reference screenshot.
model: { vendor: google, model: gemini-3.1-pro-preview }
fallbacks: [{ vendor: anthropic, model: claude-sonnet-5-5 }]
effort: medium
tools: { ueMcp: { only: [level, asset, foliage, pcg, landscape] }, ueMcpAccess: read-write, shell: false, files: read, web: { search: false, fetch: false }, editorRestart: false }
contextStrategy: auto
skills: [{ skill: hollowreach-naming, load: preload }]
handoff: { when: judged, background: false, startWith: brief }
---
You dress levels for Hollowreach. Keep sight lines to the objective clear, and match prop density to the zone brief.
```

Shared files never carry a route, a key, an account or a budget. The editor marks every field that came from a project file and offers "Save to project" or "Save on this machine only".

Studio reads its own user-level files only. It does not read other tools' user-level instruction or skill folders.

### 2.4 Skills

Sources, in the library's filter order:

| Source | Where | Owner shown |
|--------|-------|-------------|
| Built in | Studio's own (shipped in the extension) and ue-mcp's packaged skills | Studio, ue-mcp, with version |
| Plugin | Installed by `ue-mcp plugin install` into the project skills folder, owner from `.ue-mcp/skills.json` | the plugin package and version |
| Project | `<project>/.claude/skills/<name>/SKILL.md` not owned by a plugin | Project, with the path |
| User | `~/.ue-mcp/studio/skills/<name>/SKILL.md` | You |

Plugin skills are first class: the library groups them under their plugin, shows the version, and updates or removes them with the plugin. Studio never edits a plugin's skill; "Customize" copies it to a project or user skill with a new name.

Studio reads the list from the daemon, not from ue-mcp's files: a general `GET /v1/skills` listing on the daemon, with owners, is a prerequisite and goes into ue-mcp first.

Attaching:

- **Preload** puts the body in the agent's instructions. Cost is paid every call; the UI shows it in tokens.
- **On demand** lists the name and description; the agent loads the body when it needs it. On the SDK route that is the SDK's skill tool; on Studio's loop a `skill` tool with the same contract.
- A skill that needs a tool the agent lacks cannot be attached: the button is disabled and says what is missing ("Needs shell").

### 2.5 Delegation

The Delegation tab has four parts:

1. **Mode**: Never, Only when I name a helper, or Automatic. Automatic applies each helper's hand-off rule.
2. **Hand-offs**, a diagram and a table with one row per helper: when (only when named, when it fits the description, always for matching work, when the work splits), what it starts from (shared context, the brief, the brief and files), background or not, and whether the hand-off is shared context or a fresh start on this machine. A **Try a task** box asks the main agent's model which helpers the current rules would pick and why; nothing runs.
3. **Limits**: helpers per turn and helpers at the same time.
4. **Who handles what**: which agent each entry point starts. Quick ask in the editor, Flow agent steps, Assigned playtests. The chat always starts the main agent.

Today's anonymous worker becomes a real helper called **Worker**: the main agent's model (so it can share context), the main agent's tools, hand-off "when the work splits", starting from shared context. Users can rename, retarget or delete it.

### 2.6 Templates

Shown on first open of Agents and on "New team". Templates are shapes, not model choices: each card shows the agents and fills models from what this machine has connected, whatever the vendor. Cost is a relative word (Lightest, Moderate, Heaviest) from the measured context costs and the models picked, never currency.

| Template | Agents | Why pick it |
|----------|--------|-------------|
| Solo | Main | One agent does everything. Lightest. |
| Lead and workers | Main, Worker | Today's automatic mode, made explicit. |
| Specialists | Main, Blueprint smith, Level dresser, Material artist, Playtest runner | Narrow tools and skills per helper, so each hand-off reads less. |
| Thrifty | Main on the largest connected model; every helper on the smallest connected model at low effort | Spend control. |
| Reviewer pair | Main, Reviewer (read only, another vendor when one is connected) | A second model checks the first's changes before the turn ends. |

Filling rule: the sheet asks for a main vendor, defaulting to the current main agent's. Each catalog model carries a size tier (large, mid, small) from Studio's model list, so "largest" and "smallest" are defined within a vendor. Main takes the vendor's large model; Worker takes Main's model, so it shares context; specialist helpers take the mid model on the same route; Thrifty's helpers take the small model. A role with a suggested vendor (the Level dresser suggests Gemini) uses it when that vendor is connected and says so when it is not. With only an OpenAI key, Specialists is five OpenAI agents.

Applying a template asks where it goes: the project's team (written to `.ue-mcp/studio/`, for the user to commit) or only this machine (the local layer).

### 2.7 Export and import

- **Export** writes `team.yml`, `agents/*.md`, and the project skills those agents use. Into the project (the default, ready to commit) or into a folder the user picks.
- **Import** reads a folder or a project's files, then shows a review: agents added, changed (field-level diff), removed; skills referenced but missing; vendors not connected on this machine with the fallback that will be used. Apply all, or ticked agents only.
- Teams never travel with secrets, routes or budgets.

### 2.8 Routes: how one spec runs everywhere

**Effective route.** Everything the UI shows about an agent (its model chip, the hand-off label, the compatibility strip, its cache share in Usage) uses the route it will actually run on here, which may be a fallback. The configured model is shown as secondary text: "Sonnet 5.5, Claude sign-in. Wants Gemini 3.1 Pro; no Google key."

**A. Main agent on the Claude sign-in (Agent SDK).**

| Spec field | SDK option |
|------------|------------|
| instructions + instruction files + preloaded skills | `systemPrompt` (Studio composes it; `settingSources` stays `[]`, so the SDK reads no file on its own) |
| model, effort | `model`, `effort` |
| tools | `allowedTools` over Studio's in-process tools (`mcp__studio__*`), plus the SDK's web search when `web.search` |
| on-demand skills | `plugins: [{ type: "local", path }]` pointing at a folder Studio generates with the attached skills, and `skills` naming them |
| a helper on the main agent's model, starting from shared context | a forked query of the main agent's session (`resume` with `forkSession: true`, `resumeSessionAt` the last complete message before the `delegate` call, so the fork never ends on an unanswered tool call), with the same `systemPrompt` and tools; its instructions arrive as the brief and its scope is enforced in `canUseTool`. Phase 2 starts by verifying the fork mid-turn; if it does not hold, these helpers start fresh and the UI says so |
| other helpers on the Claude sign-in | `agents: { [id]: { description, prompt, model, effort, tools, skills, maxTurns, background } }`; a native subagent starts from its own prompt and the brief, so it is a fresh start on the same plan |
| helpers on another vendor or route | the same `delegate(helper, brief)` tool in the in-process server; Studio runs the helper on its own loop and returns the report |
| per-turn and parallel limits | the PreToolUse hook Studio already uses for the subagent limit, applied to `Agent` and `delegate` |
| budgets | Studio's token counter on each message, as today; at a limit Studio stops the task (`stopTask`) or the turn |

**B. Main agent on Studio's loop** (an API key, ChatGPT, a custom endpoint, the Studio plan). The `agent` tool takes a `helper` argument. A helper on the same model and route starts from shared context: Studio sends the main agent's conversation prefix unchanged, then the brief, so the vendor's prefix cache applies (OpenAI and Google cache repeated prefixes automatically; Anthropic keys use the cache marks Studio already sets). Any other helper starts fresh. A helper on the Claude sign-in runs as its own SDK conversation, the path assigned playtests already use.

**C. Mixed vendors** follow from A and B. What differs, by hand-off kind:

| Behaviour | Shared context (same model and route) | Fresh start (any other model or route) |
|-----------|----------------------------------------|---------------------------------------|
| Starts from | the main agent's conversation, then the brief | the brief (and files, if chosen) |
| Prompt cache | reuses the main agent's prefix | its own, from zero |
| Background run | yes; on the SDK it can outlive the turn | yes; ends with the turn |
| Survives a daemon restart | on Studio's loop yes; on the SDK no | on Studio's loop yes |
| Effort | the vendor's own levels | the vendor's own levels |
| Web search | vendor-run where the vendor has it, else fetch only | same |
| Skills | SDK skill tool or Studio's `skill` tool, same contract | same |

The agent editor's **compatibility strip** lists only rows where this agent's effective model or route differs from the main agent's, and is hidden when none do. When a helper starts from shared context, the editor shows the main agent's tool list, instruction files, skills and context strategy read only, with one line saying they follow the main agent's so the cache matches, and keeps one editable row set, "Allowed for this helper", for the permission check; its instructions become the brief preamble, and its tool scope still applies as a permission check. The effort control shows the vendor's own levels (Anthropic: Low to Max; OpenAI: Low to Extra high; Gemini: Low to High); "inherit" shows the level that will be sent.

### 2.9 Decisions inside the composer

- Helpers cannot hand work to helpers. One level keeps cost and transcripts readable and matches the SDK.
- Approvals stay global (Approvals & review). Tool scope per agent decides what exists; approvals decide what asks.
- The chat's model picker changes the main agent for the session. "Make default" writes it to the main agent.

---

## 3. Project instructions

### 3.1 Files read

In this order, each when present:

| Order | File | Notes |
|-------|------|-------|
| 1 | Studio user instructions (`~/.ue-mcp/studio/instructions.md`) | the user's own, every project |
| 2 | `.github/copilot-instructions.md` | |
| 3 | `.cursor/rules/*.mdc`, `.cursorrules` | frontmatter `globs` honoured: a rule with globs is included only when the turn touches a matching file |
| 4 | `GEMINI.md` | |
| 5 | `CLAUDE.md`, `.claude/CLAUDE.md` | `@path` imports followed, one level |
| 6 | `AGENTS.md` | the vendor-neutral file; last of the shared files, so it wins among them |
| 7 | any of the files above in a subfolder, such as `Source/Hollowreach/AGENTS.md` | included when the agent works in that folder; more specific than the root files |
| 8 | `AGENTS.local.md`, `CLAUDE.local.md` | per machine, usually git-ignored; last, so a person can override the team |

"Add a file" adds any other path to the list (a design doc, a style guide); it is read at the position the user drags it to.

### 3.2 Precedence and duplicates

- Later wins on conflict, and the composed prompt says so in one line.
- Files with the same content, or a file that only imports another (`CLAUDE.md` containing `@AGENTS.md`), are included once and listed as "same as AGENTS.md".
- Studio injects the result itself on every route. The SDK's own file loading stays off, so a Claude main agent and a Gemini helper read the same text.

### 3.3 What the user sees

Agents > Instructions: one row per file with its path, size in tokens, the agents that read it, and a toggle. A preview pane shows the composed result for a chosen agent, with each file's heading and the total. "Create AGENTS.md" when there is none, prefilled from the existing files. Each agent's editor has "Instruction files: all, none, or chosen".

---

## 4. Context strategy

One vocabulary: ue-mcp's **Micro, Lean, Full**, in Project and in Agents.

### 4.1 Other MCP clients

Project > Context strategy for other clients:

- Three options with ue-mcp's measured seed (micro ~2.2k tokens, lean ~19k, full ~51k), what each advertises, and the discovery round trips each costs.
- The clients it affects (from the install report), and "Restart those clients to apply".
- An "overridden by `UE_MCP_CONTEXT_STRATEGY`" notice when the environment sets it.
- Writes `context.strategy` in ue-mcp.yml through the daemon, so it works in a browser too. Studio already edits ue-mcp.yml keys this way for the feedback tool.

### 4.2 Studio's own agents

Each agent chooses Micro, Lean, Full or Auto (team default in Agents > Context strategy):

| Strategy | What the agent sees |
|----------|---------------------|
| Micro | one ue-mcp tool: search, describe, call (today's) |
| Lean | one tool per category in scope, action names listed, signatures on demand |
| Full | one tool per category in scope, every signature inline |
| Auto | the cheapest measured strategy for this agent's vendor and scope size |

Studio's Micro seeds about 1.1k tokens against ue-mcp's 2.2k because Studio's system prompt already explains how to use ue-mcp, so the tool carries only its parameters. The page says so beside the numbers.

Scope changes the price: Full for a helper scoped to three categories costs a fraction of Full for all 29. The page shows each agent's seed cost under each strategy at its own scope, computed from ue-mcp's projections. Building Lean and Full for Studio needs the daemon to hand over ue-mcp's projections for a category list; that is a general daemon feature and lands in ue-mcp first.

**Measurements.** Studio ships `context-costs.json`, filled by the measurement work in progress:

```ts
export interface ContextMeasurement {
  measuredAt: string;
  studioVersion: string;
  ueMcpVersion: string;
  /** One run per vendor model, per scope bucket, per strategy. */
  runs: Array<{
    model: ModelRef;
    scope: "1-3" | "4-8" | "9+";
    strategy: ContextStrategy;
    seedTokens: number;
    tasks: Array<{ id: string; totalTokens: number; modelCalls: number; discoveryCalls: number; passed: boolean }>;
  }>;
}
```

**Auto's rule is a lookup, not a heuristic**: for the agent's vendor and scope bucket, the strategy with the lowest median tokens per task among those within one task of the best pass rate in that cell. Twelve tasks a cell is thin, so one failure does not decide it; the page says how many tasks each cell has. The page shows the table it looked up and highlights the cell. A vendor without measurements falls back to the nearest measured model of another vendor, marked "estimated from <model>". Until any measurement ships, Auto is hidden and every agent uses Micro, today's behaviour.

---

## 5. Usage dashboard

### 5.1 Units

- **Tokens, in four kinds:** input, cached read, cache write, output. A kind a vendor does not report or charge shows as "not reported", never as zero.
- **Estimated cost** only for routes billed per token (API keys, custom endpoints with a price set). From a price table that ships with Studio, dated, with a source link per vendor, editable by the user.
- **Plan meters** for sign-ins (Claude sign-in, ChatGPT, Studio plan): the limit windows the route reports (for example a five-hour window and a weekly one, with percent used and reset time), and the tokens Studio sent through it. When a route reports nothing, the meter says so. An opt-in "key-equivalent cost" column says what the same tokens would cost on a key, labelled as hypothetical.

### 5.2 Views

- **Header:** period (today, 7 days, 30 days, custom), filters by agent, vendor, route and source (chat, quick ask, flows, playtests).
- **Summary tiles:** tokens, cached read share, estimated cost on keys, runs.
- **Plans:** one meter per signed-in plan.
- **Over time:** stacked bars by agent, model, vendor or route, with the team daily budget line.
- **By agent:** effective model and route, tokens, share, token kinds, cached share, cost or "plan", budget status.
- **By session:** title, agents used, tokens, cost, link to the session.
- **Compare:** two agents, two models or two periods side by side on tokens per run, model calls, cached share and an outcome where one exists (compile on first try, playtest passed).
- **Budgets:** the only place budgets are edited. A row per agent (per run tokens, minutes, per day, at the limit) and the team rows (per day, per month). One warning threshold for all. The definition from 2.2 is printed above the table.
- **Warnings:** anything past the threshold, an agent on a fallback model, a route that reported a limit, a fall in cached share with its likely cause.
- **How each vendor caches:** one card per connected vendor, four headings each: what is cached, who decides, what a cached read costs, how long it lasts. Numbers come from the price table, so they are dated and sourced, and every vendor gets the same kind of explanation.

### 5.3 Ledger

The dashboard reads a ledger the agent writes, one record per model call:

```ts
export interface UsageRecord {
  at: string;
  sessionId: string | null;
  turnId: string | null;
  agentId: string;
  parentAgentId: string | null;
  source: "chat" | "quick" | "flow" | "playtest";
  vendor: VendorId;
  model: string;
  route: RouteId;
  /** Fallback in use: the configured model this call stood in for. */
  insteadOf?: ModelRef;
  tokens: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
  durationMs: number;
}
```

Stored as monthly JSONL in the extension's data dir. Today's `TokenUsage` keeps input and output and drops cache reads; the ledger keeps all four. The token-usage work in flight owns the counting; this plan fixes the record shape it writes and coordinates with it. Plan meters come from the routes' own limit messages, kept beside the ledger.

---

## 6. Routes

All under `/v1/ext/studio`. Additive; existing routes keep working for one release (section 7).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/team` | the resolved team, with each agent's origin, per-field source and effective route |
| PUT | `/team` | delegation, bindings, defaults |
| GET | `/agents/:id` | one agent, resolved |
| PUT | `/agents/:id` | `{ layer: "project" or "user" or "local", spec }` |
| POST | `/agents` | create (from blank, a role, or a copy) |
| DELETE | `/agents/:id?layer=` | remove from a layer |
| GET | `/templates` | templates filled for this machine |
| POST | `/team/from-template` | `{ template, layer }` |
| POST | `/team/export` | write files to the project or a folder |
| POST | `/team/import/preview` | diff against the current team |
| POST | `/team/import/apply` | apply all or selected agents |
| GET | `/skills` | library across sources (built on the daemon's `/v1/skills`) |
| GET | `/skills/:id` | body and files |
| POST, PUT, DELETE | `/skills/:id` | user and project skills only |
| POST | `/delegation/try` | which helpers a task would go to, and why |
| GET | `/instructions` | discovered files, sizes, precedence, duplicates |
| PUT | `/instructions` | included files, extra files, order |
| GET | `/instructions/preview?agent=` | the composed text |
| POST | `/instructions/agents-md` | create AGENTS.md |
| GET | `/context` | per agent seed costs and the measurement table |
| GET, PUT | `/context-strategy` | other clients' strategy in ue-mcp.yml |
| GET | `/usage/summary?from&to&groupBy&filter` | aggregates |
| GET | `/usage/records?from&to&agent&session` | raw records |
| GET | `/usage/plans` | plan meters per sign-in |
| GET, PUT | `/budgets` | every budget and the warning threshold |
| GET, PUT | `/prices` | price table and user overrides |
| GET, POST, DELETE | `/endpoints` | custom model endpoints |

Daemon prerequisites, added to ue-mcp as general features first: `GET /v1/skills` with owners; the lean and full projections for a category list; and each action's read and destructive flags, for `ueMcpAccess: "read"` and the destructive-actions approval.

---

## 7. Migration

Runs once when the new agent starts, writes `schema: 2` into settings.json, keeps the old fields for one release so a downgrade still works.

| Old | New |
|-----|-----|
| `provider`, `model`, `effort` | main agent model and effort, local layer |
| `usage.subagents` off / asked / automatic | delegation mode never / on-request / auto |
| `usage.subagentModel`, `usage.subagentEffort` | Worker helper's model and effort (inherit when null) |
| `usage.subagentsPerTurn` | `delegation.maxPerTurn`; `maxParallel` = min(that, 8) |
| `usage.projectInstructions` true / false | instruction files: the CLAUDE.md files included / none |
| `usage.imageSize` | team default image size |
| `usage.turnTokenLimit` | main agent's `perRunTokens` in Budgets |
| playtest runs | Approvals: Starting playtests, Manual or Automatic |
| playtest budget | Playtest runner's `perRunMinutes`, `perRunTokens`; bound to assigned playtests |
| everything else | unchanged, moved in the UI only |

The team migration creates is "Lead and workers" when subagents were on, "Solo" when off, so behaviour is unchanged on day one. `PUT /settings` keeps accepting the old fields for one release and maps them.

---

## 8. Phasing

Each phase ships on its own and leaves Studio coherent.

1. **Settings layout.** The seven sections, every card moved, approvals split into rows, Instructions with every convention (still one agent), context strategy for other clients outside the editor, shared badges. Usage > Budgets ships here as the one place budgets are edited, with today's two limits as its first rows (the main agent's per-turn tokens, the assigned-playtest budget); agent rows join it in phase 2. Today's counter (`apps/agent/src/usage.ts`) already matches the budget definition on each route: for Messages responses it adds cache writes to input and leaves cached reads out, and for OpenAI responses it subtracts the cached part from the prompt. Phase 1 needs no new counting.
2. **Agents, any vendor.** Team model, files and layers, main and helpers on any vendor and route, shared context and fresh start on both loops, the relay tool on the SDK route, compatibility strip, fallbacks, Worker, templates, delegation, bindings, per-agent tool scope. Migration runs here.
3. **Usage ledger and dashboard.** Four token kinds, plan meters, price table, per-day budgets and warnings. Depends on the token-usage work's counting.
4. **Skills.** Library across four sources, preload and on demand on both routes, plugin skills grouped by plugin. Needs the daemon's skills listing.
5. **Context strategy for Studio's agents.** Lean and Full, Auto from measured data. Needs the daemon's projections and the measurement file.
6. **Export and import, custom endpoints.**

---

## 9. Settled decisions

1. **Project team files live in `.ue-mcp/studio/`**, beside ue-mcp's own project state and out of ue-mcp.yml, which ue-mcp owns and every client reads.
2. **Project skills are read from `.claude/skills/` and `.agents/skills/`, and written to `.claude/skills/`**, the folder ue-mcp and its plugins already install into. A vendor-neutral alias is proposed to ue-mcp as its own change.
3. **Helpers do not hand work to other helpers** (2.9). Delegation is one level deep.
4. **Sign-in routes show no currency by default**, only plan meters and tokens. A key-equivalent cost column is opt-in.
5. **Prices ship with Studio** as a dated, sourced table the user can edit. Studio never fetches prices live.
6. **Approvals are global.** Per-agent tool scope already removes what an agent may not use.
7. **Context strategy defaults to Micro**, today's behaviour. Auto stays hidden until the measurement file ships.
8. **The chat's model picker changes the current session only**, with a Make default action.
9. **A teammate who lacks an agent's vendor gets that agent's fallbacks**, then the main agent's model, with a warning on the agent and in Usage.
10. **Budgets are per machine.** Spend depends on each person's plan and keys; a team that wants a norm writes it in AGENTS.md.
11. **Playtest runs is proposed to ue-mcp as a shared mode**, like dialogs and feedback, so other clients follow it. Until ue-mcp has it, the setting stays Studio's own and carries no shared badge.
