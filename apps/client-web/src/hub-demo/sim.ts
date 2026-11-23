/**
 * The Playtest Hub's simulated daemon: answers every HUB_ROUTES route and the
 * /qa routes the hub uses from a DemoState, and moves the state on as time
 * passes. Runs take their steps on a clock, manual steps wait for a verdict,
 * the queue starts plans one item at a time, fix loops settle, and schedules
 * come due. Status is worked out with the shared rules (checkHealth,
 * goalStatus and the rest), exactly as the agent does. Every change is
 * announced as the daemon would: script.*, studio.qa.changed and
 * studio.hub.changed. No DOM: the clock, the random source and the event sink
 * are given, so tests and the visual QA harness drive it too.
 */
import {
  CHECK_HEALTH_ORDER,
  DEFAULT_ACCEPTANCE,
  DEFAULT_PLAN_OPTIONS,
  GOAL_ID,
  HUB_CHANGED,
  HUB_GOALS_DIR,
  HUB_SCHEMA,
  INBOX_ORDER,
  checkId,
  checkStateOf,
  goalSlug,
  goalStatus,
  leafName,
  outcomeOf,
  parseCheckId,
  qaDraftFromScript,
  qaEnded,
  qaScriptKey,
  qaSummaryOf,
  type AcceptanceRule,
  type CheckDetail,
  type CheckRef,
  type CheckState,
  type Goal,
  type GoalDraft,
  type GoalState,
  type GoalStatus,
  type GoalUpdate,
  type HubChangedWhat,
  type HubOverview,
  type InboxItem,
  type PlanItem,
  type PlanRequest,
  type PlanRun,
  type PlanTrigger,
  type QaRun,
  type QaScriptStep,
  type QaStep,
  type QueueState,
  type RunDetail,
  type RunRecord,
  type RunSource,
  type Schedule,
  type ScheduleDraft,
} from "@ue-mcp-studio/shared";
import { obj } from "@ue-mcp-studio/client-core";
import {
  DEMO_PROJECT,
  DEMO_SCRIPTS_DIR,
  DEMO_USER,
  demoEvidence,
  demoHash,
  demoNextRun,
  demoQaRun,
  demoRandom,
  demoResultsPath,
  demoRunId,
  demoWrittenScripts,
  type DemoScript,
  type DemoState,
} from "./seed";

export interface DemoAnswer {
  status: number;
  body?: unknown;
}

export interface DemoOptions {
  now?: () => number;
  random?: () => number;
  /** Every event the daemon would publish: its stream type and payload. */
  emit?: (type: string, data: Record<string, unknown>) => void;
}

const BASE = "/v1/ext/studio";
const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body?: unknown, status = 200): DemoAnswer => ({ status, body });
const refuse = (status: number, error: string): DemoAnswer => ({ status, body: { error } });
const FINISHED_OUTCOMES = ["passed", "failed", "incomplete", "stopped", "error"];

/** Errors and warnings a PIE session logs now and then, whatever the run. */
const NOISE = [
  "LogStreaming: Warning: Async load of /Game/EmberHollow/Audio/Ambience/SC_AshwoodWind took 212 ms",
  "LogNet: Warning: BP_Wisp_C_3 has no owning connection",
  "LogAnimation: Warning: Montage AM_Lantern_Strike_02 has no slot DefaultGroup.UpperBody",
  "LogNiagara: Warning: NS_EmberTrail exceeded its particle budget (2048)",
  "LogPhysics: Warning: BP_FallenLog_4 has simulate physics on but no collision",
];
/** What a failing step logs, by script. */
const FAILURE_LOG: Record<string, string> = {
  PT_Stagger_Wisp: "LogScript: Error: Accessed None trying to read property StaggerComponent. Node: Apply Stagger Graph: EventGraph Blueprint: BP_Wisp_Elite",
  PT_Boss_Phase2: "LogNet: Error: LanternSyncComponent: client lantern state bRaised never reached the server",
  PT_LedgeGrab: "LogTraversal: Error: Ledge trace missed BP_BrokenPillar_2 (capsule 3 cm short)",
};

export class HubDemo {
  readonly state: DemoState;
  /** Set by every change, for whoever saves the state. */
  dirty = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sink: (type: string, data: Record<string, unknown>) => void;

  constructor(state: DemoState, o: DemoOptions = {}) {
    this.state = state;
    this.now = o.now ?? (() => Date.now());
    this.random = o.random ?? demoRandom(demoHash(state.seed) ^ (Date.now() & 0xffff));
    this.sink = o.emit ?? (() => undefined);
  }

  // ---------- Time ----------

  /** Move the simulation to now: jobs due, the live run's next step, the queue, schedules. */
  tick(): void {
    const now = this.now();
    const s = this.state;
    for (const job of s.jobs.filter((j) => j.at <= now)) {
      s.jobs = s.jobs.filter((j) => j !== job);
      if (job.kind === "loop") this.settleLoop(job.runId);
      else this.writeScripts(job.goalId);
    }
    this.dueSchedules(now);
    if (s.live) {
      if (!s.live.blocked && s.editor && now >= s.live.nextAt) this.step();
      return;
    }
    if (now < s.idleUntil) return;
    this.advanceQueue();
  }

  setSpeed(speed: number): void {
    this.state.speed = speed > 0 ? speed : 1;
    this.dirty = true;
  }

  /** The editor connecting or going away. A run it was playing ends with it. */
  setEditor(connected: boolean): void {
    const s = this.state;
    if (s.editor === connected) return;
    s.editor = connected;
    this.emit(connected ? "editor.connected" : "editor.disconnected", { project: DEMO_PROJECT, ...(connected ? { port: 9877 } : { cause: "closed" }) });
    if (!connected && s.live) this.endLive("stopped", "error", "The editor disconnected during the run");
    this.hubChanged(["queue", "runs", "checks"]);
  }

  private ms(base: number): number {
    return base / (this.state.speed || 1);
  }

  // ---------- Requests ----------

  /** A request under /v1/ext/studio/hub or /qa, or undefined for any other path. */
  handle(method: string, path: string, query: URLSearchParams, body?: unknown): DemoAnswer | undefined {
    if (!path.startsWith(`${BASE}/hub`) && !path.startsWith(`${BASE}/qa/`)) return undefined;
    const seg = path.slice(BASE.length).split("/").slice(1).map((x) => decodeURIComponent(x));
    const m = (verb: string, pattern: string): string[] | null => {
      if (verb !== method) return null;
      const ps = pattern.split("/").slice(1);
      if (ps.length !== seg.length) return null;
      const params: string[] = [];
      for (let i = 0; i < ps.length; i++) {
        if (ps[i] === "*") params.push(seg[i]);
        else if (ps[i] !== seg[i]) return null;
      }
      return params;
    };
    const b = obj(body);
    const answer = this.route(m, query, b);
    if (method !== "GET") this.dirty = true;
    if (!answer) return refuse(method === "GET" ? 404 : 405, `The demo daemon has no ${method} ${path}`);
    // A copy, as an answer off the wire is: later changes to the state never reach it.
    return answer.body === undefined ? answer : { status: answer.status, body: JSON.parse(JSON.stringify(answer.body)) };
  }

