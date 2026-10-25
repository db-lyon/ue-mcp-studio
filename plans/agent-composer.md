# Agent composer and settings, next version

Status: proposal for review. Nothing here is built. The interactive mockup that goes with it covers every screen named below.

## Why

Settings grew one card at a time, and it shows:

- **Settings > Agent is not about the agent.** It holds the approval toggle, a Usage card, per-turn review, editor dialogs, playtests and ue-mcp's feedback tool. Half of those are ue-mcp project settings that apply to every client, not to Studio's agent.
- **Usage assumes one vendor.** The card offers "Give the agent the project's CLAUDE.md", the subagent model is limited to the main model's vendor, and the subagent limit message points at "Settings > Agent > Usage". Nothing is wrong with Claude; the problem is that nothing else is first class.
- **Usage is a settings card, not usage.** It sets limits but never shows what was spent, by whom, or over what time.
- **Subagents are one anonymous worker.** Off, when asked, or automatic, on one model and one effort. There are no named helpers, no personas, no skills, no per-helper tools or budgets.
- **Context strategy is buried.** micro, lean and full are in Project > Project setup, only inside the editor, labelled "for other clients", and applied by re-running init. Studio's own agent has no choice at all: it always uses one fixed gateway tool.

This plan replaces that with a settings layout grouped by what the user is deciding, a provider-agnostic agent composer, one view of project instructions across file conventions, context strategy in plain sight, and a usage dashboard.

## Decisions at a glance

1. Settings has eight sections: **Agents, Models & accounts, Approvals & review, Playtests, Project, Usage, General, Diagnostics.** Every existing setting has one home (table below).
2. An **agent** is a named spec: instructions, model (any vendor, any route), effort, tool scope, tool surface, skills, instruction files, budget. The main agent is one of them. Helpers are the rest.
3. **Skills** are SKILL.md folders, the format ue-mcp and its plugins already ship. Studio reads four sources (built in, user, project, plugin) and shows the owner of each. Attaching a skill to an agent either preloads it or offers it on demand.
4. **Delegation** replaces off / when asked / automatic with a per-helper hand-off rule plus team limits, and a "who handles what" table for the entry points that start agents (chat, quick ask, flow steps, assigned playtests).
5. **Templates** seed the composer. A new user picks one of five and gets a working team, never a blank page.
6. Teams are **files**. Project agents live in `.ue-mcp/studio/agents/*.md` and are checked in. Export writes the same files; import shows a diff before it applies.
7. **Mixed vendors work.** On the Claude sign-in, Claude helpers become native SDK subagents and other helpers are relayed through a Studio tool. On Studio's own loop every helper runs on its own provider. Where behaviour differs, the agent editor says so in a compatibility strip, not in a footnote.
8. **Project instructions** are read from every common convention, shown as one list with sizes and precedence, and injected by Studio the same way on every route. AGENTS.md is the file Studio creates.
9. **Context strategy** for external clients moves to Project and works outside the editor. Studio's own agent gets a **tool surface** choice per agent (Gateway, Categories, Full signatures, Auto), priced from measured data.
10. **Usage** is a dashboard in neutral units: four token kinds, an estimated cost only where a price exists, plan routes shown as plan usage, and each vendor's caching explained in the same terms.

---

## 1. Information architecture

### 1.1 Inventory of today's settings

