/**
 * The Playtest Hub's screens for the visual QA harness, drawn from the same
 * project the hub demo plays (hub-demo/seed.ts): each scenario is a snapshot
 * of the simulated daemon at one moment, its GETs answered by the simulator
 * itself, so the shots and the demo always agree.
 */
import { checkId } from "@ue-mcp-studio/shared";
import { demoRandom, demoState, DEMO_PROJECT, DEMO_SCRIPTS_DIR, type DemoSeed } from "../hub-demo/seed";
import { HubDemo } from "../hub-demo/sim";
import type { Scenario } from "./fixtures";

/** The simulated project after `ms` of play: the queue's first plan under way. */
function snapshot(seed: DemoSeed, ms: number, editor = true): HubDemo {
  const start = Date.now() - ms - 5_000;
  let now = start;
  const state = demoState(seed, start);
  state.editor = editor;
  const d = new HubDemo(state, { now: () => now, random: demoRandom(11) });
  for (let t = 0; t < ms; t += 250) {
    now += 250;
    d.tick();
  }
  return d;
}

/** The daemon's health with the demo project's editor connected or not. */
const health = (connected: boolean) => ({
  ok: true, pid: 4120, version: "1.4.11-beta.4", apiVersion: 1, projectRoot: "c:/users/dev/projects/emberhollow", startedAt: "2026-11-23T08:00:00Z",
  editors: [{ name: DEMO_PROJECT, connected, port: 9877, pid: connected ? 22816 : null, lastDisconnect: connected ? null : { cause: "closed", at: "2026-11-23T14:10:00Z" } }],
  clients: 1, inflight: 0, lastEventId: 0, extensions: [{ name: "studio", version: "dev" }], ui: "dev", features: ["checkpoints"],
});

function hub(title: string, hash: string, d: HubDemo, extra: Partial<Scenario> = {}): Scenario {
  const index = d.handle("GET", "/v1/ext/studio/qa/playtests", new URLSearchParams())!.body as Scenario["index"];
  return {
    title,
    hash,
    index,
    settings: { experiments: { playtestHub: true } },
    get: (p, url) => {
      if (p === "/v1/health") return health(d.state.editor);
      const a = d.handle("GET", p, url.searchParams);
      return a && a.status < 400 ? a.body : undefined;
    },
    ...extra,
  };
}

const full = snapshot("full", 6_000);
const offline = snapshot("full", 0, false);
const empty = snapshot("empty", 0);
const enc = encodeURIComponent;
const ledge = checkId({ kind: "script", target: `${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab` });
const staggerRun = full.state.runs.find((r) => r.name === "PT_Stagger_Wisp" && r.outcome === "failed")!.runId;

export const HUB_SCENARIOS: Record<string, Scenario> = {
  "hub-overview": hub("Playtest Hub overview: Now running with the runs waiting and finished, milestones and goals by status, every playtest, Needs attention and what just broke", "#/playtests", full),
  "hub-overview-empty": hub("Playtest Hub overview on a project with playtests and no goals: every playtest with its health, Run all and Run failing", "#/playtests", empty),
  "hub-goal": hub("A failing goal: its playtests with health and history, owner, priority and due date, Run goal, Fix with an agent and Write playtests", "#/playtests/goals/lantern-combat", full),
  "hub-goal-not-on-checkout": hub("A goal with a playtest that is not on this checkout: shown as such, the goal in progress rather than failing", "#/playtests/goals/coop-revive", full),
  "hub-goal-milestone": hub("A milestone: its goals' statuses rolled up, with progress", "#/playtests/goals/vertical-slice", full),
  "hub-library": hub("The library: every playtest with its health, goals and pass rate", "#/playtests/checks", full),
  "hub-check": hub("A flaky playtest: its steps, its own links and every run, newest first", `#/playtests/checks/${enc(ledge)}`, full),
  "hub-run": hub("A failed run: the step timeline, the observed values, the log and the comparison with the last pass", `#/playtests/runs/${enc(staggerRun)}`, full),
  "hub-editor-offline": hub("The hub with the editor closed: Now running waits for it", "#/playtests", offline),
};
