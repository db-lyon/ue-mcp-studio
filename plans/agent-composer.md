# Agents and settings

Status: the plan in force. Phases 1 to 5 are built (section 8); the Usage section, its ledger, budgets, prices and plan meters were removed afterwards (section 4); phase 4's measurement for Auto waits on an editor run (section 10). Every decision is settled; there are no open questions.

## Why

Settings grew one card at a time, and it shows:

- **Settings > Agent was not about the agent.** It held the approval toggle, a Usage card, per-turn review, editor dialogs, playtests and ue-mcp's feedback tool. Several of those are ue-mcp project settings that every MCP client shares.
- **The agent settings assumed one vendor.** "Give the agent the project's CLAUDE.md", subagent models limited to the main model's vendor. Nothing is wrong with Claude; the problem was that nothing else was first class.
- **Studio invented its own agent settings** (subagent mode, model, effort) while every vendor already has project files for exactly this: instructions, subagents and skills that people write once and every tool of that vendor reads.
- **Context strategy was buried** in an editor-only form, and Studio's own agent had no choice at all.

## Scope

Every route (the Claude sign-in, the ChatGPT sign-in, any API key, any custom endpoint) works the same way. Studio has no agent or skill editor. A project configures its agents with each vendor's own files, written for that vendor's own tools, and Studio honours them exactly as those tools do. Studio shows, read only, what it loaded on each route, and keeps its safety controls: approvals, image size, and the context strategy for Studio's own agent.

## Decisions at a glance

1. Settings has six sections: **General, Agents, Models & accounts, Approvals & review, Project, Diagnostics**, grouped by the decision being made. A value ue-mcp stores for every MCP client carries a "Shared with other clients" badge. (Built in phase 1.)
2. **Each route reads its vendor's own files.** A model's vendor picks the convention: Anthropic models read what Claude Code reads, OpenAI models what Codex reads, Gemini models what Gemini CLI reads, and a custom endpoint reads AGENTS.md and the vendor-neutral `.agents/skills/`. Studio invents no file format and writes none.
3. **The Claude sign-in loads them natively.** The Agent SDK runs with the same setting sources as Claude Code (user, project, local). Studio's own tools keep working beside them, and every call still goes through Studio's executor, approvals and transcript.
4. **Studio's own loop reads them the way each vendor's tool does**: instruction files in that tool's order, subagents as helpers of Studio's agent tool, skills through a skill tool with the same contract.
5. **Agents in Settings is read only**: for each convention, the instruction files, subagents and skills found, with source path, size in tokens and Open file, and a sentence on which files that vendor's tools read.
6. **The built-in editor worker stays**, Studio's own helper for work that splits, with sensible defaults. The subagent mode, model and effort controls leave the UI; earlier values keep working. The helpers-per-turn cap keeps its stored value and has no control.
7. **Safety stays in one place**: Approvals & review, per kind.
8. **Context strategy uses ue-mcp's names everywhere: Micro, Lean, Full.** Project sets it for other clients; Studio's own agent has its own choice plus Auto, which stays hidden until measurements ship.
9. **Token use shows only in the chat's thread list**: each agent's input and output tokens for the session, beside its row.

---

## 1. Information architecture (built, phase 1)

**The rule: a section groups settings by the decision the user is making, never by where the value is stored.** The shared badge, not the section, says the blast radius.

| Section | Holds |
|---------|-------|
| **Agents** | The main agent's model and effort, screenshot size, the "Read the project's own files" switch, and the read-only view of what each route loads (instructions, subagents, skills), with the built-in editor worker. |
| **Models & accounts** | Sign-ins, API keys, custom endpoints, route order, the model catalog with every route that runs each model. |
| **Approvals & review** | Before it acts: shell commands, file changes, editor restarts, destructive ue-mcp actions, starting playtests, feedback reports, editor dialogs. After it acts: per-turn review. |
| **Project** | Install, bridge plugin, MCP clients, context strategy for other clients, ue-mcp.yml. Native Unreal tools and skills for other clients from inside the editor, where ue-mcp init runs. |
| **General** | Appearance, Updates. |
| **Diagnostics** | Editor and daemon status, logs. |

Desktop: a left rail under two labels (Work; Project and Studio) with a status dot where something needs attention. Narrow: Settings opens on the section list with one live status line per section; a section opens full width with Back.

### 1.1 Where every earlier setting went