  private route(m: (verb: string, pattern: string) => string[] | null, q: URLSearchParams, b: Record<string, unknown>): DemoAnswer | undefined {
    let p: string[] | null;
    // The hub.
    if (m("GET", "/hub")) return ok(this.overview());
    if (m("GET", "/hub/queue")) return ok(this.queueState());
    if ((p = m("GET", "/hub/goals/*"))) {
      const g = this.goal(p[0]);
      return g ? ok(this.goalState(g)) : refuse(404, "No such goal");
    }
    if (m("POST", "/hub/goals")) return this.createGoal(b as unknown as GoalDraft);
    if ((p = m("PUT", "/hub/goals/*"))) return this.updateGoal(p[0], b as GoalUpdate);
    if ((p = m("DELETE", "/hub/goals/*"))) return this.deleteGoal(p[0]);
    if ((p = m("POST", "/hub/goals/*/checks"))) return this.addChecks(p[0], Array.isArray(b.checks) ? (b.checks as CheckRef[]) : []);
    if ((p = m("DELETE", "/hub/goals/*/checks/*"))) return this.removeCheck(p[0], p[1]);
    if ((p = m("POST", "/hub/goals/*/sign-off"))) return this.signOff(p[0], typeof b.note === "string" ? b.note : undefined);
    if ((p = m("DELETE", "/hub/goals/*/sign-off"))) return this.signOff(p[0], undefined, true);
    if ((p = m("POST", "/hub/goals/*/write-playtests"))) return this.writePlaytests(p[0]);
    if ((p = m("GET", "/hub/checks/*"))) return this.checkDetail(p[0], q);
    if ((p = m("POST", "/hub/checks/*/run"))) {
      const ref = this.checkRef(p[0]);
      if (!ref) return refuse(404, "No such check");
      return this.plan({ scope: { kind: "checks", checks: [ref] }, options: { replay: b.replay === true } }, "person");
    }
    if (m("GET", "/hub/runs")) return this.runList(q);
    if ((p = m("GET", "/hub/runs/*"))) {
      const d = this.runDetail(p[0]);
      return d ? ok(d) : refuse(404, "No such run");
    }
    if (m("POST", "/hub/plans")) return this.plan(b as unknown as PlanRequest, "person");
    if ((p = m("POST", "/hub/plans/*/cancel"))) return this.cancelPlan(p[0]);
    if ((p = m("POST", "/hub/plans/*/move"))) return this.movePlan(p[0], Number(b.to));
    if (m("PUT", "/hub/queue/paused")) return this.pause(b.paused === true);
    if (m("POST", "/hub/schedules")) return this.createSchedule(b as unknown as ScheduleDraft);
    if ((p = m("PUT", "/hub/schedules/*"))) return this.updateSchedule(p[0], b as Partial<ScheduleDraft>);
    if ((p = m("DELETE", "/hub/schedules/*"))) {
      const before = this.state.schedules.length;
      this.state.schedules = this.state.schedules.filter((x) => x.id !== p![0]);
      if (this.state.schedules.length === before) return refuse(404, "No such schedule");
      this.hubChanged(["queue"]);
      return ok(undefined, 204);
    }
    if (m("POST", "/hub/assign-failing")) return this.assignFailing(typeof b.goalId === "string" ? b.goalId : undefined);
    // Playtests and runs.
    if (m("GET", "/qa/runs")) return ok({ runs: this.unownedRuns() });
    if (m("GET", "/qa/playtests")) return ok(this.playtests());
    if (m("GET", "/qa/playtests/script")) {
      const sc = this.script(q.get("script") ?? "");
      return sc && !sc.missing ? ok({ run: this.draftOf(sc) }) : refuse(404, "No such script");
    }
    if (m("PUT", "/qa/playtests/script")) return this.saveScript(String(b.script ?? ""), b.steps, typeof b.map === "string" ? b.map : undefined, "path");
    if (m("DELETE", "/qa/playtests/script")) return this.deleteScript(q.get("script") ?? "", "path");
    if (m("POST", "/qa/playtests/card")) {
      const sc = this.script(String(b.script ?? ""));
      return sc && !sc.missing ? ok({ run: this.draftOf(sc) }) : refuse(404, "No such script");
    }
    if ((p = m("GET", "/qa/runs/*/status"))) {
      const run = this.qaRun(p[0]);
      return run ? ok({ answer: this.answerOf(run), run }) : refuse(409, "No such run");
    }
    if ((p = m("GET", "/qa/runs/*/results"))) {
      const run = this.qaRun(p[0]);
      return run ? ok(this.answerOf(run)) : refuse(404, "No results for this run");
    }
    if ((p = m("POST", "/qa/runs/*/verdict"))) return this.verdict(p[0], Number(b.step), String(b.verdict ?? ""), typeof b.note === "string" ? b.note : undefined);
    if ((p = m("POST", "/qa/runs/*/stop"))) return this.stop(p[0]);
    if ((p = m("POST", "/qa/runs/*/run"))) return this.runNow(p[0]);
    if ((p = m("POST", "/qa/runs/*/assign"))) return this.assign(p[0]);
    if ((p = m("DELETE", "/qa/runs/*/assign"))) return this.cancelLoop(p[0]);
    if ((p = m("PUT", "/qa/runs/*/script"))) return this.saveScript(p[0], b.steps, typeof b.map === "string" ? b.map : undefined, "run");
    if ((p = m("DELETE", "/qa/runs/*/script"))) return this.deleteScript(p[0], "run");
    if ((p = m("DELETE", "/qa/runs/*"))) return ok(undefined, 204);
    return undefined;
  }

  // ---------- Reading ----------

  private script(path: string): DemoScript | undefined {
    const key = qaScriptKey(path);
    return this.state.scripts.find((s) => s.path === key);
  }

  private goal(id: string): Goal | undefined {
    return this.state.goals.find((g) => g.id === id && !g.archived);
  }

  private liveGoals(): Goal[] {
    return this.state.goals.filter((g) => !g.archived);
  }

  private runsOf(c: Pick<CheckRef, "kind" | "target">): RunRecord[] {
    const target = c.kind === "script" ? qaScriptKey(c.target) : c.target;
    return this.state.runs.filter((r) => r.kind === c.kind && r.target === target);
  }

  private goalIdsOf(id: string): string[] {
    return this.liveGoals().filter((g) => g.checks.some((c) => checkId(c) === id)).map((g) => g.id);
  }

  private checkRef(id: string): CheckRef | null {
    const parsed = parseCheckId(id);
    if (!parsed) return null;
    for (const g of this.liveGoals()) {
      const c = g.checks.find((x) => checkId(x) === id);
      if (c) return c;
    }
    return parsed.kind === "script" && this.script(parsed.target) ? { kind: "script", target: qaScriptKey(parsed.target) } : null;
  }

  private checkState(c: CheckRef, acceptance: AcceptanceRule = DEFAULT_ACCEPTANCE): { state: CheckState; runs: RunRecord[] } {
    const runs = this.runsOf(c);
    const sc = c.kind === "script" ? this.script(c.target) : undefined;
    const state = checkStateOf({
      check: c,
      runs,
      missing: c.kind === "script" && (!sc || !!sc.missing),
      acceptance,
      now: this.now(),
      goalIds: this.goalIdsOf(checkId(c)),
      name: sc?.name,
      map: sc?.map ?? null,
      steps: sc?.steps.length ?? null,
    });
    return { state, runs };
  }