| # | Setting | Today's place | Stored in |
|---|---------|---------------|-----------|
| 1 | Updates (check, install, channel) | General | daemon |
| 2 | Theme (ue-mcp, Editor orange, Editor) | General > Appearance | settings.json `theme` |
| 3 | Model and vendor | General > Model, chat composer picker | settings.json `provider`, `model` |
| 4 | Effort | General > Model, chat composer | settings.json `effort` |
| 5 | Sign-ins (ChatGPT, Claude via Claude Code login, Studio plan hidden) | General > Sign-ins | sign-in stores |
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
| 18 | Who answers editor dialogs (dialog mode) | Agent > Editor dialogs | ue-mcp modes |
| 19 | Dialog policy (wait, agent after N min, safe default after N min) | Agent > Editor dialogs | settings.json `dialogPolicy` |
| 20 | Playtest runs (manual, automatic) | Agent > Playtests | playtest store |
| 21 | Assign to subagent budget (minutes, tokens) | Agent > Playtests | playtest store |
| 22 | Feedback tool on or off | Agent > Feedback | ue-mcp.yml `disable` |
| 23 | Feedback mode (ask, file, keep) | Agent > Feedback | ue-mcp modes |
| 24 | Account, plan, period usage | Account (hidden) | gateway |
| 25 | Install status, bridge plugin facts | Project | daemon |
| 26 | MCP clients configured | Project | daemon |
| 27 | Project setup: other clients, native Unreal tools, context strategy, skills for external clients | Project (editor only) | `ue-mcp init` |
| 28 | ue-mcp.yml text editor | Project | ue-mcp.yml |
| 29 | Status and logs | Diagnostics | daemon |
| 30 | Composer height | dragged divider | settings.json `composerHeight` |

### 1.2 Testing the proposed grouping

The starting proposal was Models & accounts, Agents, Safety, Review, Playtests, Project, Usage. Changes after testing it against the inventory:

- **Safety and Review merge into "Approvals & review".** Review alone is one toggle; a section for one toggle is noise. Both answer the same question, how much the user oversees the agent, one before it acts and one after. The page has two groups with those names.
- **General and Diagnostics stay.** Theme and updates are about Studio, not agents or the project. Status and logs need a home that is not Project.
- **Project instructions belong to Agents, not Project.** They are files in the project, but the decision the user makes is what agents read. Project keeps what applies to every MCP client.
- **Feedback goes to Project.** It is ue-mcp behaviour stored in ue-mcp.yml and ue-mcp's modes, shared by every client.
- **Usage is a page in Settings, reachable from the chat.** The per-turn usage line and a spend chip in the top bar link to it. A fifth top tab was considered and rejected: on a phone the drawer already holds the tabs and recent sessions, and Usage is visited, not lived in.

### 1.3 The eight sections

Desktop: a left rail with the eight sections, grouped under two quiet labels (Work: Agents, Models & accounts, Approvals & review, Playtests; Project and Studio: Project, Usage, General, Diagnostics). Phone: Settings opens on that list; a section opens full width with a back button. The rail shows a status dot where something needs attention (a helper whose vendor is not connected, a budget at 80 percent, an update).

| Section | Holds |
|---------|-------|
| **Agents** | Team (main and helpers), agent editor, Skills, Delegation, Instructions, Tool surface. Templates, import and export. |
| **Models & accounts** | Sign-ins, API keys, route preference, the full model catalog with what runs each model, Studio gateway URL under Advanced, Studio account when offered. |
| **Approvals & review** | Before it acts: approvals for commands, file changes and editor restarts; editor dialogs. After it acts: per-turn review default. |
| **Playtests** | Playtest runs, which agent runs assigned playtests, that agent's budget. |
| **Project** | Install, bridge plugin, MCP clients, context strategy for external clients, native Unreal tools, skills installed for external clients, feedback tool and mode, ue-mcp.yml editor under Advanced. |
| **Usage** | The dashboard: spend over time, per agent, per session, per model and route; budgets; warnings; comparisons; how each vendor caches. |
| **General** | Appearance, Updates. |
| **Diagnostics** | Editor and daemon status, logs. |

### 1.4 Where every existing setting goes