| Setting | Home now | Note |
|---------|----------|------|
| Updates, theme | General | |
| Model, effort | Agents | the chat's picker sets the same model, as before |
| Sign-ins, API keys | Models & accounts | one name per route: "Claude sign-in", "ChatGPT sign-in", "<vendor> key" |
| Ask before commands and files | Approvals & review | four rows: shell, files, editor restarts, destructive ue-mcp actions |
| Subagents mode, model, effort | not editable | earlier values still drive the built-in editor worker, shown read only (2.7) |
| Subagents per turn | not editable | the stored value still caps helpers per turn |
| Give the agent CLAUDE.md | Agents | "Read the project's own files", one switch for every convention |
| Image size | Agents | |
| Turn token limit | removed | dropped when old settings load |
| Review each turn | Approvals & review | |
| Dialog mode and policy | Approvals & review | mode shared; the policy sits under "Show them to me in Studio", the mode it applies to |
| Playtest runs | Approvals & review > Starting playtests | ue-mcp's shared mode when the daemon offers it (section 6) |
| Assign to subagent budget | removed | the loop stops after a fixed number of attempts |
| Feedback tool and mode | Approvals & review | shared |
| Context strategy for other clients | Project | from any browser |
| Install, bridge, clients, ue-mcp.yml | Project | |
| Status, logs | Diagnostics | |

---

## 2. Agents: each vendor's own files

### 2.1 Which convention a route reads

The convention follows the model's vendor, whatever the route:

| Model's vendor | Routes | Convention |
|----------------|--------|------------|
| Anthropic | Claude sign-in (Agent SDK), Anthropic key | Claude Code |
| OpenAI | ChatGPT sign-in, OpenAI key | Codex |
| Google | Google key | Gemini CLI |
| A custom endpoint | `endpoint:<id>` | AGENTS.md and `.agents/skills/` |

Studio starts each session in the project folder, so "the current directory" in every vendor's rules below is the project folder.

### 2.2 Claude Code (code.claude.com/docs)