  private goalState(g: Goal, depth = 0): GoalState {
    const checks = g.checks.map((c) => this.checkState(c, g.acceptance));
    const children = g.kind === "milestone" && depth === 0 ? this.liveGoals().filter((x) => x.parent === g.id) : [];
    const childStatuses: GoalStatus[] = children.map((x) => this.goalState(x, 1).status);
    const { status, progress } = goalStatus(g, checks, childStatuses);
    return { goal: g, status, checks: checks.map((c) => c.state), progress, children: children.map((x) => x.id) };
  }

  /** Every known check: the ones goals name, then the project's scripts no goal names. */
  private allChecks(): CheckState[] {
    const seen = new Map<string, CheckState>();
    for (const g of this.liveGoals()) for (const c of g.checks) if (!seen.has(checkId(c))) seen.set(checkId(c), this.checkState(c, g.acceptance).state);
    for (const sc of this.state.scripts) {
      const id = checkId({ kind: "script", target: sc.path });
      if (!sc.missing && !seen.has(id)) seen.set(id, this.checkState({ kind: "script", target: sc.path }).state);
    }
    return [...seen.values()].sort((a, b) => CHECK_HEALTH_ORDER.indexOf(a.health) - CHECK_HEALTH_ORDER.indexOf(b.health) || a.name.localeCompare(b.name));
  }

  overview(): HubOverview {
    const goals = this.liveGoals().map((g) => this.goalState(g));
    const checks = this.allChecks();
    return {
      goalsDir: HUB_GOALS_DIR,
      goals,
      checks,
      inbox: this.inbox(goals, checks),
      queue: this.queueState(),
      recent: this.state.runs.slice(0, 30),
      editor: { connected: this.state.editor },
      warnings: [],
    };
  }

  queueState(): QueueState {
    const s = this.state;
    return { paused: s.paused, current: s.current, queued: s.queued, recent: s.recent.slice(0, 20), schedules: s.schedules, editor: { connected: s.editor } };
  }

  private inbox(goals: GoalState[], checks: CheckState[]): InboxItem[] {
    const items: InboxItem[] = [];
    for (const c of checks) {
      const last = c.last;
      if (!last) continue;
      const run = this.state.qa[last.runId];
      for (const st of run?.steps ?? []) {
        if (st.status !== "awaiting_verdict") continue;
        items.push({
          id: `verdict:${last.runId}:${st.index}`,
          kind: "verdict",
          at: iso(Date.parse(last.startedAt) + (st.startedAtMs ?? 0)),
          title: `Judge step ${st.index + 1} of ${c.name}`,
          goalIds: c.goalIds,
          runId: last.runId,
          step: st.index,
          instruction: st.instruction,
          checkId: c.id,
          ...(last.planRunId ? { planRunId: last.planRunId } : {}),
        });
      }
      const loop = run?.assignment?.loop;
      if (loop?.state === "needs_you") {
        items.push({ id: `loop_blocked:${last.runId}`, kind: "loop_blocked", at: loop.endedAt ?? last.startedAt, title: `The fix loop on ${c.name} needs you`, detail: loop.blocker?.reason, goalIds: c.goalIds, runId: last.runId, checkId: c.id, ...(loop.blocker?.step !== undefined ? { step: loop.blocker.step } : {}) });
      }
      const done = this.runsOf(c.check).filter((r) => FINISHED_OUTCOMES.includes(r.outcome));
      if (done[0]?.outcome === "failed" && done[1]?.outcome === "passed" && loop?.state !== "needs_you") {
        const failedStep = done[0].failedSteps?.[0];
        const sc = this.script(c.check.target);
        items.push({ id: `regression:${done[0].runId}`, kind: "regression", at: done[0].endedAt ?? done[0].startedAt, title: `${c.name} failed after passing`, ...(failedStep !== undefined && sc ? { detail: `Step ${failedStep + 1}: ${sc.steps[failedStep]?.instruction ?? ""}` } : {}), goalIds: c.goalIds, runId: done[0].runId, checkId: c.id, ...(failedStep !== undefined ? { step: failedStep } : {}) });
      }
    }
    for (const g of goals) {
      if (g.goal.acceptance.signOff && !g.goal.signOff && g.progress.total > 0 && g.progress.met === g.progress.total) {
        items.push({ id: `sign_off:${g.goal.id}`, kind: "sign_off", at: g.goal.updatedAt, title: `Sign off "${g.goal.title}"`, detail: "Every required check passes.", goalIds: [g.goal.id] });
      }
      for (const c of g.checks) {
        if (c.health !== "missing") continue;
        items.push({ id: `missing_check:${g.goal.id}:${c.id}`, kind: "missing_check", at: g.goal.updatedAt, title: `${c.name} is missing`, detail: `"${g.goal.title}" names a script the project no longer has.`, goalIds: [g.goal.id], checkId: c.id });
      }
    }
    for (const p of this.state.recent.slice(0, 5)) {
      if (p.state !== "failed") continue;
      items.push({ id: `plan_failed:${p.id}`, kind: "plan_failed", at: p.endedAt ?? p.createdAt, title: `"${p.title}" stopped after a failure`, goalIds: p.scope.kind === "goal" ? [p.scope.goalId] : [], planRunId: p.id });
    }
    return items.sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  private page(runs: RunRecord[], q: URLSearchParams): { runs: RunRecord[]; more: boolean } {
    const limit = Math.max(1, Math.min(200, Number(q.get("limit")) || 50));
    const before = q.get("before");
    let list = runs;
    if (before) {
      const i = runs.findIndex((r) => r.runId === before);
      list = i >= 0 ? runs.slice(i + 1) : runs.filter((r) => r.startedAt < before);
    }
    return { runs: list.slice(0, limit), more: list.length > limit };
  }

  private checkDetail(id: string, q: URLSearchParams): DemoAnswer {
    const ref = this.checkRef(id) ?? (parseCheckId(id) as CheckRef | null);
    if (!ref) return refuse(404, "No such check");
    const goal = this.liveGoals().find((g) => g.checks.some((c) => checkId(c) === id));
    const { state, runs } = this.checkState(ref, goal?.acceptance);
    if (state.missing && runs.length === 0 && !goal) return refuse(404, "No such check");
    const sc = ref.kind === "script" ? this.script(ref.target) : undefined;
    const detail: CheckDetail = { state, ...this.page(runs, q), script: sc && !sc.missing ? this.draftOf(sc) : null };
    return ok(detail);
  }

  private runList(q: URLSearchParams): DemoAnswer {
    const check = q.get("check");
    const ref = check ? parseCheckId(check) : null;
    const runs = ref ? this.runsOf(ref) : this.state.runs;
    return ok(this.page(runs, q));
  }

  /** A run's QaRun: the one kept, or one drawn from its record. */
  private qaRun(runId: string): QaRun | null {
    const kept = this.state.qa[runId];
    if (kept) return kept;
    if (runId.startsWith("draft:")) {
      const sc = this.script(runId.slice("draft:".length));
      return sc ? this.draftOf(sc) : null;
    }
    const r = this.state.runs.find((x) => x.runId === runId);
    if (!r) return null;
    const sc = this.script(r.target);
    return sc ? demoQaRun(sc, r) : null;
  }

  private draftOf(sc: DemoScript): QaRun {
    return qaDraftFromScript({ path: sc.path, name: sc.name, map: sc.map, steps: sc.steps }, { seenAt: iso(this.now()) })!;
  }

  runDetail(runId: string): RunDetail | null {
    const record = this.state.runs.find((r) => r.runId === runId);
    if (!record) return null;
    const run = this.qaRun(runId);
    const steps = (run?.steps ?? []).map((st) => ({ index: st.index, instruction: st.instruction, status: st.status, judge: st.judge, startMs: st.startedAtMs ?? null, endMs: st.endedAtMs ?? null }));
    const older = this.runsOf(record).filter((r) => r.startedAt < record.startedAt);
    const lastPass = older.find((r) => r.outcome === "passed") ?? null;
    const before = lastPass ? this.qaRun(lastPass.runId) : null;
    const changedSteps = before && run ? run.steps.filter((st) => before.steps[st.index] && before.steps[st.index].status !== st.status).map((st) => st.index) : [];
    return {
      record,
      run,
      steps,
      series: run ? this.series(run) : {},
      log: run ? this.log(run) : [],
      lastPass,
      changedSteps,
      resultsUrl: `${BASE}/qa/runs/${encodeURIComponent(runId)}/results`,
    };
  }

  /** The observer's values for each auto step, drawn as plausible curves through its evidence. */
  private series(run: QaRun): Record<string, Array<[number, number]>> {
    const out: Record<string, Array<[number, number]>> = {};
    const nowMs = this.now() - Date.parse(run.seenAt);
    for (const st of run.steps) {
      if (st.judge !== "auto" || !st.expect || st.startedAtMs === undefined) continue;
      const settled = st.status === "passed" || st.status === "failed";
      const ev = settled ? (st.evidence as Record<string, unknown> | undefined) : (demoEvidence(st as unknown as QaScriptStep, true, run.runId, st.index) as Record<string, unknown>);
      const a = Number(ev?.at_start ?? 0);
      const z = Number(ev?.at_end ?? a);
      const start = st.startedAtMs;
      const end = st.endedAtMs ?? Math.max(start + 100, nowMs);
      const window = settled ? end - start : st.withinMs ?? 3000;
      const binary = st.expect.op === "visible" || st.expect.op === "exists" || typeof st.expect.target === "boolean";
      const stepped = binary || st.expect.op === "eq";
      const rand = demoRandom(demoHash(`${run.runId}:${st.index}:s`));
      const amp = binary ? 0 : Math.abs(z - a) * 0.03 + (stepped ? 0 : 0.2);
      const points: Array<[number, number]> = [];
      const stride = Math.max(50, Math.round((end - start + 300) / 60));
      for (let t = Math.max(0, start - 300); t <= end; t += stride) {
        const u = Math.min(1, Math.max(0, (t - start) / Math.max(1, window)));
        const shape = stepped ? (u > 0.55 ? 1 : 0) : 1 - (1 - u) * (1 - u);
        const v = a + (z - a) * shape + (rand() - 0.5) * amp;
        points.push([t, Math.round(v * 100) / 100]);
      }
      out[st.expect.value] = [...(out[st.expect.value] ?? []), ...points];
    }
    return out;
  }

  private log(run: QaRun): Array<{ atMs: number; level: "warning" | "error"; text: string }> {
    const rand = demoRandom(demoHash(`${run.runId}:log`));
    const out: Array<{ atMs: number; level: "warning" | "error"; text: string }> = [];
    const last = Math.max(1000, ...run.steps.map((s) => s.endedAtMs ?? s.startedAtMs ?? 0));
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) out.push({ atMs: Math.round(rand() * last), level: "warning", text: NOISE[Math.floor(rand() * NOISE.length)] });
    for (const st of run.steps) {
      if (st.status !== "failed" || st.judge !== "auto") continue;
      const reason = (st.evidence as Record<string, unknown> | undefined)?.reason;
      out.push({ atMs: st.endedAtMs ?? last, level: "error", text: FAILURE_LOG[run.scriptName] ?? `LogPIEScript: Error: Step ${st.index + 1} failed: ${typeof reason === "string" ? reason : st.instruction}` });
    }
    return out.sort((x, y) => x.atMs - y.atMs);
  }