| # | Setting | New home | Change |
|---|---------|----------|--------|
| 1 | Updates | General | none |
| 2 | Theme | General > Appearance | none |
| 3, 4 | Model, effort | Agents > main agent | becomes the main agent's model and effort; the chat picker sets it for the session, with "Make default" |
| 5 | Sign-ins | Models & accounts | none |
| 6 | Gateway URL | Models & accounts > Advanced | none |
| 7 | API keys | Models & accounts | none |
| 8 | Ask before commands and files | Approvals & review | split into three rows: shell commands, file changes, editor restarts |
| 9 | Subagents mode | Agents > Delegation | becomes the main agent's delegation mode |
| 10, 11 | Subagent model, effort | Agents > Worker helper | any vendor, not only the main model's |
| 12 | Subagents per turn | Agents > Delegation | team limit, plus a parallel limit |
| 13 | CLAUDE.md toggle | Agents > Instructions | every convention, per file, per agent |
| 14 | Image size | Agents > agent editor | per agent, team default |
| 15 | Turn token limit | Agents > agent editor > Budget, Usage > Budgets | per agent; team daily and monthly budgets added |
| 16 | Review each turn | Approvals & review | none |
| 17 | Per-session review | session Checkpoints panel | none |
| 18, 19 | Dialog mode and policy | Approvals & review > Editor dialogs | none |
| 20 | Playtest runs | Playtests | none |
| 21 | Assign to subagent budget | Playtests | becomes the Playtest runner agent's budget, edited here or in its agent editor |
| 22, 23 | Feedback tool and mode | Project > Feedback | none |
| 24 | Account | Models & accounts > Studio account | its usage feeds the Usage dashboard |
| 25 to 28 | Install, bridge, clients, setup, ue-mcp.yml | Project | context strategy and skills move out of the editor-only setup form and work from any browser |
| 29 | Status, logs | Diagnostics | none |
| 30 | Composer height | stays UI state | none |

---

## 2. The agent composer

### 2.1 Concepts

- **Agent.** A named spec. Exactly one is the main agent of a team; the main agent is what a new chat talks to.
- **Helper.** Any other agent. The main agent hands it work through delegation. Helpers do not delegate further (decision 2.9).
- **Skill.** A SKILL.md folder: a name, a description saying when to use it, a body, optional supporting files, optional tool scope.
- **Team.** The set of agents in effect for a project, resolved from layers.
- **Template.** A team that ships with Studio, used to start one.

### 2.2 Data model

All types live in `packages/shared`.

```ts
/** A vendor in the catalog. Open-ended: the catalog adds vendors without a type change. */
export type VendorId = string; // "anthropic", "openai", "google" and any vendor the catalog adds

/** How a model is reached: a sign-in or the vendor key. Matches today's ModelRoute values. */
export type RouteId = SignInId | "key";

export interface ModelRef {
  vendor: VendorId;
  model: string;
  /** auto: the first connected route in the user's route preference. Never written to shared files. */
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

/** How ue-mcp's actions are presented to this agent. See section 4.2. */
export type ToolSurface = "gateway" | "categories" | "full" | "auto";

export interface AgentBudget {
  /** One run of this agent: a main agent's turn, or one helper hand-off. null for none. */
  perRunTokens: number | null;
  perRunMinutes: number | null;
  /** Rolling, across sessions, for this agent on this machine. */
  perDayTokens: number | null;
  /** What happens at a limit. */
  onLimit: "stop-and-report" | "ask" | "fallback-model";
}

export interface SkillAttachment {
  skill: string;              // skill id, e.g. "ue-mcp-blueprint" or "ue-mcp-meshy:meshy-import"
  load: "preload" | "on-demand";
}

export interface AgentSpec {
  id: string;                 // slug; unique in the team
  name: string;
  /** When to hand work to this agent. The main agent reads it to decide. */
  description: string;
  /** Persona and standing instructions, markdown. */
  instructions: string;
  model: ModelRef | "inherit";
  /** Tried in order when the model is not reachable on this machine. */
  fallbacks: ModelRef[];
  effort: Effort | "inherit";
  tools: ToolScope;
  toolSurface: ToolSurface | "inherit";
  skills: SkillAttachment[];
  /** Which project instruction files this agent reads. */
  instructionFiles: "all" | "none" | { only: string[] };
  imageSize: ImageSize | "inherit";
  /** Model calls before the agent must report; maps to the SDK's maxTurns. */
  maxSteps: number | null;
  budget: AgentBudget;
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
  /** named: only when the user names this helper. judged: when the main agent judges the description fits. always: every match of `matches`. */
  when: "named" | "judged" | "always";
  /** For always: short task patterns, e.g. ["material", "niagara"]. */
  matches?: string[];
  /** Run beside the main agent without blocking its turn. */
  background: boolean;
}

export interface DelegationPolicy {
  /** never: no helpers. on-request: only helpers the user names. auto: helpers' rules apply. */
  mode: "never" | "on-request" | "auto";
  maxPerTurn: number;         // 1 to 16, today's subagentsPerTurn
  maxParallel: number;        // 1 to 8
  /** What a helper starts with besides the brief. */
  context: "brief" | "brief-and-files";
}

/** Entry points that start an agent, and which agent each starts. */
export interface Bindings {
  chat: string;               // agent id; the main agent
  quickAsk: string;
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
  defaults: { toolSurface: ToolSurface; imageSize: ImageSize; effort: Effort };
}

export interface SkillSpec {
  id: string;                 // dir name; plugin skills are "<package-prefix>:<name>"
  name: string;
  description: string;
  body: string;
  files: string[];            // supporting files beside SKILL.md
  /** Optional narrowing: an agent using this skill gets at most this. */
  tools?: Partial<ToolScope>;
  source:
    | { kind: "builtin"; owner: "studio" | "ue-mcp"; version: string }
    | { kind: "user"; path: string }
    | { kind: "project"; path: string }
    | { kind: "plugin"; package: string; version: string; path: string };
  /** Approximate tokens of the body, for the preload cost shown in the UI. */
  tokens: number;
}
```