| Kind | Read from | Order and precedence |
|------|-----------|----------------------|
| Instructions | `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`; `CLAUDE.md` and `.claude/CLAUDE.md` in the project folder and every parent; `.claude/rules/**/*.md` (a `paths` field scopes a rule); `CLAUDE.local.md`; a subfolder's `CLAUDE.md` once the agent works there | root first, the local file after its folder's CLAUDE.md, nothing overrides; `@path` imports up to four hops |
| AGENTS.md | `AGENTS.md`, `.claude/AGENTS.md` in the project folder and parents | only when no CLAUDE.md, `.claude/CLAUDE.md` or CLAUDE.local.md exists there or above, Claude Code's default |
| Subagents | `.claude/agents/**/*.md` from the project folder up to the repo root, `~/.claude/agents/**/*.md` | project before user; the closest folder wins a name clash; identity is `name` |
| Skills | `.claude/skills/<name>/SKILL.md` up to the repo root, `~/.claude/skills/`, a subfolder's skills once the agent works there | user before project on a clash |
| Settings | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` | local over project over user; permission lists merge |

**On the Claude sign-in** the Agent SDK loads all of this itself: `settingSources: ["user", "project", "local"]`, the SDK's own default and Claude Code's. Studio adds no instruction text of its own on that route. What Studio adds so its own tools stay the only tools:

- `toolAliases` maps Claude Code's built-in names (Bash, Read, Write, Edit, Glob, Grep, WebFetch) to Studio's tools, so a skill or subagent that names one runs Studio's tool, with Studio's approvals, kill guard and transcript.
- Studio reads the project's and the user's subagent files itself and passes them to the SDK as programmatic agents of the same `name` (programmatic agents take precedence over files), every field as written (description, body as the prompt, model, effort, maxTurns, skills, background) and its `tools` mapped to Studio's equivalents. A subagent behaves as written, and every call it makes still goes through Studio.
- Skills stay files the SDK loads; Studio's tool list names the Skill tool, which an explicit list must include.
- The account's claude.ai connectors stay out, as before.

**On an Anthropic key** Studio's own loop reads the same files in the same order (2.6).

### 2.3 Codex (learn.chatgpt.com/docs)

| Kind | Read from | Order and precedence |
|------|-----------|----------------------|
| Instructions | global: `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md` (first non-empty); project: in each folder from the repo root down to the project folder, `AGENTS.override.md`, else `AGENTS.md`, else a name from `project_doc_fallback_filenames`, at most one per folder | root first, nearer files later and winning; stops adding at 32 KiB in all, Codex's `project_doc_max_bytes` default |
| Subagents | `.codex/agents/*.toml`, `~/.codex/agents/*.toml` | `name`, `description`, `developer_instructions` required; `model`, `model_reasoning_effort` and `features.shell_tool` read; the project's file wins a name clash |
| Skills | `.agents/skills/<name>/SKILL.md` in every folder from the project folder up to the repo root, `~/.agents/skills/` | no precedence: two skills with one name are both listed, as Codex lists both |

A skill's `agents/openai.yaml` is read for `policy.allow_implicit_invocation`: a skill that says false is listed but used only when the user names it.

### 2.4 Gemini CLI (geminicli.com/docs)

| Kind | Read from | Order and precedence |
|------|-----------|----------------------|
| Instructions | the context file name from `context.fileName` in `.gemini/settings.json` or `~/.gemini/settings.json` (default `GEMINI.md`, a list allowed): `~/.gemini/<name>`; the project folder and each parent up to a `.git` boundary; subfolders below the project (at most 200, skipping `node_modules` and `.git`); a folder the agent touches later | general to specific, all concatenated; `@file` imports up to five levels |
| Subagents | `.gemini/agents/*.md`, `~/.gemini/agents/*.md` | `name`, `description` required; `tools`, `model`, `max_turns` read; the project's file wins a name clash; subagents cannot call subagents |
| Skills | workspace `.agents/skills/` then `.gemini/skills/`; user `~/.agents/skills/` then `~/.gemini/skills/` | workspace over user; within a tier `.agents/skills` over `.gemini/skills` |

Google retired Gemini CLI for consumer accounts in June 2026. It remains for Gemini API keys, the route Studio uses for Gemini, so these stay Gemini's native files; its successor reads `GEMINI.md`, `AGENTS.md` and `.agents/skills/`, which this covers.

### 2.5 Custom endpoints

An OpenAI-compatible endpoint has no tool of its own, so it reads the vendor-neutral files: AGENTS.md by the Codex walk (without the override and fallback names) and `.agents/skills/`. It has no subagent convention; the built-in editor worker is its only helper.

### 2.6 How Studio's own loop honours them

- **Instructions**: composed from the convention's files in that tool's order, each under a heading with its path, after Studio's own working rules. Files that join later (a subfolder's CLAUDE.md, a Gemini folder touched later, a rule with `paths`) are added to the first tool result that touches their folder or a matching file, once per conversation.
- **Subagents**: Studio's agent tool takes a `helper` argument naming one of the convention's subagents or the built-in worker. A helper runs with its file's prompt, its model when that vendor's model runs on this machine (else the main agent's, and the view says so), its effort, its turn limit, and its tools mapped to Studio's (Claude Code names, Gemini wildcards and Codex's `features.shell_tool = false` all map to the matching subset). Helpers cannot start helpers.
- **Skills**: the names and descriptions go in the prompt; a `skill` tool returns a skill's body and its file list, and its supporting files are read with read_file. A skill's `allowed-tools` never widens what the agent may do.
- **Switch**: "Read the project's own files" (the old CLAUDE.md switch, on by default) turns all of this off for every route at once: the Claude sign-in then runs with no setting sources, as Studio did before.

### 2.7 What Settings > Agents shows

Read only, one tab per convention, the conventions of connected routes first; when nothing is connected all four show, so a new user sees what each vendor would read.

- Instruction files: path, size in tokens, when it applies (always, in a folder, for matching files), which it imports, Open file.
- Subagents: name, description, model as written and as it will run here, tools, turn limit, path, size, Open file.
- Skills: name, description, source (project, user, a ue-mcp plugin with its package from the daemon's skills listing), size, Open file.
- A sentence per convention on which files that vendor's tools read, linking its documentation.
- The built-in editor worker: its model, effort and when it starts, from earlier settings when the user had set them, else the defaults (the main agent's model and effort, started when the user asks).

Open file opens the file in the system's editor through the agent (`POST /files/open`), only for a path the view listed.

### 2.8 Migration

| Old | Now |
|-----|-----|
| `usage.projectInstructions` | "Read the project's own files"; false keeps every route reading none |
| `usage.subagents`, `subagentModel`, `subagentEffort` | kept and honoured by the built-in worker, shown read only |
| `usage.subagentsPerTurn` | kept and honoured, no control |
| `askBeforeChanges` | the four approval rows; still written for an older Studio |
| `usage.turnTokenLimit`, playtest budget | dropped on load |

---

## 3. Context strategy

**Other clients** (built): Project sets `context.strategy` in ue-mcp.yml from any browser, with each strategy's seed tokens (measured by the daemon's projection when it offers one, else ue-mcp's published figures), the clients it affects, and the environment override marked.

**Studio's own agent**: Micro (today's single ue-mcp tool), Lean (a tool per category with action names, signatures on demand) or Full (every signature inline), from the daemon's projection of ue-mcp's own surfaces (`context.project` and `context.call`), so Studio never rebuilds ue-mcp's tools. Auto picks, per vendor and scope, the strategy with the fewest median tokens among those within one task of the best pass rate, from `context-costs.json` in ue-mcp's measurement format (`ContextMeasurement`). Until a measurement ships, Auto is hidden and Micro is the default. The measurement runner is ready and needs editor runs (section 10).

---

## 4. Usage (removed)

The Usage section, its ledger, budgets, price table, endpoint prices and plan meters were removed: nobody used them. What remains is each agent's input and output tokens for the session, from the counts providers report, kept in the session and shown as "tokens: N" on that agent's row in the chat's thread list.

---

## 5. Models & accounts

Sign-ins, API keys and the model catalog (built). Adds custom OpenAI-compatible endpoints (name, base URL, optional key, models from its `/models` or typed) as vendors `endpoint:<id>`, and the route order (sign-ins first or keys first) that picks a route when a model has several.

---

## 6. ue-mcp prerequisites

General daemon features, added to ue-mcp first and announced as feature strings: the skills listing with owners (`skills`, `GET /v1/skills`), projections of ue-mcp's surfaces for a category list and a call into a projected tool (`context.projection`), each action's read and destructive flags (`actions.effects`), the context measurement format (`ContextMeasurement`, its validator and JSON schema), and Playtest runs as a shared mode (`modes.playtest`, `ue-mcp playtest mode`). Studio feature-detects each and keeps today's behaviour without it.

---

## 7. Routes under /v1/ext/studio

| Method | Path | Purpose |
|--------|------|---------|
| GET, PUT | `/settings` | as before, plus `approvals` |
| GET | `/native` | per convention: instruction files, subagents, skills, with paths, scopes and sizes |
| GET | `/native/preview?convention=` | the instruction text an agent on that convention is given |
| POST | `/files/open` | open a listed file in the system's editor |
| GET, PUT | `/context-strategy` | other clients' strategy in ue-mcp.yml |
| GET, PUT | `/context` | Studio's agent: its strategy, the seed cost of each at its scope, the measurement table |
| GET, POST, PUT, DELETE | `/endpoints` | custom model endpoints |

---

## 8. Phasing

1. **Settings layout** (built, #64).
2. **Native files on every route**, the read-only Agents view, the built-in worker shown read only. (Built, #67.)
3. **Usage ledger and dashboard.** (Built, #68; removed since.)
4. **Context strategy for Studio's agent**, on ue-mcp's projections. (Built, #70; Auto stays hidden until its measurement is committed.)
5. **Custom endpoints and route order** (built, #71).

---

## 9. Settled decisions

1. Studio invents no agent, skill or team file format and writes none: no `.ue-mcp/studio/agents/`, no `team.yml`, no `studio:` frontmatter.
2. The convention follows the model's vendor, not the route, so an Anthropic key and the Claude sign-in read the same files.
3. On the Claude sign-in the SDK's setting sources are user, project and local, Claude Code's own default.
4. Built-in tool names are aliased to Studio's tools and file subagents are passed programmatically with mapped tools, so every call on every route goes through Studio's approvals and transcript.
5. Codex skills with the same name are both listed, because Codex lists both; Gemini and Claude precedence follow their documentation.
6. A subagent whose model this machine cannot run uses the main agent's model and says so in the view; it is never dropped.
7. The old CLAUDE.md switch becomes "Read the project's own files" for every convention, keeping its stored value.
8. The built-in worker keeps honouring the stored subagent mode, model and effort; they are shown, not edited.
9. The chat's model picker sets the model new turns run on, as before; there is no separate per-session default.
10. Playtest runs uses ue-mcp's shared mode when the daemon offers it, with the shared badge; otherwise Studio's own setting, without it.

---

## 10. Editor runs pending

No phase was run against a live editor: the user has not asked for editor use. Each phase's PR lists the exact commands that prove it live once asked.

- **Context measurement for Auto**: `node scripts/usage-parity/measure.mjs --project <tests/ue_mcp .uproject> --no-cc --rounds 3 --strategies micro,lean,full --measurement apps/agent/src/context-costs.json`, then commit the file. Until it exists Auto stays hidden and Micro is the default.
- **Lean and Full on the daemon**: with the daemon offering `context.projection` (ue-mcp after 1.4.11-beta.4), choose Lean in Settings > Agents and run a turn on each route; the transcript shows each category call as `ue_mcp` category.method, and a destructive action still asks first.

---

## 11. Decisions made while building

### Phase 1

1. **Approval defaults.** A new install asks before all four kinds. Settings from before the rows keep what they did: askBeforeChanges sets shell and files, and editor restarts and destructive actions stay allowed, because they never asked before.
2. **What counts as an editor restart.** The editor_restart tool, and ue-mcp's editor stop, start, restart and rebuild actions reached through ue_mcp. "Allow for this session" is per kind.
3. **Destructive actions come only from ue-mcp.** Studio reads the daemon's action effects. A daemon without them cannot say, so that row is unavailable and says to update ue-mcp; Studio never guesses from action names.
4. **Scoped files join through tool results**, once per conversation, on both routes; the main agent and each helper are separate conversations.
5. **Context strategy for other clients** writes `context.strategy` in ue-mcp.yml (micro as no setting, as `ue-mcp init` does), then restarts ue-mcp after the turn in progress. The choice shown is the file's value, which a click changes; an environment override is marked beside it.
6. **Narrow Settings** opens on the section list with a live status line per section; a wide panel always has a section open, Agents first. Old `#/settings/agent` and `#/settings/account` links land on Agents and Models & accounts.
7. **Phase 1 read every convention on every route** and offered per-file switches, added files and Create AGENTS.md. Phase 2 replaces that with each vendor's own files read as its tools read them, shown read only: the per-file switches, added files, Studio's own `~/.ue-mcp/studio/instructions.md` and Create AGENTS.md are removed, since Studio no longer chooses what a vendor's convention says.

### Phase 2

1. **One vendor order everywhere.** Sign-ins, keys, the models table and the Agents tabs list vendors in one fixed order (Anthropic, OpenAI, Google, then other models) in every state; a green dot marks what a connected route reads. Position never encodes connection, so nothing reorders when a route connects.
2. **The tabs are named after the tool whose files they show**: Claude Code, Codex, Gemini CLI, AGENTS.md. All four show with nothing connected, the first in the order selected, each saying no route reads it; the AGENTS.md tab says custom endpoints read it rather than offering a connection. Below 480 px the tabs become a select.
3. **The preview is what the route really gets.** On the Claude sign-in the Agent SDK reads the files itself, so the preview is those files in load order with imports expanded; on every other route it is the text Studio sends. Its title says how many files are read on every call and how many join by path.
4. **Studio's worker follows the main agent** unless an earlier Studio set its own model of the same vendor; a model of another vendor is not used, so the view never shows a model the turn would not run. Its values are read only.

### Phase 3

The ledger, budgets, plan meters and cost estimates built here were removed (section 4).

### Phase 4

1. **Lean and Full are ue-mcp's own projected tools**, offered as they are; Studio writes none of them. A category call is read back as the ue_mcp call it is (category, method, args), so approvals, action effects, checkpoints and the transcript see one shape on every strategy. A projected tool that is not a category, such as Lean's catalog, runs through `context.call`.
2. **The Claude sign-in gets the same surface**: projected tools are registered with the Agent SDK from their JSON Schemas, and project subagents whose files allow ue_mcp get every projected editor tool in its place.
3. **The choice is Studio's own setting** (`usage.contextStrategy`, Micro by default) and never touches ue-mcp.yml, so other clients keep theirs. A daemon without projections runs Micro whatever was chosen and says why; a projection that fails mid-session falls back to Micro for that turn.
4. **Auto ships hidden.** It appears only once `context-costs.json` exists beside the agent; the usage-parity runner writes it from task-checked runs per strategy.

### Phase 5

1. **Endpoints serve every project, like the vendor keys.** The list is `~/.ue-mcp/studio/endpoints.json`, beside the keys folder; each key is `keys/endpoint-<id>.key`, mode 600, reported by presence only. An endpoint's id comes from its name (lowercase letters, digits and hyphens), so `endpoint:<id>` never holds a second colon.
2. **A key is optional.** Without one the request carries no authorization header, as a local server expects.
3. **Models are read from the endpoint's `/models` and can be typed.** Adding an endpoint, or changing its address or key, reads the list once; Read models reads it again. A typed model stays when the list is read again, a listed one that disappears goes, and a changed address drops the listed ones. A failed read is kept and shown beside the endpoint, never thrown, and its models stay.
4. **An endpoint's model has one route: the endpoint.** The route order (sign-ins first by default, or keys first) applies only to named vendors' models that a sign-in and a key can both run; the catalog carries it so the picker and the models table list routes in the order they are tried.
5. **Removing the endpoint the main agent runs on** puts the main agent back on the default model, so a turn never starts on a route that is gone. A model the endpoint no longer lists is shown in the picker's connect view with what to do.