  private playtests() {
    const entries = this.state.scripts
      .filter((sc) => !sc.missing || this.runsOf({ kind: "script", target: sc.path }).length > 0)
      .map((sc) => {
        const newest = this.runsOf({ kind: "script", target: sc.path })[0];
        return { script: sc.path, name: sc.name, last: newest ? this.qaRun(newest.runId) : null, card: null, draft: sc.missing ? null : this.draftOf(sc), session: null, ...(sc.missing ? { deleted: true } : {}) };
      });
    return { playtests: entries, listed: true };
  }

  /** Runs the hub started that are live or waiting on a person. */
  private unownedRuns(): QaRun[] {
    const live = this.state.live ? [this.state.qa[this.state.live.runId]] : [];
    const waiting = Object.values(this.state.qa).filter((r) => r.awaiting.length > 0 && r.runId !== this.state.live?.runId);
    return [...live, ...waiting].filter(Boolean);
  }

  /** A run as pie(script_status) answers it, snake_case. */
  private answerOf(run: QaRun): Record<string, unknown> {
    return {
      success: true,
      run_id: run.runId,
      script: run.script,
      script_name: run.scriptName,
      state: run.state,
      last_seq: run.lastSeq,
      results_path: run.resultsPath,
      awaiting: run.awaiting,
      summary: run.summary,
      steps: run.steps.map((st) => ({
        index: st.index,
        instruction: st.instruction,
        judge: st.judge,
        status: st.status,
        ...(st.expect ? { expect: st.expect } : {}),
        ...(st.withinMs !== undefined ? { within_ms: st.withinMs } : {}),
        ...(st.startedAtMs !== undefined ? { started_at_ms: st.startedAtMs } : {}),
        ...(st.endedAtMs !== undefined ? { ended_at_ms: st.endedAtMs } : {}),
        ...(st.evidence ? { evidence: st.evidence } : {}),
        ...(st.note ? { note: st.note } : {}),
        ...(st.verdictSource ? { verdict_source: st.verdictSource } : {}),
      })),
    };
  }

  // ---------- Goals ----------

  private createGoal(d: GoalDraft): DemoAnswer {
    const title = typeof d.title === "string" ? d.title.trim() : "";
    if (!title) return refuse(400, "A goal needs a title");
    if (d.parent && this.goal(d.parent)?.kind !== "milestone") return refuse(400, "A goal can only belong to a milestone");
    let id = d.id && GOAL_ID.test(d.id) ? d.id : goalSlug(title);
    for (let n = 2; this.state.goals.some((g) => g.id === id); n++) id = `${goalSlug(title).slice(0, 60)}-${n}`;
    const now = iso(this.now());
    const goal: Goal = {
      schema: HUB_SCHEMA,
      id,
      kind: d.kind === "milestone" ? "milestone" : "goal",
      title,
      ...(d.description ? { description: d.description } : {}),
      parent: d.kind === "milestone" ? null : d.parent ?? null,
      owner: d.owner ?? DEMO_USER,
      priority: d.priority ?? "p2",
      tags: d.tags ?? [],
      due: d.due ?? null,
      acceptance: { ...DEFAULT_ACCEPTANCE, ...d.acceptance },
      checks: (d.checks ?? []).map((c) => ({ ...c, target: c.kind === "script" ? qaScriptKey(c.target) : c.target })),
      signOff: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.goals.push(goal);
    this.hubChanged(["goals"], { goalId: id });
    return ok({ goal });
  }

  private touch(g: Goal, what: HubChangedWhat[] = ["goals"]): DemoAnswer {
    g.updatedAt = iso(this.now());
    this.hubChanged(what, { goalId: g.id });
    return ok({ goal: g });
  }

  private updateGoal(id: string, u: GoalUpdate): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    if (u.parent && (this.goal(u.parent)?.kind !== "milestone" || u.parent === id)) return refuse(400, "A goal can only belong to a milestone");
    if (u.title !== undefined && !String(u.title).trim()) return refuse(400, "A goal needs a title");
    const { acceptance, checks, ...rest } = u;
    Object.assign(g, rest);
    if (acceptance) g.acceptance = { ...g.acceptance, ...acceptance };
    if (checks) g.checks = checks.map((c) => ({ ...c, target: c.kind === "script" ? qaScriptKey(c.target) : c.target }));
    return this.touch(g, ["goals", "checks"]);
  }