### 2.3 Files and layers

A team resolves from four layers, later wins per agent id and per field:

1. **Template** that seeded the team (read only, ships with Studio).
2. **User**: `~/.ue-mcp/studio/agents/<id>.md`. The user's own helpers, available in every project.
3. **Project**: `<project>/.ue-mcp/studio/agents/<id>.md` and `<project>/.ue-mcp/studio/team.yml`. Checked in. This is how a team shares a setup.
4. **Local**: the extension's per-project data dir. This machine's overrides (a teammate without a Google key pins the Level dresser to another model) and every route choice. Never checked in.

An agent file is markdown with YAML frontmatter, the same shape as a skill, so it reads well in review:

```markdown
---
name: Level dresser
description: Places and arranges props, foliage and lights in a level from a brief or a reference screenshot.
model: { vendor: google, model: gemini-3.1-pro-preview }
fallbacks: [{ vendor: anthropic, model: claude-sonnet-5-5 }]
effort: medium
tools: { ueMcp: { only: [level, asset, foliage, pcg] }, ueMcpAccess: read-write, shell: false, files: read, web: { search: false, fetch: false }, editorRestart: false }
toolSurface: auto
skills: [{ skill: hollowreach-naming, load: preload }]
budget: { perRunTokens: 400000, perRunMinutes: 20, perDayTokens: null, onLimit: stop-and-report }
handoff: { when: judged, background: false }
---
You dress levels for Hollowreach. Keep sight lines to the objective clear, and match prop density to the zone brief.
```

Shared files never carry a route, a key or an account. The UI marks every field that came from a project file and shows "Override on this machine" beside it.

### 2.4 Skills

Sources, in the library's filter order:

| Source | Where | Owner shown |
|--------|-------|-------------|
| Built in | Studio's own (shipped in the extension) and ue-mcp's packaged skills | Studio, ue-mcp |
| Plugin | Installed by `ue-mcp plugin install` into the project skills folder, owner from `.ue-mcp/skills.json` | the plugin package and version |
| Project | `<project>/.claude/skills/<name>/SKILL.md` not owned by a plugin | Project, with the path |
| User | `~/.ue-mcp/studio/skills/<name>/SKILL.md` | You |

Plugin skills are first class: the library groups them under their plugin, shows the version, and updates or removes them with the plugin. Studio never edits a plugin's skill; "Customize" copies it to a project or user skill with a new name.

Studio reads the list from the daemon, not from ue-mcp's files: a general `GET /v1/skills` listing on the daemon, with owners, is a prerequisite and goes into ue-mcp first.

Attaching:

- **Preload** puts the body in the agent's instructions. Cost is paid every turn; the UI shows it in tokens.
- **On demand** lists the name and description; the agent loads the body when it needs it. On the SDK route that is the SDK's skill tool; on Studio's loop a `skill` tool with the same contract.
- A skill with a tool scope narrows the agent while the skill is in use; it never widens it. The UI shows a skill whose scope the agent lacks as "needs shell" and greys the attach button.

### 2.5 Delegation

The Delegation tab has three parts:

