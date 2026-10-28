# Usage parity: Studio against Claude Code

Measures what Studio spends on a set of Unreal tasks against Claude Code doing the same tasks through ue-mcp, over repeated runs, and checks in the editor that each run did its task.

```bash
npm ci
node scripts/usage-parity/measure.mjs --project C:/path/to/TestProject/TestProject.uproject --rounds 3 --base origin/integration/next
```

The editor must already be running on that project. The runner never starts, stops or restarts an editor, and refuses to run when the connected editor has a different project open. Use a test project only: the runs create and delete assets and actors.

## What it compares

- `cc`: Claude Code headless (`claude -p`) with ue-mcp as its only MCP server (`--strict-mcp-config`), `--setting-sources project,local`, bypassing permissions. Multi-turn prompts continue with `--resume`.
- `studio`: this checkout's agent source, bundled into a harness that runs Studio's Claude-plan turn on the user's Claude Code login (`runSubscriptionTurn`), tool executor (`executeTool`) and system prompts with the default usage settings, against ue-mcp. The model, effort and SDK options are the ones Studio sends.
- `studio-base` (with `--base <git ref>`): the same harness built from that ref, so a change is measured against what it changes, in the same session.

Both clients use the same Claude login, model and effort (`--model`, default `claude-sonnet-5-5`; `--effort`, default `medium`).

## Prompts

`prompts.json`. A: one light, saved. B: a read-only project audit. C: a material, a Blueprint and three instances. D: five turns on one level (build, inspect, change, verify, save). E: a viewport screenshot judged by the model. Every run starts from the same level, `/Game/ABWork/L_Work`, a copy of `/Game/AB/L_ABBase` (floor, sun, sky light, atmosphere, player start) that the runner creates on first use.

## How it counts

Cost is input-equivalent tokens, read from the Claude transcripts each run writes under `~/.claude/projects/<project>`: input x1, 5-minute cache write x1.25, 1-hour cache write x2, cache read x0.1, output x5. Each assistant message counts once by its id, main transcript and subagents together.

- Clients run interleaved, prompt by prompt, and the client order reverses every round.
- Each client's first run (prompt A, labelled `warm`) writes its fixed prefix to the prompt cache and is not counted, so no client is charged for a cold cache the other did not pay.
- Each run's first message carries a random tag, so no run reads another run's conversation from the cache.

## Task checks

After each run the runner reads the editor back (`editor.mjs`, `verify`): the actor, its class, location, intensity and colour for A; nothing changed and the answer naming the level, materials and classes for B; the assets, unlit shading, components, instance positions and nothing left unsaved for C; every pillar's mesh, position and scale and the light for D; the answer describing the scene for E. A run that fails a check is reported as failed with the check's name.

## Output

`apps/agent/.usage-parity/<timestamp>/`: `results.jsonl` (one record per run: client, prompt, transcripts, final answer, checks) and `report.md`, which has per prompt and client the run count, median and range, the median and worst run as a share of Claude Code's median, and task success, then one row per run with model calls, cache writes and reads, output, search/describe/call counts and the largest tool results.

`node scripts/usage-parity/report.mjs <results.jsonl>` prints the tables again.

## Context strategies

`--strategies micro,lean,full` runs Studio once per ue-mcp context strategy instead of once: ue-mcp is started with `UE_MCP_CONTEXT_STRATEGY` set, its own tools/list is the surface Studio's agent gets (a tool with an action enum is a category), and calls go through the category tools as Studio's daemon route sends them. `--measurement <file>` writes those runs in ue-mcp's `ContextMeasurement` format, every measured task with its tokens, model calls, discovery calls and whether its checks passed.

```bash
node scripts/usage-parity/measure.mjs --project C:/path/to/TestProject/TestProject.uproject --no-cc --rounds 3 --strategies micro,lean,full --measurement context-costs.json
```

## Options

| option | default | |
|---|---|---|
| `--project` | required | the `.uproject` the running editor has open |
| `--rounds` | 3 | runs per prompt per client |
| `--prompts` | A,B,C,D,E | which prompts |
| `--base` | none | also measure the agent source at this git ref |
| `--model`, `--effort` | claude-sonnet-5-5, medium | for both clients |
| `--no-cc` | | Studio only |
| `--no-warm` | | skip the uncounted warm-up runs |
| `--keep` | | leave the test levels and screenshots in the project |
| `--build-only` | | bundle the harnesses and stop; no editor needed |
| `--strategies` | none | run Studio once per listed context strategy (micro, lean, full) |
| `--measurement` | none | with `--strategies`, write the runs as a `ContextMeasurement` file |

Without `--keep`, the runner loads the level that was open before, deletes `/Game/AB` and `/Game/ABWork`, and removes the screenshots the runs wrote under `Saved/Screenshots`.

## Needs

- `claude` on the PATH, signed in. Studio's harness runs on the same login, through the Agent SDK runtime Studio downloads to `~/.ue-mcp/studio/runtime`.
- The repo's dependencies (`npm ci`): the harness resolves the Agent SDK and the MCP SDK from them, and ue-mcp from `apps/agent/node_modules/ue-mcp`.