  private deleteGoal(id: string): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    this.state.goals = this.state.goals.filter((x) => x.id !== id);
    for (const x of this.state.goals) if (x.parent === id) x.parent = null;
    this.hubChanged(["goals", "checks", "inbox"], { goalId: id });
    return ok(undefined, 204);
  }

  private addChecks(id: string, checks: CheckRef[]): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    for (const c of checks) {
      if (!c || typeof c.target !== "string" || !c.kind) continue;
      const ref = { ...c, target: c.kind === "script" ? qaScriptKey(c.target) : c.target };
      if (!g.checks.some((x) => checkId(x) === checkId(ref))) g.checks.push(ref);
    }
    return this.touch(g, ["goals", "checks"]);
  }

  private removeCheck(id: string, cid: string): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    g.checks = g.checks.filter((c) => checkId(c) !== cid);
    return this.touch(g, ["goals", "checks", "inbox"]);
  }

  private signOff(id: string, note: string | undefined, clear = false): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    g.signOff = clear ? null : { by: DEMO_USER, at: iso(this.now()), ...(note ? { note } : {}) };
    return this.touch(g, ["goals", "inbox"]);
  }

  private writePlaytests(id: string): DemoAnswer {
    const g = this.goal(id);
    if (!g) return refuse(404, "No such goal");
    const sessionId = `hub-write-${this.state.counter++}`;
    this.state.jobs.push({ at: this.now() + this.ms(5000 + this.random() * 3000), kind: "write", goalId: id, sessionId });
    return ok({ sessionId }, 202);
  }

  /** The agent's new scripts arrive, linked to the goal. */
  private writeScripts(goalId: string): void {
    const g = this.goal(goalId);
    if (!g) return;
    const drafts = demoWrittenScripts(g, this.random() < 0.5 ? 2 : 3);
    for (const d of drafts) {
      let path = `${DEMO_SCRIPTS_DIR}/Generated/${d.name}`;
      let name = d.name;
      for (let n = 2; this.script(path); n++) {
        name = `${d.name}_${n}`;
        path = `${DEMO_SCRIPTS_DIR}/Generated/${name}`;
      }
      const map = this.state.scripts[0]?.map ?? "/Game/EmberHollow/Maps/L_Ashwood";
      this.state.scripts.push({ path, name, map, steps: d.steps, author: "Studio agent", tags: g.tags ?? [], profile: { fixable: true, flakyStep: this.random() < 0.3 ? 0 : null, flakyRate: 0.25 } });
      g.checks.push({ kind: "script", target: path });
    }
    g.updatedAt = iso(this.now());
    this.hubChanged(["checks", "goals"], { goalId });
  }

  // ---------- Scripts ----------

  private saveScript(idOrPath: string, steps: unknown, map: string | undefined, by: "path" | "run"): DemoAnswer {
    const path = by === "run" ? (idOrPath.startsWith("draft:") ? idOrPath.slice("draft:".length) : this.state.runs.find((r) => r.runId === idOrPath)?.target ?? "") : qaScriptKey(idOrPath);
    if (!path.startsWith("/Game/")) return refuse(400, "A script path starts with /Game/");
    if (!Array.isArray(steps) || steps.length === 0) return refuse(400, "A script needs at least one step");
    const clean = (steps as QaScriptStep[]).map((st) => ({ ...st, instruction: String(st.instruction ?? ""), judge: st.judge === "manual" ? "manual" as const : "auto" as const }));
    let sc = this.script(path);
    if (sc) {
      sc.steps = clean;
      if (map !== undefined) sc.map = map;
      delete sc.missing;
    } else {
      sc = { path, name: leafName(path), map: map ?? "/Game/EmberHollow/Maps/L_Ashwood", steps: clean, author: DEMO_USER, tags: [], profile: { fixable: true } };
      this.state.scripts.push(sc);
    }
    this.hubChanged(["checks", "goals"]);
    return by === "run" ? ok({ run: this.draftOf(sc) }) : ok({ script: sc.path });
  }

  private deleteScript(idOrPath: string, by: "path" | "run"): DemoAnswer {
    const path = by === "run" ? (idOrPath.startsWith("draft:") ? idOrPath.slice("draft:".length) : this.state.runs.find((r) => r.runId === idOrPath)?.target ?? "") : idOrPath;
    const sc = this.script(path);
    if (!sc || sc.missing) return refuse(404, "No such script");
    sc.missing = true;
    this.hubChanged(["checks", "goals", "inbox"]);
    return by === "run" ? ok({ run: { ...this.draftOf(sc), deleted: true } }) : ok({ script: sc.path });
  }

  // ---------- Plans and the queue ----------

  private scopeChecks(scope: PlanRequest["scope"]): CheckRef[] {
    const subtree = (goalId?: string): Goal[] => (goalId ? this.liveGoals().filter((g) => g.id === goalId || g.parent === goalId) : this.liveGoals());
    const unique = (refs: CheckRef[]) => {
      const seen = new Set<string>();
      return refs.filter((c) => !seen.has(checkId(c)) && !!seen.add(checkId(c)));
    };
    switch (scope?.kind) {
      case "goal":
        return unique(subtree(scope.goalId).flatMap((g) => g.checks));
      case "checks":
        return unique(Array.isArray(scope.checks) ? scope.checks : []);
      case "failing":
      case "stale": {
        const want = scope.kind === "failing" ? "failing" : "stale";
        const pool = scope.goalId ? new Set(subtree(scope.goalId).flatMap((g) => g.checks.map(checkId))) : null;
        return this.allChecks().filter((c) => c.health === want && (!pool || pool.has(c.id))).map((c) => c.check);
      }
      case "all":
        return this.state.scripts.filter((sc) => !sc.missing).map((sc) => ({ kind: "script" as const, target: sc.path }));
      default:
        return [];
    }
  }

  private planTitle(scope: PlanRequest["scope"], refs: CheckRef[]): string {
    const goalTitle = (id?: string) => (id ? this.goal(id)?.title : undefined);
    switch (scope.kind) {
      case "goal":
        return `Run ${goalTitle(scope.goalId) ?? "goal"}`;
      case "checks":
        return refs.length === 1 ? `Run ${this.nameOf(refs[0])}` : `Run ${refs.length} checks`;
      case "failing":
        return scope.goalId ? `Run failing in ${goalTitle(scope.goalId) ?? "goal"}` : "Run failing checks";
      case "stale":
        return scope.goalId ? `Run stale in ${goalTitle(scope.goalId) ?? "goal"}` : "Run stale checks";
      default:
        return "Run every check";
    }
  }

  private nameOf(c: CheckRef): string {
    return c.title ?? (c.kind === "script" ? this.script(c.target)?.name : undefined) ?? leafName(c.target);
  }

  private makePlan(req: PlanRequest, trigger: PlanTrigger, scheduleId: string | null = null): PlanRun | null {
    const refs = this.scopeChecks(req.scope);
    if (refs.length === 0) return null;
    const items: PlanItem[] = refs.map((c) => ({ check: c, name: this.nameOf(c), state: "queued" }));
    return {
      id: `plan-${this.state.counter++}`,
      title: req.title?.trim() || this.planTitle(req.scope, refs),
      scope: req.scope,
      options: { ...DEFAULT_PLAN_OPTIONS, ...req.options },
      state: "queued",
      items,
      trigger,
      scheduleId,
      createdAt: iso(this.now()),
      startedAt: null,
      endedAt: null,
    };
  }

  private plan(req: PlanRequest, trigger: PlanTrigger): DemoAnswer {
    if (!req?.scope?.kind) return refuse(400, "A plan needs a scope");
    const plan = this.makePlan(req, trigger);
    if (!plan) return refuse(409, "Nothing to run in that scope");
    this.state.queued.push(plan);
    this.hubChanged(["queue"], { planRunId: plan.id });
    return ok({ plan });
  }

  private cancelPlan(id: string): DemoAnswer {
    const s = this.state;
    const plan = s.current?.id === id ? s.current : s.queued.find((p) => p.id === id);
    if (!plan) return refuse(404, "No such plan in the queue");
    if (s.current === plan && s.live?.planId === id) this.endLive("stopped", "cancelled", "Cancelled");
    for (const it of plan.items) if (it.state === "queued" || it.state === "running") it.state = "cancelled";
    plan.state = "cancelled";
    plan.endedAt = iso(this.now());
    if (s.current === plan) s.current = null;
    s.queued = s.queued.filter((p) => p !== plan);
    s.recent = [plan, ...s.recent].slice(0, 20);
    this.hubChanged(["queue", "runs"], { planRunId: id });
    return ok({ plan });
  }

  private movePlan(id: string, to: number): DemoAnswer {
    const s = this.state;
    const i = s.queued.findIndex((p) => p.id === id);
    if (i < 0) return refuse(404, "No such plan waiting");
    if (!Number.isFinite(to)) return refuse(400, "Say where to move it");
    const [plan] = s.queued.splice(i, 1);
    s.queued.splice(Math.max(0, Math.min(s.queued.length, Math.round(to))), 0, plan);
    this.hubChanged(["queue"], { planRunId: id });
    return ok(this.queueState());
  }

  private pause(paused: boolean): DemoAnswer {
    const s = this.state;
    s.paused = paused;
    if (!paused && s.current?.state === "paused") s.current.state = "running";
    if (paused && s.current && !s.live) s.current.state = "paused";
    this.hubChanged(["queue"]);
    return ok(this.queueState());
  }

  /** Start the next item of the current plan, finish it, or take the next plan. */
  private advanceQueue(): void {
    const s = this.state;
    const cur = s.current;
    if (!cur) {
      if (s.queued.length === 0 || s.paused || !s.editor) return;
      const next = s.queued.shift()!;
      next.state = "running";
      next.startedAt = iso(this.now());
      s.current = next;
      this.hubChanged(["queue"], { planRunId: next.id });
      return;
    }
    const item = cur.items.find((i) => i.state === "queued");
    if (!item) {
      this.finishPlan(cur);
      return;
    }
    if (s.paused) {
      if (cur.state !== "paused") {
        cur.state = "paused";
        this.hubChanged(["queue"], { planRunId: cur.id });
      }
      return;
    }
    if (!s.editor) return;
    cur.state = "running";
    const sc = item.check.kind === "script" ? this.script(item.check.target) : undefined;
    if (!sc || sc.missing) {
      item.state = "skipped";
      item.reason = item.check.kind === "script" ? "The script is missing from the project" : "This kind of check does not run yet";
      this.hubChanged(["queue"], { planRunId: cur.id });
      return;
    }
    item.state = "running";
    item.startedAt = iso(this.now());
    item.runId = this.startRun(sc, cur.trigger === "schedule" ? "schedule" : "plan", cur).runId;
  }

  private finishPlan(cur: PlanRun): void {
    const s = this.state;
    if (cur.state !== "failed") cur.state = "done";
    cur.endedAt = iso(this.now());
    s.current = null;
    s.recent = [cur, ...s.recent].slice(0, 20);
    this.hubChanged(["queue", "inbox"], { planRunId: cur.id });
  }

  /** Where a plan's item stands now its run has moved. */
  private syncItem(runId: string): void {
    const rec = this.state.runs.find((r) => r.runId === runId);
    if (!rec) return;
    for (const p of [this.state.current, ...this.state.recent]) {
      const it = p?.items.find((i) => i.runId === runId);
      if (!p || !it || it.state === "cancelled" || it.state === "error") continue;
      it.state = rec.outcome === "passed" ? "passed" : rec.outcome === "failed" ? "failed" : rec.outcome === "needs_you" ? "needs_you" : rec.outcome === "running" ? "running" : "error";
      if (rec.endedAt) it.endedAt = rec.endedAt;
      if (it.state === "failed" && p === this.state.current && p.options.stopOnFailure) {
        for (const rest of p.items) if (rest.state === "queued") {
          rest.state = "skipped";
          rest.reason = "Skipped after a failure";
        }
        p.state = "failed";
      }
    }
  }

  private dueSchedules(now: number): void {
    for (const sch of this.state.schedules) {
      if (!sch.enabled || !sch.nextRunAt || Date.parse(sch.nextRunAt) > now) continue;
      if (!this.state.editor) sch.lastSkipped = "The editor was not connected";
      else {
        const plan = this.makePlan({ title: sch.title, scope: sch.scope, options: sch.options }, "schedule", sch.id);
        if (plan) {
          this.state.queued.push(plan);
          sch.lastRunAt = iso(now);
          sch.lastSkipped = null;
        } else sch.lastSkipped = "Nothing to run";
      }
      sch.nextRunAt = demoNextRun(sch, now);
      this.hubChanged(["queue"]);
    }
  }

  private createSchedule(d: ScheduleDraft): DemoAnswer {
    if (!d?.title?.trim() || !/^\d{2}:\d{2}$/.test(d.at ?? "") || !Array.isArray(d.days) || !d.scope?.kind) return refuse(400, "A schedule needs a title, a time (HH:MM), days and a scope");
    const sch: Schedule = { id: `sched-${this.state.counter++}`, title: d.title.trim(), scope: d.scope, options: { ...DEFAULT_PLAN_OPTIONS, ...d.options }, at: d.at, days: d.days, enabled: d.enabled !== false, lastRunAt: null, lastSkipped: null, nextRunAt: null };
    sch.nextRunAt = demoNextRun(sch, this.now());
    this.state.schedules.push(sch);
    this.hubChanged(["queue"]);
    return ok({ schedule: sch });
  }

  private updateSchedule(id: string, u: Partial<ScheduleDraft>): DemoAnswer {
    const sch = this.state.schedules.find((x) => x.id === id);
    if (!sch) return refuse(404, "No such schedule");
    if (u.at !== undefined && !/^\d{2}:\d{2}$/.test(u.at)) return refuse(400, "The time is HH:MM");
    Object.assign(sch, u, u.options ? { options: { ...sch.options, ...u.options } } : {});
    sch.nextRunAt = demoNextRun(sch, this.now());
    this.hubChanged(["queue"]);
    return ok({ schedule: sch });
  }

  // ---------- Runs ----------

  private startRun(sc: DemoScript, source: RunSource, plan: PlanRun | null): RunRecord {
    const s = this.state;
    const now = this.now();
    const runId = demoRunId(sc.name, now, s.counter++);
    const steps: QaStep[] = sc.steps.map((st, index) => ({
      index,
      instruction: st.instruction,
      judge: st.judge,
      ...(st.expect ? { expect: st.expect } : {}),
      status: "pending",
      withinMs: st.expect?.within_ms ?? 5000,
      ...(st.player ? { player: st.player } : {}),
      ...(st.judge === "manual" && st.agent_judgeable === false ? { agentJudgeable: false } : {}),
    }));
    const run: QaRun = { runId, script: sc.path, scriptName: sc.name, map: sc.map, state: "armed", steps, awaiting: [], lastSeq: 0, summary: qaSummaryOf(steps), resultsPath: demoResultsPath(runId), sessionId: null, toolUseId: null, seenAt: iso(now) };
    const rec: RunRecord = { runId, kind: "script", target: sc.path, name: sc.name, outcome: "running", startedAt: iso(now), endedAt: null, durationMs: null, summary: run.summary, failedSteps: [], source, sessionId: null, planRunId: plan?.id ?? null, replayOf: null, recordingId: null, map: sc.map };
    s.runs.unshift(rec);
    s.qa[runId] = run;
    s.live = { runId, nextAt: now + this.ms(900), planId: plan?.id ?? null, manualSteps: plan?.options.manualSteps ?? "defer", blocked: false };
    this.scriptEvent(run, "run_started", { resultsPath: run.resultsPath });
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "goals", "queue"], { runId, ...(plan ? { planRunId: plan.id } : {}) });
    return rec;
  }

  /** Whether an auto step passes this time, by the script's profile. */
  private passes(sc: DemoScript | undefined, index: number): boolean {
    const p = sc?.profile ?? {};
    if (p.failStep === index) return false;
    if (p.flakyStep === index) return this.random() >= (p.flakyRate ?? 0.3);
    return this.random() >= 0.015;
  }

  /** The live run's next move: settle the running step, start the next, or finish. */
  private step(): void {
    const s = this.state;
    const live = s.live!;
    const run = s.qa[live.runId];
    const now = this.now();
    const atMs = now - Date.parse(run.seenAt);
    const sc = this.script(run.script);
    const going = run.steps.find((x) => x.status === "running");
    if (going) {
      if (going.judge === "auto") {
        const passed = this.passes(sc, going.index);
        going.status = passed ? "passed" : "failed";
        going.endedAtMs = atMs;
        going.verdictSource = "auto";
        going.evidence = demoEvidence(going as unknown as QaScriptStep, passed, run.runId, going.index) as QaStep["evidence"];
        this.refresh(run);
        this.scriptEvent(run, passed ? "step_passed" : "step_failed", { step: { ...going } });
      } else {
        going.status = "awaiting_verdict";
        if (live.manualSteps === "block") {
          run.state = "awaiting_verdict";
          live.blocked = true;
        }
        this.refresh(run);
        this.scriptEvent(run, "verdict_requested", { awaiting: [{ index: going.index, instruction: going.instruction }] });
      }
      live.nextAt = now + this.ms(500);
      this.syncRecord(run.runId);
      this.syncItem(run.runId);
      this.qaChanged(run);
      this.hubChanged(going.status === "awaiting_verdict" ? ["runs", "checks", "goals", "inbox"] : ["runs", "checks"], { runId: run.runId });
      return;
    }
    const next = run.steps.find((x) => x.status === "pending");
    if (next) {
      next.status = "running";
      next.startedAtMs = atMs;
      if (run.state === "armed") run.state = "running";
      this.refresh(run);
      this.scriptEvent(run, "step_started", { step: { ...next } });
      live.nextAt = now + this.ms(1000 + this.random() * 2000);
      this.qaChanged(run);
      this.hubChanged(["runs"], { runId: run.runId });
      return;
    }
    this.endLive("finished");
  }

  /** End the live run: finished, or stopped with what the plan item says about it. */
  private endLive(state: "finished" | "stopped", itemState?: PlanItem["state"], reason?: string): void {
    const s = this.state;
    const live = s.live;
    if (!live) return;
    const run = s.qa[live.runId];
    run.state = state;
    for (const st of run.steps) if (st.status === "running") st.status = "skipped";
    this.refresh(run);
    this.scriptEvent(run, "run_finished", { state, summary: run.summary, resultsPath: run.resultsPath });
    s.live = null;
    s.idleUntil = this.now() + this.ms(1200);
    this.syncRecord(run.runId);
    this.syncItem(run.runId);
    if (itemState) {
      const it = s.current?.items.find((i) => i.runId === run.runId);
      if (it) {
        it.state = itemState;
        if (reason) it.reason = reason;
        it.endedAt = iso(this.now());
      }
    }
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "goals", "inbox", "queue"], { runId: run.runId, ...(live.planId ? { planRunId: live.planId } : {}) });
  }

  /** Recount a run's summary and waiting steps. */
  private refresh(run: QaRun): void {
    run.summary = qaSummaryOf(run.steps);
    run.awaiting = run.steps.filter((x) => x.status === "awaiting_verdict").map((x) => x.index);
    if (run.state === "awaiting_verdict" && run.awaiting.length === 0) run.state = "running";
  }

  /** The run index entry, from its QaRun. */
  private syncRecord(runId: string): void {
    const rec = this.state.runs.find((r) => r.runId === runId);
    const run = this.state.qa[runId];
    if (!rec || !run) return;
    rec.outcome = outcomeOf(run);
    rec.summary = run.summary;
    rec.failedSteps = run.steps.filter((x) => x.status === "failed").map((x) => x.index);
    if (qaEnded(run.state) && !rec.endedAt) {
      const now = this.now();
      rec.endedAt = iso(now);
      rec.durationMs = now - Date.parse(rec.startedAt);
    }
  }

  private verdict(runId: string, step: number, verdict: string, note?: string): DemoAnswer {
    const s = this.state;
    if (!["pass", "fail", "skip"].includes(verdict)) return refuse(400, "The verdict is pass, fail or skip");
    let run = s.qa[runId];
    if (!run) {
      const drawn = this.qaRun(runId);
      if (!drawn || runId.startsWith("draft:")) return refuse(404, "No such run");
      run = s.qa[runId] = drawn;
    }
    const st = run.steps.find((x) => x.index === step);
    if (!st || st.judge !== "manual") return refuse(400, "That step takes no verdict");
    const now = this.now();
    st.status = verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : "skipped";
    st.verdictSource = "action";
    st.endedAtMs = st.endedAtMs ?? now - Date.parse(run.seenAt);
    if (note) st.note = note;
    this.refresh(run);
    this.scriptEvent(run, "verdict", { step: { ...st } });
    if (s.live?.runId === runId && s.live.blocked && run.awaiting.length === 0) {
      s.live.blocked = false;
      s.live.nextAt = now + this.ms(600);
    }
    this.syncRecord(runId);
    this.syncItem(runId);
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "goals", "inbox", "queue"], { runId });
    return ok({ run });
  }

  private stop(runId: string): DemoAnswer {
    if (this.state.live?.runId !== runId) return refuse(409, "That run is not playing");
    this.endLive("stopped", "cancelled", "Stopped");
    return ok({ run: this.state.qa[runId] });
  }

  /** Run a script now, from a card's Run: as a one-item plan, when the editor is free. */
  private runNow(runId: string): DemoAnswer {
    const s = this.state;
    const path = runId.startsWith("draft:") ? runId.slice("draft:".length) : s.qa[runId]?.script ?? s.runs.find((r) => r.runId === runId)?.target;
    const sc = path ? this.script(path) : undefined;
    if (!sc || sc.missing) return refuse(404, "No such script");
    if (!s.editor) return refuse(409, "The editor is not connected");
    if (s.live || s.current) return refuse(409, "Another run has the editor. Queue this one from the hub.");
    const plan = this.makePlan({ scope: { kind: "checks", checks: [{ kind: "script", target: sc.path }] } }, "person")!;
    plan.state = "running";
    plan.startedAt = iso(this.now());
    s.current = plan;
    const item = plan.items[0];
    item.state = "running";
    item.startedAt = plan.startedAt;
    item.runId = this.startRun(sc, "person", plan).runId;
    return ok({ run: s.qa[item.runId] });
  }

  // ---------- Fix loops ----------

  private assign(runId: string): DemoAnswer {
    const s = this.state;
    let run = s.qa[runId];
    if (!run) {
      const drawn = this.qaRun(runId);
      if (!drawn || runId.startsWith("draft:")) return refuse(404, "No such run");
      run = s.qa[runId] = drawn;
    }
    if (run.assignment?.state === "running") return refuse(409, "A fix loop is already on this run");
    if (s.live?.runId === runId) return refuse(409, "The run is still playing");
    const now = iso(this.now());
    const callId = `agent-${s.counter++}`;
    const failing = run.steps.filter((x) => x.status === "failed").map((x) => `Step ${x.index + 1}: ${x.instruction}`);
    run.assignment = {
      callId,
      sessionId: "hub-demo",
      state: "running",
      at: now,
      loop: { id: `loop-${callId}`, state: "running", baseline: `cp-${callId}-0`, startedAt: now, attempts: [{ n: 1, callId, before: `cp-${callId}-0`, changes: [], failing, startedAt: now }] },
    };
    s.loopQueue.push(runId);
    this.pumpLoops();
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "inbox"], { runId });
    return ok({ run });
  }

  private pumpLoops(): void {
    const s = this.state;
    if (s.loopActive || s.loopQueue.length === 0) return;
    s.loopActive = s.loopQueue.shift()!;
    s.jobs.push({ at: this.now() + this.ms(6000 + this.random() * 4000), kind: "loop", runId: s.loopActive });
  }

  /** A fix loop ends: fixed, with a passing run, or stopped for a person. */
  private settleLoop(runId: string): void {
    const s = this.state;
    if (s.loopActive === runId) s.loopActive = null;
    const run = s.qa[runId];
    const loop = run?.assignment?.loop;
    if (!run || !loop || loop.state !== "running") {
      this.pumpLoops();
      return;
    }
    const sc = this.script(run.script);
    const now = this.now();
    const attempt = loop.attempts[loop.attempts.length - 1];
    const failedAt = run.steps.find((x) => x.status === "failed");
    const asset = `Content/EmberHollow/${sc?.path.split("/").slice(-2, -1)[0] ?? "Gameplay"}/BP_${(sc?.name ?? "Fix").replace(/^PT_/, "")}.uasset`;
    attempt.changes = [{ path: asset, status: "modified" }];
    attempt.after = `cp-${attempt.callId}-1`;
    attempt.endedAt = iso(now);
    if (sc && sc.profile.fixable !== false) {
      sc.profile = { ...sc.profile, failStep: null, flakyStep: null };
      const rec = this.passingRun(sc, now - 20_000);
      attempt.runId = rec.runId;
      attempt.failing = [];
      loop.state = "passed";
    } else {
      loop.state = "needs_you";
      loop.blocker = {
        kind: "no_progress",
        reason: `The attempt changed ${asset.split("/").pop()} and step ${(failedAt?.index ?? 0) + 1} still fails. The rule it checks needs a design decision before another try.`,
        evidence: failedAt ? [`Step ${failedAt.index + 1}: ${failedAt.instruction}`] : [],
        ...(failedAt ? { step: failedAt.index } : {}),
      };
    }
    loop.endedAt = iso(now);
    run.assignment = { ...run.assignment!, state: "done" };
    this.pumpLoops();
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "goals", "inbox"], { runId });
  }

  /** The run a successful fix loop made: every step passed. */
  private passingRun(sc: DemoScript, at: number): RunRecord {
    const runId = demoRunId(sc.name, at, this.state.counter++);
    const total = sc.steps.length;
    const rec: RunRecord = { runId, kind: "script", target: sc.path, name: sc.name, outcome: "passed", startedAt: iso(at), endedAt: iso(at + 15_000), durationMs: 15_000, summary: { total, passed: total, failed: 0, skipped: 0, pending: 0, awaiting: 0 }, failedSteps: [], source: "agent", sessionId: "hub-demo", planRunId: null, replayOf: null, recordingId: null, map: sc.map };
    this.state.runs.unshift(rec);
    this.state.runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    this.state.qa[runId] = { ...demoQaRun(sc, rec), sessionId: "hub-demo" };
    return rec;
  }

  private cancelLoop(runId: string): DemoAnswer {
    const s = this.state;
    const run = s.qa[runId];
    const loop = run?.assignment?.loop;
    if (!run || !loop || loop.state !== "running") return refuse(409, "No fix loop is running on this run");
    loop.state = "stopped";
    loop.endedAt = iso(this.now());
    run.assignment = { ...run.assignment!, state: "stopped" };
    s.loopQueue = s.loopQueue.filter((x) => x !== runId);
    if (s.loopActive === runId) {
      s.loopActive = null;
      s.jobs = s.jobs.filter((j) => !(j.kind === "loop" && j.runId === runId));
      this.pumpLoops();
    }
    this.qaChanged(run);
    this.hubChanged(["runs", "checks", "inbox"], { runId });
    return ok({ run });
  }

  private assignFailing(goalId?: string): DemoAnswer {
    if (goalId && !this.goal(goalId)) return refuse(404, "No such goal");
    const pool = goalId ? new Set(this.liveGoals().filter((g) => g.id === goalId || g.parent === goalId).flatMap((g) => g.checks.map(checkId))) : null;
    let queued = 0;
    for (const c of this.allChecks()) {
      if (c.health !== "failing" || !c.last || (pool && !pool.has(c.id))) continue;
      if (this.state.qa[c.last.runId]?.assignment?.state === "running") continue;
      if (this.assign(c.last.runId).status === 200) queued++;
    }
    return ok({ queued });
  }

  // ---------- Events ----------

  private emit(type: string, data: Record<string, unknown>): void {
    this.dirty = true;
    this.sink(type, JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }

  private scriptEvent(run: QaRun, type: string, extra: Record<string, unknown>): void {
    run.lastSeq += 1;
    const now = this.now();
    this.emit(`script.${type}`, { runId: run.runId, script: run.script, at: iso(now), atMs: Math.max(0, now - Date.parse(run.seenAt)), seq: run.lastSeq, ...extra });
  }

  private qaChanged(run: QaRun): void {
    this.emit("studio.qa.changed", { runId: run.runId, run });
  }

  private hubChanged(what: HubChangedWhat[], ids: { goalId?: string; runId?: string; planRunId?: string } = {}): void {
    this.emit(HUB_CHANGED, { what, ...ids });
  }
}