1. **Mode** for the main agent: Never, Only when I name a helper, or Automatic. Automatic applies each helper's hand-off rule.
2. **Hand-off rules**, one row per helper: when (only when named, when it fits the description, always for matching work), background or not, and a "Test" box: type a task, see which helper the rules would pick and why.
3. **Limits**: helpers per turn, helpers at the same time, and what a helper starts with (the brief, or the brief plus the files the main agent read).

Below that, **Who handles what** binds the entry points: Chat, Quick ask in the editor, Flow agent steps, Assigned playtests. Today all four use the one selected model; after this each names an agent.

Today's anonymous worker becomes a real helper called **Worker**: same model as the main agent, every tool the main agent has, hand-off "when the work splits". Users can rename, retarget or delete it.

### 2.6 Templates

Shown on first open of Agents and on "New team". Each card names its agents, the vendors it needs, and a rough cost class (relative, from the measured tool-surface data and model prices).

| Template | Agents | Why pick it |
|----------|--------|-------------|
| Solo | Main | One agent does everything. Lowest overhead. Today's behaviour with helpers off. |
| Lead and workers | Main, Worker | Today's automatic mode, made explicit. |
| Specialists | Main, Blueprint smith, Level dresser, Material artist, Playtest runner | Narrow tools and skills per helper; cheaper per hand-off. |
| Thrifty | Main on a large model; helpers on small models at low effort | Spend control. |
| Reviewer pair | Main, Reviewer (read-only, different vendor) | A second model checks the first's changes before the turn ends. |

Each template fills models from what the user has connected. A template that needs a vendor the user has not connected says so on the card and offers the connected substitute.

### 2.7 Export and import

- **Export** writes the team as files: `team.yml` plus `agents/*.md`, and project skills it uses. Into the project (the default, ready to commit) or into a folder the user picks.
- **Import** reads a folder or a project's files, then shows a review: agents added, changed (field-level diff), removed; skills referenced but missing; vendors not connected on this machine with the fallback that will be used. Apply, or apply selected agents.
- Teams never travel with secrets or routes.

### 2.8 Routes: how one spec runs everywhere

Three cases.

**A. Main agent on the Claude sign-in (Agent SDK).**

| Spec field | SDK option |
|------------|------------|
| instructions + instruction files + preloaded skills | `systemPrompt` (Studio composes it; `settingSources` stays `[]`, so the SDK reads no file on its own) |
| model, effort | `model`, `effort` |
| tools | `allowedTools` over Studio's in-process tools (`mcp__studio__*`), plus the SDK's web search when `web.search` |
| on-demand skills | `plugins: [{ type: "local", path }]` pointing at a folder Studio generates with the attached skills, and `skills` naming them |
| helpers on a Claude model | `agents: { [id]: { description, prompt, model, effort, tools, skills, maxTurns, background } }` |
| helpers on another vendor | one Studio tool, `delegate(helper, brief)`, in the in-process server; Studio runs the helper on its own loop and returns the report |
| per-turn and parallel limits | the PreToolUse hook Studio already uses for the subagent limit, applied to both `Agent` and `delegate` |
| budgets | Studio's token counter on each message, as today; at a limit Studio stops the task (`stopTask`) or the turn |

**B. Main agent on Studio's loop** (an API key, ChatGPT, the Studio plan). Every agent, main or helper, runs on Studio's loop with its own provider. The `agent` tool takes a `helper` argument listing the helpers. A helper on the Claude sign-in runs as its own SDK conversation, the path assigned playtests already use.

**C. Mixed vendors.** Covered by A and B: any helper can be on any vendor. What differs, and how the UI says so:

| Behaviour | Same-vendor helper on the SDK | Relayed or Studio-loop helper | Shown as |
|-----------|-------------------------------|-------------------------------|----------|
| Starts from | the SDK's subagent context | a fresh conversation with the brief | "Starts fresh" chip on the hand-off edge |
| Prompt cache | shared prefix with the main agent where the vendor allows | none across vendors | Usage shows cache share per agent |
| Background run | yes | yes within the turn; ends with the turn | "Ends with the turn" in the compatibility strip |
| Effort | as set | nearest level the vendor has (High for Extra high on Gemini) | effort picker shows the level that will be sent |
| Web search | vendor-run search | vendor-run where the vendor has it, else fetch only | tool row says "Search: vendor-run" or "Fetch only" |
| Skills | SDK skill tool | Studio's `skill` tool | none: same contract |
| Survives a daemon restart | no, the turn ends | yes, resumes | compatibility strip |

The agent editor has a **compatibility strip** under the model picker: one line per behaviour that differs from the main agent's route, nothing when nothing differs. The delegation diagram draws relayed hand-offs with a dashed edge and the label "relayed by Studio".

### 2.9 Decisions inside the composer

- Helpers cannot delegate. One level keeps cost and transcripts readable and matches the SDK.
- Approvals stay global (Approvals & review), not per agent. Tool scope per agent decides what exists; approvals decide what asks. One mental model.
- The chat's model picker changes the main agent for the session. A "Make default" link writes it to the main agent.

---

## 3. Project instructions

### 3.1 Files read

In this order, each when present:

| Order | File | Notes |
|-------|------|-------|
| 1 | Studio user instructions (`~/.ue-mcp/studio/instructions.md`) | the user's own, every project |
| 2 | `AGENTS.md` | the vendor-neutral convention; the file Studio creates |
| 3 | `CLAUDE.md`, `.claude/CLAUDE.md` | `@path` imports followed, one level |
| 4 | `GEMINI.md` | |
| 5 | `.github/copilot-instructions.md` | |
| 6 | `.cursor/rules/*.mdc`, `.cursorrules` | frontmatter `globs` honoured: a rule with globs is listed as "applies to matching files" and included only when the turn touches one |
| 7 | `AGENTS.local.md`, `CLAUDE.local.md` | per-machine, usually git-ignored |

Nested files (a `AGENTS.md` in `Source/Hollowreach/`) are listed under their folder and included when the agent works in that folder.

### 3.2 Precedence and duplicates

- Later in the list wins on conflict, and the composed prompt says so in one line. Local files last, so a person can override the team.
- Files with the same content, or a file that only imports another (`CLAUDE.md` containing `@AGENTS.md`), are included once and shown as "same as AGENTS.md".
- Studio injects the result itself on every route. The SDK's own file loading stays off, so a Claude main agent and a Gemini helper read the same text.

### 3.3 What the user sees

Agents > Instructions: one row per file with its path, size in tokens, last change, the agents that read it, and a toggle. A preview pane shows the composed result for a chosen agent, in order, with each file's heading. "Create AGENTS.md" when there is none, prefilled from the existing files. Each agent's editor has "Instruction files: all, none, or chosen".

---

## 4. Context strategy

### 4.1 External clients (ue-mcp's micro, lean, full)

Project > Context strategy for other clients:

- Three options with their measured seed cost from ue-mcp's docs (micro ~2.2k tokens, lean ~19k, full ~51k), what each advertises, and the discovery round-trips each costs.
- The clients it affects (from the install report), and "Restart those clients to apply".
- An "overridden by `UE_MCP_CONTEXT_STRATEGY`" notice when the environment sets it.
- Writes `context.strategy` in ue-mcp.yml through the daemon, so it works in a browser too. Studio already edits ue-mcp.yml keys this way for the feedback tool.

### 4.2 Studio's own agent: tool surface

Studio today gives its agent one `ue_mcp` tool with search, describe and call. That stays, as one of four choices per agent (team default in Agents > Tool surface):

| Surface | What the agent sees | Like |
|---------|---------------------|------|
| Gateway | one ue-mcp tool: search, describe, call (today) | micro |
| Categories | one tool per category in scope, action names listed, signatures on demand | lean |
| Full signatures | one tool per category in scope, every signature inline | full |
| Auto | picks per agent from its scope and the measured data | |

Scope changes the price. Full signatures for a helper scoped to two categories cost a fraction of full for all 29. The tool surface page shows, for each agent, the seed cost of each surface at its scope, computed from ue-mcp's projections, not guessed.

Building Categories and Full needs the daemon to hand Studio ue-mcp's lean and full projections for a category list. That is a general daemon feature and lands in ue-mcp first.

**Taking the measurement results.** The page reads a data file shipped with Studio, `tool-surface-costs.json`:

```ts
export interface ToolSurfaceMeasurement {
  measuredAt: string;
  studioVersion: string;
  ueMcpVersion: string;
  model: ModelRef;
  surfaces: Array<{
    surface: Exclude<ToolSurface, "auto">;
    scope: "all" | string[];
    seedTokens: number;
    tasks: Array<{ id: string; totalTokens: number; modelCalls: number; discoveryCalls: number; passed: boolean }>;
  }>;
}
```

The page shows seed cost, median tokens per task, discovery calls per task and pass rate per surface, with "Measured on <date> with <model>". Auto's rule is derived from the data (proposed: Full signatures at three or fewer categories, Gateway otherwise) and printed on the page. Until a measurement ships, Auto is hidden and the default stays Gateway, today's behaviour.

---

## 5. Usage dashboard

### 5.1 Units

- **Tokens, in four kinds:** input, cached input read, cache write, output. Every vendor reports some subset; a kind a vendor does not report shows as "not reported", not zero.
- **Estimated cost** only for routes billed per token (API keys). From a price table that ships with Studio, dated, with a source link per vendor, and editable by the user.
- **Plan usage** for sign-in routes (Claude sign-in, ChatGPT, Studio plan). These are not priced per token, so the dashboard shows tokens and whatever limit signal the route reports (a rate-limit notice, a plan percentage). An opt-in "key-equivalent cost" column says what the same tokens would cost on a key, labelled as hypothetical.

### 5.2 Views

- **Header:** period (today, 7 days, 30 days, custom), filter by agent, vendor, route, source (chat, quick ask, flows, playtests).
- **Summary tiles:** tokens, estimated cost on keys, plan usage, cache read share, turns.
- **Over time:** stacked bars by agent (or model, or vendor), with daily budget line.
- **By agent:** tokens, cost, share, median tokens per run, cache share, budget status.
- **By session:** title, agents used, tokens, cost, link to the session.
- **Compare:** two agents, two models or two periods side by side on tokens per run, cost per run, cache share and pass rate where a playtest decides it.
- **Budgets:** per agent (from each agent's budget) and team (per day, per month), warning threshold, what happens at the limit.
- **Warnings:** budgets at the threshold, an agent whose cache share fell, a helper on a fallback model, a route that reported a limit.
- **How caching works**, one card per connected vendor, same four headings each: what is cached, who decides, what a read costs, how long it lasts. Text and numbers come from the price table, so they are dated and sourced, and no vendor gets a different kind of explanation.

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
  tokens: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
  durationMs: number;
}
```

Stored as monthly JSONL in the extension's data dir. Today's `TokenUsage` keeps input and output and drops cache reads; the ledger keeps all four. The token-usage work in flight owns the counting; this plan only fixes the record shape it writes and coordinates with it.

---

## 6. Routes

All under `/v1/ext/studio`. Additive; existing routes keep working for one release (section 7).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/team` | the resolved team, with each agent's origin and per-field source |
| PUT | `/team` | delegation, bindings, defaults |
| GET | `/agents/:id` | one agent, resolved |
| PUT | `/agents/:id` | `{ layer: "project" or "user" or "local", spec }` |
| POST | `/agents` | create (from blank, a template agent, or a copy) |
| DELETE | `/agents/:id?layer=` | remove from a layer |
| GET | `/templates` | templates with what each needs |
| POST | `/team/from-template` | seed a team |
| POST | `/team/export` | write files to the project or a folder |
| POST | `/team/import/preview` | diff against the current team |
| POST | `/team/import/apply` | apply all or selected agents |
| GET | `/skills` | library across sources (built on the daemon's `/v1/skills`) |
| GET | `/skills/:id` | body and files |
| POST, PUT, DELETE | `/skills/:id` | user and project skills only |
| POST | `/delegation/test` | which helper a task would go to, and why |
| GET | `/instructions` | discovered files, sizes, precedence, duplicates |
| PUT | `/instructions` | included files |
| GET | `/instructions/preview?agent=` | the composed text |
| POST | `/instructions/agents-md` | create AGENTS.md |
| GET | `/tool-surface` | per agent seed costs and the measurement |
| GET, PUT | `/context-strategy` | external clients' strategy in ue-mcp.yml |
| GET | `/usage/summary?from&to&groupBy&filter` | aggregates |
| GET | `/usage/records?from&to&agent&session` | raw records |
| GET, PUT | `/budgets` | team budgets and warning threshold |
| GET, PUT | `/prices` | price table and user overrides |

Daemon prerequisites, added to ue-mcp as general features first: `GET /v1/skills` with owners, and the lean and full surface projections for a category list.

---

## 7. Migration

Runs once when the new agent starts, writes `schema: 2` into settings.json, keeps the old fields for one release so a downgrade still works.

| Old | New |
|-----|-----|
| `provider`, `model`, `effort` | main agent model and effort, local layer |
| `usage.subagents` off / asked / automatic | delegation mode never / on-request / auto |
| `usage.subagentModel`, `usage.subagentEffort` | Worker helper's model and effort (inherit when null) |
| `usage.subagentsPerTurn` | `delegation.maxPerTurn`; `maxParallel` set to the same |
| `usage.projectInstructions` true / false | instruction files: the CLAUDE.md files included / none |
| `usage.imageSize` | team default image size |
| `usage.turnTokenLimit` | main agent `budget.perRunTokens` |
| playtest budget | Playtest runner agent `perRunMinutes`, `perRunTokens`; bound to assigned playtests |
| everything else | unchanged, moved in the UI only |

The team created by migration is "Lead and workers" when subagents were on, "Solo" when off, so behaviour is unchanged on day one. `PUT /settings` keeps accepting the old fields for one release and maps them.

---

## 8. Phasing

Each phase ships on its own and leaves Studio coherent.

1. **Settings layout.** The eight sections, every card moved, approvals split into three rows, Instructions with every convention (still one agent), context strategy for external clients outside the editor. No new behaviour beyond those.
2. **Usage ledger and dashboard.** Four token kinds, price table, budgets per team, warnings. Depends on the token-usage work's counting.
3. **Agents, one vendor.** Team model, files and layers, main and helpers on the main agent's vendor, Worker, templates, delegation policy, bindings, per-agent tool scope and budgets. Migration runs here.
4. **Skills.** Library across four sources, preload and on demand on both routes, plugin skills grouped by plugin. Needs the daemon's skills listing.
5. **Mixed vendors.** Any helper on any vendor, relay tool on the SDK route, compatibility strip, fallbacks.
6. **Tool surface.** Categories and Full signatures for Studio's agent, Auto from measured data. Needs the daemon's projections and the measurement file.
7. **Export and import.** Folder export, import preview and apply.

---

## 9. Open questions

Each has a recommendation; the reviewer decides.

1. **Where project team files live.** Options: `.ue-mcp/studio/`, keys in ue-mcp.yml, a top-level folder. **Recommend `.ue-mcp/studio/`**: beside ue-mcp's own project state, out of ue-mcp.yml (which ue-mcp owns and every client reads).
2. **Project skills folder.** ue-mcp and plugins install into `.claude/skills/`. A vendor-neutral `.agents/skills/` would read better. **Recommend reading both and writing to `.claude/skills/`** for now, so there is one place ue-mcp, plugins and Studio agree on; propose a neutral alias to ue-mcp separately.
3. **Should helpers delegate?** **Recommend no** (decision 2.9). Revisit if a template needs it.
4. **Currency for sign-in routes.** **Recommend no currency by default**, tokens and plan signals only, with the opt-in key-equivalent column.
5. **Price table source.** **Recommend shipped with Studio, dated, sourced, user-editable.** No live price fetch.
6. **Per-agent approvals.** **Recommend global only** for now; per-agent scope already removes tools.
7. **Tool surface default before measurement.** **Recommend Gateway** (today's), Auto hidden until data ships.
8. **What the chat picker changes.** **Recommend the session only**, with "Make default".
9. **A teammate lacks a vendor.** **Recommend fallbacks in the agent file**, then the main agent's model, with a warning chip on the agent and in Usage.
10. **Team per project or per user.** **Recommend per project**, with user helpers available to add to any project's team.
