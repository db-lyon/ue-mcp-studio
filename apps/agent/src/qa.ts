/**
 * PIE test script runs, shown in the chat as a checklist card. Under /v1/ext/studio:
 *
 *   GET    /qa/runs                     runs started outside Studio's sessions, which every open chat shows
 *   GET    /qa/runs/:id/status          the run read again: pie(script_status), with since_seq when given
 *   POST   /qa/runs/:id/verdict         a manual step's verdict: { step, verdict: pass | fail | skip, note? }
 *   GET    /qa/runs/:id/results         the run's results.json
 *   GET    /qa/runs/:id/steps/:step/captures/:n  a picture the agent captured for a step
 *   POST   /qa/runs/:id/assign          hand the playtest to a subagent loop: { sessionId? } for a run started elsewhere
 *   DELETE /qa/runs/:id/assign          cancel the loop
 *   POST   /qa/runs/:id/loop/revert     revert the loop's changes: { attempt? }, every attempt's when none is named
 *   POST   /qa/runs/:id/stop            Stop on a live card: pie(script_stop)
 *   POST   /qa/runs/:id/run             Start playtest on a draft's card: { startPie?, players?, listen?, record? }
 *   PUT    /qa/runs/:id/script          Edit on a draft's card: { steps }, saved with pie(script_update)
 *   DELETE /qa/runs/:id/script          Delete on a draft's card: pie(script_delete)
 *   DELETE /qa/runs/:id                 take a finished run started elsewhere off the chat
 *
 * A script a session's pie(script_create) or pie(script_update) saves is a
 * draft card in that session: its steps, unrun. Start playtest, or a run of that script
 * the session starts any other way, turns the same card live. Each step may
 * carry a player (host or client <n>); Studio keeps it, since ue-mcp's steps
 * have none, and takes it out before the call. Under the Manual Playtest runs
 * setting an agent's own pie(script_run) is refused: runs come from the card.
 *
 * A run a session's pie(script_run) or pie(script_replay) started is a qa entry
 * in that session's transcript, kept current from the script.* events and
 * saved with every change, so a reload or a daemon restart finds it as it was.
 * After a restart an unfinished run is read again from its last seq, which
 * also has ue-mcp follow it again. Changes are announced as studio.qa.changed
 * with the run; the card also applies the script.* events itself.
 *
 * ue-mcp keeps one follower per run and puts the verdict form to whoever
 * called last, so every status read here carries the session's form, as the
 * call that started the run did. A run started elsewhere is only read with
 * script_results, which leaves its follower alone.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  qaApplyStreamEvent,
  qaApplyVerdictAnswer,
  qaEnded,
  qaMergeAnswer,
  qaRunFromAnswer,
  qaDraftFromScript,
  qaDraftId,
  qaIsDraft,
  qaPieInstance,
  qaScriptKey,
  PLAYTEST_RUNS_REFUSAL,
  QA_VERDICTS,
  type QaLoop,
  type QaRun,
  type QaVerdict,
  type RestoreOutcome,
} from "@ue-mcp-studio/shared";
import { PlaytestLoop, attentionText, type LoopCheckpoints } from "./playtest-loop.js";
import { type ElicitParams, type ElicitResult, type FormBroker } from "./forms.js";
import type { SessionStore } from "./sessions.js";
import type { AgentHost } from "./tools.js";
import type { PlaytestStore } from "./playtest-store.js";

const CAPTURE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** The pie actions that start a run. */
const STARTS = new Set(["script_run", "script_replay"]);

export interface QaHost {
  callAction(category: string, action: string, args?: Record<string, unknown>, opts?: { elicit?: (p: ElicitParams) => Promise<ElicitResult> }): Promise<ActionResult>;
  editors(): Array<{ connected: boolean }>;
  events: {
    publish(type: string, data?: Record<string, unknown>): unknown;
    subscribe(listener: (e: { type: string; data: Record<string, unknown> }) => void): () => void;
  };
  projectDir: string;
  log: { warn(message: string, detail?: unknown): void };
}

/** Starts and stops the subagent a playtest is assigned to: the runner's assignSubagent and stopSubagent. */
export interface QaAssigner {
  assign(sessionId: string, description: string, prompt: string): { callId: string; done: Promise<{ isError: boolean; stopped?: boolean; text?: string }> };
  stop(sessionId: string, callId: string): boolean;
}

/** What the playtest loop needs beside the assigner: checkpoints, and who to tell when it needs the user. */
export interface QaLoopSupport {
  checkpoints: LoopCheckpoints;
  /** Why a session cannot take checkpoints, such as its review switch being off; null when it can. */
  blocked?: (sessionId: string) => string | null;
  /** A loop needs the user: the Windows notification and anything else beside the card. */
  notify?: (sessionId: string, loop: QaLoop, run: QaRun) => void;
  /** The loop's clock. */
  now?: () => number;
}

export interface QaBrokerOptions {
  host: QaHost;
  store: SessionStore;
  forms?: FormBroker;
  assigner?: QaAssigner;
  /** The Playtest runs setting and each script's players; without it agent runs are allowed and steps have no players. */
  playtests?: PlaytestStore;
  /** The playtest loop's checkpoints; without it Assign to subagent says why it cannot start. */
  loop?: QaLoopSupport;
  now?: () => string;
}

/** How a draft's Start playtest starts it. */
export interface QaRunOptions {
  /** Start PIE, or use the one running. */
  startPie?: boolean;
  /** Players in PIE; more than one sets PIE's clients first. */
  players?: number;
  /** Listen server with more than one player. */
  listen?: boolean;
  record?: boolean;
}

/** A step from a call or a card: its player taken out, ue-mcp's fields left. */
function splitPlayers(steps: unknown): { steps: unknown[]; players: Record<number, string> } | null {
  if (!Array.isArray(steps)) return null;
  const players: Record<number, string> = {};
  const clean = steps.map((x, i) => {
    if (!x || typeof x !== "object") return x;
    const { player, ...rest } = x as Record<string, unknown>;
    if (typeof player === "string" && player.trim()) players[i] = player.trim().toLowerCase().replace(/\s+/g, " ");
    return rest;
  });
  return { steps: clean, players };
}

const refusedRun = (): ActionResult => ({ isError: true, content: [{ type: "text", text: PLAYTEST_RUNS_REFUSAL }] });

interface Inflight {
  sessionId: string;
  action: string;
}

function text(r: ActionResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

function json(r: ActionResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text(r)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The error an answer carries: a failed call, or success: false. Null when it worked. */
function failure(r: ActionResult, body: Record<string, unknown> | null): string | null {
  if (r.isError) return text(r) || "the call failed";
  if (body?.success === false) return typeof body.error === "string" ? body.error : "the call failed";
  return null;
}

export class QaBroker {
  /** Every run this process knows, owned or not. */
  private readonly runs = new Map<string, QaRun>();
  /** Studio calls starting a run right now, oldest first: an unknown run's first events belong to one of them. */
  private readonly inflight: Inflight[] = [];
  /** Runs being read for the first time, with the events that arrive meanwhile. */
  private readonly reading = new Map<string, Array<{ type: string; data: Record<string, unknown> }>>();
  /** Runs started elsewhere that the user took off the chat. */
  private readonly dismissed = new Set<string>();
  /** Playtest loops running in this daemon, by loop id. */
  private readonly loops = new Map<string, PlaytestLoop>();
  private readonly now: () => string;
  private readonly unsubscribe: () => void;

  constructor(private readonly o: QaBrokerOptions) {
    this.now = o.now ?? (() => new Date().toISOString());
    for (const s of o.store.all()) {
      for (const t of s.transcript) {
        if (t.kind !== "qa") continue;
        // A subagent runs in one daemon only: one this process did not start is over.
        if (t.run.assignment?.state === "running") {
          const loop = t.run.assignment.loop;
          t.run = { ...t.run, assignment: { ...t.run.assignment, state: "stopped", ...(loop ? { loop: { ...loop, state: loop.state === "running" ? "stopped" : loop.state } } : {}) } };
          o.store.save(s);
        }
        this.runs.set(t.run.runId, t.run);
      }
    }
    this.unsubscribe = o.host.events.subscribe((e) => this.observe(e));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Read every unfinished run again from its last seq, so a restart misses nothing and ue-mcp follows it again. */
  async resume(): Promise<void> {
    if (!this.o.host.editors().some((e) => e.connected)) return;
    const open = [...this.runs.values()].filter((r) => !qaEnded(r.state) && r.sessionId);
    await Promise.all(open.map((r) => this.status(r.runId, r.lastSeq).catch(() => null)));
  }

  get(runId: string): QaRun | undefined {
    return this.runs.get(runId);
  }

  /** Every run and draft this process knows, in every session and none. */
  all(): QaRun[] {
    return [...this.runs.values()];
  }

  /** Runs no Studio session started, which the chat shows wherever it is open. */
  unowned(): QaRun[] {
    return [...this.runs.values()].filter((r) => !r.sessionId && !this.dismissed.has(r.runId));
  }

  dismiss(runId: string): string | null {
    const r = this.runs.get(runId);
    if (!r || r.sessionId) return "only a run started outside Studio's sessions can be dismissed";
    if (!qaEnded(r.state)) return "the run is still going";
    this.dismissed.add(runId);
    this.o.host.events.publish("qa.changed", { runId, dismissed: true });
    return null;
  }

  /** The host a session's turn runs on: a run its calls start gets a card in its transcript. */
  wrap(host: AgentHost, sessionId: string, opts: { assigned?: boolean } = {}): AgentHost {
    const callAction = async (category: string, action: string, args: Record<string, unknown> = {}): Promise<ActionResult> => {
      if (category === "pie" && (action === "script_create" || action === "script_update")) return this.drafting(host, sessionId, action, args);
      if (category === "pie" && action === "script_delete") {
        const r = await host.callAction(category, action, args);
        if (!failure(r, json(r)) && typeof args.path === "string") this.deleted(args.path);
        return r;
      }
      if (category !== "pie" || !STARTS.has(action)) return host.callAction(category, action, args);
      // Manual: the agent's own run is refused; the card's Start playtest and an assigned subagent are the user's.
      if (!opts.assigned && this.o.playtests?.runs() === "manual") return refusedRun();
      const call: Inflight = { sessionId, action };
      this.inflight.push(call);
      try {
        const r = await host.callAction(category, action, args);
        const body = json(r);
        if (!failure(r, body) && body) this.started(sessionId, action, body);
        return r;
      } finally {
        this.inflight.splice(this.inflight.indexOf(call), 1);
      }
    };
    return {
      get projectDir() { return host.projectDir; },
      get dataDir() { return host.dataDir; },
      callAction,
      editors: () => host.editors(),
      editorOperation: (op) => host.editorOperation(op),
      events: host.events,
      setBusy: (busy) => host.setBusy(busy),
      log: host.log,
    };
  }

  /** A session's call started a run: its answer is the card's first state. */
  private started(sessionId: string, action: string, answer: Record<string, unknown>): void {
    const runId = typeof answer.run_id === "string" ? answer.run_id : null;
    if (!runId) return;
    const had = this.runs.get(runId);
    const fresh = qaRunFromAnswer(answer, { ...this.ownerOf(sessionId, action), seenAt: this.now() });
    if (!fresh) return;
    let run: QaRun = had ? { ...qaMergeAnswer(had, answer), ...this.ownerOf(sessionId, action, had) } : fresh;
    // A run a subagent the user assigned starts shows that subagent too: its Cancel and its thread.
    if (!run.assignment) {
      const parent = this.callParent(sessionId, run.toolUseId);
      const assignment = parent ? [...this.runs.values()].find((r) => r.assignment?.callId === parent && r.assignment.state === "running")?.assignment : undefined;
      if (assignment) run = { ...run, assignment };
    }
    this.save(run);
  }

  /** The agent call a tool call was made under. */
  private callParent(sessionId: string, toolUseId: string | null): string | undefined {
    if (!toolUseId) return undefined;
    return this.o.store.get(sessionId)?.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId)?.parent;
  }

  /** The session, tool call and subagent behind a run, from the newest matching call still running. */
  private ownerOf(sessionId: string, action: string, had?: QaRun): Pick<QaRun, "sessionId" | "toolUseId" | "subagent"> {
    if (had?.sessionId) return { sessionId: had.sessionId, toolUseId: had.toolUseId, ...(had.subagent ? { subagent: had.subagent } : {}) };
    const s = this.o.store.get(sessionId);
    const call = s && [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.name === "ue_mcp" && t.call.outcome === "pending"
      && (t.call.input as { category?: unknown }).category === "pie" && (t.call.input as { method?: unknown }).method === action);
    if (!s || call?.kind !== "tool") return { sessionId, toolUseId: null };
    const agent = call.parent ? s.transcript.find((t) => t.kind === "tool" && t.call.id === call.parent) : undefined;
    const description = agent?.kind === "tool" ? (agent.call.input as { description?: unknown }).description : undefined;
    return { sessionId, toolUseId: call.call.id, ...(typeof description === "string" ? { subagent: description } : {}) };
  }

  /** The verdict form for a run's calls: the session's own, as the call that started it had. */
  private callOptions(sessionId: string | null | undefined): { elicit?: (p: ElicitParams) => Promise<ElicitResult> } {
    if (!sessionId || !this.o.forms) return {};
    const forms = this.o.forms;
    return { elicit: (p) => forms.ask(sessionId, "pie(script_run)", p) };
  }

  /**
   * Read a run again: pie(script_status) with the events after sinceSeq, merged
   * into what Studio has. A run started elsewhere is read with script_results.
   * Returns the answer as ue-mcp gave it, with the run as it is now.
   */
  async status(runId: string, sinceSeq?: number): Promise<{ answer: Record<string, unknown>; run: QaRun | null } | { error: string }> {
    const had = this.runs.get(runId);
    const owned = !!had?.sessionId;
    const args: Record<string, unknown> = { run_id: runId };
    if (owned && typeof sinceSeq === "number") args.since_seq = sinceSeq;
    const r = await this.o.host.callAction("pie", owned ? "script_status" : "script_results", args, this.callOptions(had?.sessionId));
    const body = json(r);
    const error = failure(r, body);
    if (error || !body) return { error: error ?? "ue-mcp's answer was not JSON" };
    // results.json and an ended run's status carry no seq: keep the one Studio has.
    const base = had ?? qaRunFromAnswer(body, { seenAt: this.now() });
    if (!base) return { answer: body, run: null };
    const run = qaMergeAnswer(base, body);
    if (body.state === "idle" && Array.isArray(body.steps) && body.steps.length === 0) return { answer: body, run: had ?? null };
    this.save(run);
    return { answer: body, run };
  }

  /**
   * A draft's manual run: pie(script_run) with mode manual, no PIE, every
   * manual step awaiting in any order. The user started it by clicking a
   * verdict, so the Playtest runs setting does not apply. It takes the draft's card.
   */
  private async startManual(draft: QaRun): Promise<{ run: QaRun } | { error: string; status: number }> {
    const sessionId = draft.sessionId;
    if (!sessionId || draft.deleted || draft.script === "inline") return { error: "only a saved script's draft can take a verdict", status: 409 };
    const r = await this.o.host.callAction("pie", "script_run", { script: draft.script, mode: "manual", start_pie: false, record: false }, this.callOptions(sessionId));
    const answer = json(r);
    const error = failure(r, answer);
    if (error || !answer) return { error: error ?? "ue-mcp's answer was not JSON", status: 409 };
    if (typeof answer.run_id !== "string") return { error: "ue-mcp started no manual run", status: 409 };
    this.started(sessionId, "script_run", { ...answer, mode: "manual" });
    const run = this.runs.get(answer.run_id);
    if (!run) return { error: "the manual run's card could not be made", status: 409 };
    const manual = { ...run, manual: true };
    this.save(manual);
    return { run: manual };
  }

  /** The user's verdict on a manual step, through pie(verdict). Returns an error to show, or the run. */
  async verdict(runId: string, body: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const b = (body ?? {}) as { step?: unknown; verdict?: unknown; note?: unknown };
    if (!Number.isInteger(b.step) || !QA_VERDICTS.includes(b.verdict as QaVerdict)) return { error: "body must be { step, verdict: pass | fail | skip, note? }", status: 400 };
    const note = typeof b.note === "string" ? b.note.trim() : "";
    if (b.verdict === "fail" && !note) return { error: "a fail needs a note: what went wrong", status: 400 };
    let had = this.runs.get(runId);
    // A verdict on a draft's manual step starts its manual run first, which takes the card.
    if (had && qaIsDraft(had)) {
      if (had.steps.find((s) => s.index === b.step)?.judge !== "manual") return { error: "only a manual step takes a verdict before Start playtest", status: 409 };
      const started = await this.startManual(had);
      if ("error" in started) return started;
      had = started.run;
      runId = had.runId;
    }
    const r = await this.o.host.callAction("pie", "verdict", { run_id: runId, step: b.step, verdict: b.verdict, ...(note ? { note } : {}) });
    const answer = json(r);
    const error = failure(r, answer);
    if (error) return { error, status: 409 };
    if (!had) return { error: `Studio has no run ${runId}`, status: 404 };
    const run = qaApplyVerdictAnswer(had, answer);
    this.save(run);
    return { run };
  }

  /** A script the agent saved: the call without its players, then its draft card in the session. */
  private async drafting(host: { callAction: QaHost["callAction"] }, sessionId: string | null, action: string, args: Record<string, unknown>): Promise<ActionResult> {
    const split = splitPlayers(args.steps);
    const r = await host.callAction("pie", action, split ? { ...args, steps: split.steps } : args);
    const body = json(r);
    if (failure(r, body) || !body) return r;
    await this.draftFrom(body, sessionId, split?.players, typeof args.path === "string" ? args.path : undefined);
    return r;
  }

  /** The draft card for a saved script, from its answer or, when that has no steps, from pie(script_read). */
  private async draftFrom(body: Record<string, unknown>, sessionId: string | null, players: Record<number, string> | undefined, path?: string): Promise<QaRun | null> {
    let script: Record<string, unknown> | null = Array.isArray(body.steps) && typeof body.path === "string" ? body : null;
    const at = typeof body.path === "string" ? body.path : path;
    if (!script && at) {
      const read = await this.o.host.callAction("pie", "script_read", { path: at });
      const b = json(read);
      script = failure(read, b) ? null : b;
    }
    const where = script && typeof script.path === "string" ? script.path : null;
    if (!script || !where) return null;
    if (players) this.o.playtests?.setPlayers(where, players);
    const draft = qaDraftFromScript(script, { sessionId, players: this.o.playtests?.players(where), seenAt: this.now() });
    if (!draft) return null;
    const had = this.runs.get(draft.runId);
    // A subagent running it, or a session that drafted it, stays with the card.
    const next = had ? { ...draft, sessionId: had.sessionId ?? draft.sessionId, ...(had.assignment ? { assignment: had.assignment } : {}) } : draft;
    this.save(next);
    return next;
  }

  /** A script something outside a session's calls saved, such as the playtest flow: its draft card in that session. */
  async drafted(sessionId: string, script: Record<string, unknown>): Promise<QaRun | null> {
    return this.draftFrom(script, sessionId, undefined, typeof script.path === "string" ? script.path : undefined);
  }

  /** A script pie(script_delete) removed: its draft cards say so. */
  private deleted(path: string): void {
    const run = this.runs.get(qaDraftId(path));
    if (run && qaIsDraft(run)) this.save({ ...run, deleted: true });
  }

  /** Edit on a draft's card: the steps as the user changed them, saved with pie(script_update). */
  async saveScript(runId: string, body: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    if (!run || !qaIsDraft(run) || run.deleted) return { error: "only a draft that still has its script can be edited", status: 409 };
    const steps = (body as { steps?: unknown } | undefined)?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return { error: "body must be { steps: [...] } with at least one step", status: 400 };
    const r = await this.drafting(this.o.host, run.sessionId, "script_update", { path: run.script, steps });
    const error = failure(r, json(r));
    if (error) return { error, status: 409 };
    return { run: this.runs.get(runId) ?? run };
  }

  /** Delete on a draft's card: pie(script_delete). */
  async deleteScript(runId: string): Promise<{ run: QaRun } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    if (!run || !qaIsDraft(run)) return { error: "only a draft's script can be deleted from its card", status: 409 };
    const r = await this.o.host.callAction("pie", "script_delete", { path: run.script, confirm: true });
    const error = failure(r, json(r));
    if (error) return { error, status: 409 };
    this.deleted(run.script);
    return { run: this.runs.get(runId)! };
  }

  /** Edit on the Playtests page: a saved script's steps as saved, with its players, read with pie(script_read). */
  async readScriptAt(script: string): Promise<{ run: QaRun } | { error: string; status: number }> {
    const r = await this.o.host.callAction("pie", "script_read", { path: script });
    const body = json(r);
    const error = failure(r, body);
    if (error) return { error, status: 409 };
    const run = qaDraftFromScript(body, { players: this.o.playtests?.players(script), seenAt: this.now() });
    return run ? { run } : { error: "the script has no steps to edit", status: 409 };
  }

  /**
   * Edit on the Playtests page: any saved script, by its path, saved with
   * pie(script_update). A session's draft card of it is saved through the card,
   * so the card shows the change; a script with none gets no card.
   */
  async saveScriptAt(script: string, steps: unknown): Promise<{ script: string } | { error: string; status: number }> {
    if (!Array.isArray(steps) || steps.length === 0) return { error: "body must be { script, steps: [...] } with at least one step", status: 400 };
    const card = this.runs.get(qaDraftId(script));
    if (card && qaIsDraft(card) && !card.deleted && card.sessionId) {
      const r = await this.saveScript(card.runId, { steps });
      return "error" in r ? r : { script };
    }
    const split = splitPlayers(steps)!;
    const r = await this.o.host.callAction("pie", "script_update", { path: script, steps: split.steps });
    const error = failure(r, json(r));
    if (error) return { error, status: 409 };
    this.o.playtests?.setPlayers(script, split.players);
    return { script };
  }

  /** Delete on the Playtests page: any saved script, by its path, with pie(script_delete). Its draft cards say so. */
  async deleteScriptAt(script: string): Promise<{ script: string } | { error: string; status: number }> {
    const r = await this.o.host.callAction("pie", "script_delete", { path: script, confirm: true });
    const error = failure(r, json(r));
    if (error) return { error, status: 409 };
    this.deleted(script);
    return { script };
  }

  /**
   * Start playtest on a draft's card: PIE set to the players asked for, then
   * pie(script_run) of its script. The run takes the draft's card, so the same
   * card goes live. Auto steps watch the player the first of them is for.
   */
  async runScript(runId: string, body: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    if (!run || run.script === "inline" || run.deleted) return { error: "only a saved script can be run from its card", status: 409 };
    if (!qaIsDraft(run) && !qaEnded(run.state) && !run.manual) return { error: "the playtest is running", status: 409 };
    const sessionId = run.sessionId;
    if (!sessionId) return { error: "the playtest has no session", status: 409 };
    // Start playtest on a manual run's card: that run ends, with the verdicts it has, and a full run with PIE takes the card.
    if (run.manual && !qaEnded(run.state)) {
      const stop = await this.o.host.callAction("pie", "script_stop", { run_id: run.runId, reason: "Start playtest started a full run" });
      const error = failure(stop, json(stop));
      if (error) return { error: `the manual run could not be ended: ${error}`, status: 409 };
    }
    const o = (body ?? {}) as QaRunOptions;
    const players = Number.isInteger(o.players) && (o.players as number) > 0 ? (o.players as number) : 1;
    if (players > 1 || o.listen) {
      const c = await this.o.host.callAction("editor", "configure_pie", { numClients: players, netMode: o.listen ? "listen" : "standalone" });
      const error = failure(c, json(c));
      if (error) return { error: `PIE could not be set to ${players} players: ${error}`, status: 409 };
    }
    const watched = run.steps.find((s) => s.judge === "auto" && s.player)?.player;
    const instance = players > 1 ? qaPieInstance(watched) : undefined;
    const args: Record<string, unknown> = { script: run.script, start_pie: o.startPie !== false, record: o.record !== false, ...(instance !== undefined ? { pie_instance: instance } : {}) };
    const call: Inflight = { sessionId, action: "script_run" };
    this.inflight.push(call);
    try {
      const r = await this.o.host.callAction("pie", "script_run", args, this.callOptions(sessionId));
      const answer = json(r);
      const error = failure(r, answer);
      if (error || !answer) return { error: error ?? "ue-mcp's answer was not JSON", status: 409 };
      this.started(sessionId, "script_run", answer);
      const id = typeof answer.run_id === "string" ? answer.run_id : "";
      return { run: this.runs.get(id) ?? run };
    } finally {
      this.inflight.splice(this.inflight.indexOf(call), 1);
    }
  }

  setAssigner(assigner: QaAssigner): void {
    this.o.assigner = assigner;
  }

  setLoopSupport(loop: QaLoopSupport): void {
    this.o.loop = loop;
  }

  /**
   * Hand a playtest to a subagent loop that makes it pass: attempts that run
   * it, read why steps failed, change the project and run it again, each
   * between checkpoints, until every step passes or a hard blocker stops it
   * (playtest-loop.ts). The threads are in the run's session, or the session
   * the user has open for a run started elsewhere. Without checkpoints the
   * loop does not start, and the answer says why.
   */
  async assign(runId: string, body: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    if (!run) return { error: `Studio has no run ${runId}`, status: 404 };
    const asked = (body as { sessionId?: unknown } | undefined)?.sessionId;
    const sessionId = run.sessionId ?? (typeof asked === "string" ? asked : null);
    if (!sessionId || !this.o.store.get(sessionId)) return { error: "open a session to run the subagent in", status: 400 };
    const assigner = this.o.assigner;
    if (!assigner) return { error: "subagents are not available", status: 409 };
    if (run.assignment?.state === "running") return { error: "a subagent is already running this playtest", status: 409 };
    const support = this.o.loop;
    const why = !support ? "Assign to subagent needs checkpoints, and this Studio has none to give it." : support.blocked?.(sessionId) ?? null;
    if (why) return { error: `The loop did not start. ${why}`, status: 409 };
    let baseline: string;
    try {
      baseline = (await support!.checkpoints.checkpoint(`Playtest ${run.scriptName}: before the loop`)).id;
    } catch (e) {
      return { error: `The loop did not start: its first checkpoint failed. ${e instanceof Error ? e.message : String(e)}`, status: 409 };
    }
    const current = this.runs.get(runId) ?? run;
    const loop = new PlaytestLoop({
      card: {
        holder: (id) => this.loopHolder(id),
        refresh: async (id) => {
          const r = await this.status(id);
          return "run" in r ? r.run : null;
        },
        save: (id, l, state, callId) => this.saveLoop(id, l, state, callId),
        transcript: (sid) => this.o.store.get(sid)?.transcript ?? [],
      },
      checkpoints: support!.checkpoints,
      agents: { assign: (sid, d, p) => assigner.assign(sid, d, p), stop: (sid, c) => assigner.stop(sid, c) },
      events: this.o.host.events,
      projectDir: this.o.host.projectDir,
      notify: (sid, l, r) => this.needsYou(sid, l, r),
      ...(support!.now ? { now: support!.now } : {}),
      log: this.o.host.log,
    }, sessionId, baseline, crypto.randomUUID());
    this.loops.set(loop.loop.id, loop);
    this.save({ ...current, assignment: { callId: "", sessionId, state: "running", at: this.now(), loop: { ...loop.loop } } });
    void loop.start().finally(() => this.loops.delete(loop.loop.id));
    return { run: this.loopHolder(loop.loop.id) ?? current };
  }

  /** The run that holds a loop: the card, which each attempt's run takes over. */
  private loopHolder(loopId: string): QaRun | undefined {
    // The newest run that carries it: an attempt's run that got a card of its own holds it from then on.
    return [...this.runs.values()].filter((r) => r.assignment?.loop?.id === loopId && !r.deleted).pop();
  }

  private saveLoop(loopId: string, loop: QaLoop, state: "running" | "done" | "failed" | "stopped", callId?: string): void {
    const run = this.loopHolder(loopId);
    if (!run?.assignment) return;
    this.save({ ...run, assignment: { ...run.assignment, callId: callId ?? run.assignment.callId, state, loop: JSON.parse(JSON.stringify(loop)) as QaLoop } });
  }

  /** A loop stopped for the user: a note for the agent's next turn, and the attention event Studio's window notifies with. */
  private needsYou(sessionId: string, loop: QaLoop, run: QaRun): void {
    const s = this.o.store.get(sessionId);
    if (s) {
      s.notes.push(`The playtest loop on "${run.scriptName}" stopped after ${loop.attempts.length} attempt${loop.attempts.length === 1 ? "" : "s"} and needs the user: ${loop.blocker?.reason ?? ""}`);
      this.o.store.save(s);
    }
    this.o.host.events.publish("qa.attention", { sessionId, runId: run.runId, loopId: loop.id, title: "Playtest needs you", text: attentionText(run, loop) });
    this.o.loop?.notify?.(sessionId, loop, run);
    this.editorToast(loop, run);
  }

  /**
   * The same blocker as a toast in the editor. Best effort: the Windows
   * notification and the card are the signals, so a failed call, or a bridge
   * without editor(show_notification), changes nothing.
   */
  private editorToast(loop: QaLoop, run: QaRun): void {
    const args = { text: loop.blocker?.reason ?? "The playtest loop stopped and needs you.", subText: run.scriptName, severity: "warning" };
    void Promise.resolve()
      .then(() => this.o.host.callAction("editor", "show_notification", args))
      .catch(() => undefined);
  }

  /**
   * Revert a finished loop's changes: one attempt's paths back to the
   * checkpoint before it, or every attempt's back to the checkpoint before the
   * loop. Each revert is a restore the timeline can undo.
   */
  async revertLoop(runId: string, body: unknown): Promise<{ run: QaRun; outcome: RestoreOutcome } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    const loop = run?.assignment?.loop;
    if (!run || !loop) return { error: "this playtest has no loop", status: 404 };
    if (loop.state === "running") return { error: "the loop is still running: cancel it first", status: 409 };
    const support = this.o.loop;
    if (!support) return { error: "this Studio has no checkpoints", status: 409 };
    const n = (body as { attempt?: unknown } | undefined)?.attempt;
    const attempt = n === undefined ? null : loop.attempts.find((a) => a.n === n);
    if (n !== undefined && !attempt) return { error: `the loop has no attempt ${String(n)}`, status: 404 };
    const targets = attempt ? [attempt] : loop.attempts.filter((a) => !a.reverted);
    const paths = [...new Set(targets.flatMap((a) => a.changes.map((c) => c.path)))];
    if (paths.length === 0) return { error: "nothing to revert", status: 409 };
    let outcome: RestoreOutcome & { before: string; after: string };
    try {
      outcome = await support.checkpoints.restore(attempt ? attempt.before : loop.baseline, paths);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), status: 409 };
    }
    const next: QaLoop = JSON.parse(JSON.stringify(loop)) as QaLoop;
    for (const a of next.attempts) if (targets.some((t) => t.n === a.n)) a.reverted = true;
    if (!attempt) next.reverted = true;
    if (run.sessionId) support.checkpoints.mark(run.sessionId, { checkpoint: outcome.after, label: attempt ? `Reverted ${run.scriptName}, attempt ${attempt.n}` : `Reverted every change the ${run.scriptName} loop made`, at: this.now(), kind: "restore", undo: outcome.before });
    const saved: QaRun = { ...run, assignment: { ...run.assignment!, loop: next } };
    this.save(saved);
    return { run: this.runs.get(saved.runId) ?? saved, outcome };
  }

  /** Stop on a live card: pie(script_stop) ends the run, its unsettled steps left pending. */
  async stopRun(runId: string): Promise<{ run: QaRun } | { error: string; status: number }> {
    const run = this.runs.get(runId);
    if (!run || qaIsDraft(run) || qaEnded(run.state)) return { error: "only a run that is going can be stopped", status: 409 };
    if (run.assignment?.state === "running") return { error: "a subagent is running this playtest: cancel it instead", status: 409 };
    const r = await this.o.host.callAction("pie", "script_stop", { run_id: runId, reason: "Stopped from its card" });
    const error = failure(r, json(r));
    if (error) return { error, status: 409 };
    const read = await this.status(runId).catch(() => null);
    return { run: (read && "run" in read && read.run) || this.runs.get(runId) || run };
  }

  /** Stop the loop, or the subagent, a playtest is assigned to; a loop that stopped for the user is closed, so it no longer waits for them. */
  cancel(runId: string): { run: QaRun } | { error: string; status: number } {
    const run = this.runs.get(runId);
    const a = run?.assignment;
    if (run && a?.state !== "running" && a?.loop?.state === "needs_you") {
      const holder = this.loopHolder(a.loop.id) ?? run;
      const loop = holder.assignment?.loop ?? a.loop;
      this.save({ ...holder, assignment: { ...(holder.assignment ?? a), loop: { ...loop, state: "stopped", endedAt: this.now() } } });
      return { run: this.runs.get(holder.runId) ?? holder };
    }
    if (!run || !a || a.state !== "running") return { error: "no subagent is running this playtest", status: 404 };
    const loop = a.loop ? this.loops.get(a.loop.id) : undefined;
    if (loop) {
      loop.cancel();
      return { run: this.runs.get(runId) ?? run };
    }
    if (!this.o.assigner?.stop(a.sessionId, a.callId)) {
      this.assignmentEnded(runId, a.callId, "stopped");
      return { run: this.runs.get(runId)! };
    }
    return { run: this.runs.get(runId)! };
  }

  /** The subagent ended: whichever card holds it now (a draft's run takes its card, and its assignment) says how. */
  private assignmentEnded(runId: string, callId: string, state: "done" | "failed" | "stopped"): void {
    const holders = [this.runs.get(runId), ...this.runs.values()].filter((r): r is QaRun => r?.assignment?.callId === callId && r.assignment.state === "running");
    for (const run of new Set(holders)) this.save({ ...run, assignment: { ...run.assignment!, state } });
  }

  /** The run's results.json, from its file when it is the project's, otherwise as ue-mcp reads it. */
  /** A picture the agent captured for a step, read only from under the project's Saved folder. */
  capture(runId: string, step: number, n: number): { type: string; bytes: Buffer } | null {
    const s = this.runs.get(runId)?.steps.find((x) => x.index === step);
    const raw = s?.evidence?.captures?.[n];
    if (!raw) return null;
    const file = path.resolve(raw);
    const root = path.resolve(this.o.host.projectDir, "Saved");
    const type = CAPTURE_TYPES[path.extname(file).toLowerCase()];
    if (!type || !file.toLowerCase().startsWith(root.toLowerCase() + path.sep) || !fs.existsSync(file)) return null;
    return { type, bytes: fs.readFileSync(file) };
  }

  async results(runId: string): Promise<Record<string, unknown> | { error: string }> {
    const run = this.runs.get(runId);
    const file = run?.resultsPath ? path.resolve(run.resultsPath) : null;
    const root = path.resolve(this.o.host.projectDir, "Saved", "MCPObservations");
    if (file && path.basename(file) === "results.json" && file.toLowerCase().startsWith(root.toLowerCase() + path.sep) && fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      } catch {
        // Being rewritten by a late verdict: ask ue-mcp instead.
      }
    }
    const r = await this.o.host.callAction("pie", "script_results", { run_id: runId });
    const body = json(r);
    const error = failure(r, body);
    return error || !body ? { error: error ?? "ue-mcp's answer was not JSON" } : body;
  }

  // ── Events ────────────────────────────────────────────────────────

  private observe(e: { type: string; data: Record<string, unknown> }): void {
    if (e.type === "editor.connected") {
      void this.resume();
      return;
    }
    if (!e.type.startsWith("script.")) return;
    const runId = typeof e.data.runId === "string" ? e.data.runId : null;
    if (!runId) return;
    const waiting = this.reading.get(runId);
    if (waiting) {
      waiting.push(e);
      return;
    }
    const had = this.runs.get(runId);
    if (had) {
      const next = qaApplyStreamEvent(had, e.type, e.data);
      if (next !== had) this.save(next);
      return;
    }
    void this.discover(runId, e);
  }

  /**
   * A run Studio has not seen: one a Studio call is starting (its events can
   * come before the call's answer), or one started elsewhere. Read it once,
   * then apply what arrived meanwhile.
   */
  private async discover(runId: string, first: { type: string; data: Record<string, unknown> }): Promise<void> {
    const queued = [first];
    this.reading.set(runId, queued);
    const call = this.inflight[0];
    try {
      // A Studio call's run is read with its status, carrying the session's form; another's with its results, which leave its follower alone.
      const r = await (call
        ? this.o.host.callAction("pie", "script_status", { run_id: runId }, this.callOptions(call.sessionId))
        : this.o.host.callAction("pie", "script_results", { run_id: runId })).catch(() => null);
      const body = r ? json(r) : null;
      const owner = call ? this.ownerOf(call.sessionId, call.action) : { sessionId: null, toolUseId: null };
      let run = (body && !failure(r!, body) ? qaRunFromAnswer(body, { ...owner, seenAt: this.now() }) : null)
        ?? qaRunFromAnswer({ run_id: runId, script: first.data.script, state: "armed", steps: [] }, { ...owner, seenAt: this.now() })!;
      // The call's own answer may have landed while this read.
      const landed = this.runs.get(runId);
      if (landed) run = landed;
      for (const e of queued) run = qaApplyStreamEvent(run, e.type, e.data);
      this.save(run);
    } finally {
      this.reading.delete(runId);
    }
  }

  // ── Records ───────────────────────────────────────────────────────

  /** Keep the run, its line in its session's transcript, and tell the UI. */
  private save(run: QaRun): void {
    run = this.withPlayers(run);
    // Stopped only for a person's verdict: once every step has passed, the loop passed.
    const l = run.assignment?.loop;
    if (l?.state === "needs_you" && l.blocker?.kind === "verdict" && run.steps.length > 0 && run.steps.every((x) => x.status === "passed")) {
      const { blocker: _done, ...rest } = l;
      run = { ...run, assignment: { ...run.assignment!, loop: { ...rest, state: "passed" } } };
    }
    this.runs.set(run.runId, run);
    const s = run.sessionId ? this.o.store.get(run.sessionId) : undefined;
    let replaces: string | undefined;
    if (s) {
      const entry = s.transcript.find((t) => t.kind === "qa" && t.run.runId === run.runId);
      // A run of a script the session has a draft of takes the draft's card, which goes live; a full run
      // takes the card of the manual run a verdict on that draft started.
      // A run a loop's attempt starts takes the loop's card.
      const draft = entry || qaIsDraft(run) || run.script === "inline" ? undefined
        : s.transcript.find((t) => t.kind === "qa" && t.run.runId !== run.runId && qaScriptKey(t.run.script) === qaScriptKey(run.script) && !t.run.deleted
          && ((t.run.runId === qaDraftId(run.script) && qaIsDraft(t.run)) || (t.run.manual && !run.manual) || (t.run.assignment?.loop?.state === "running" && !run.manual)));
      if (draft?.kind === "qa") {
        replaces = draft.run.runId;
        if (!run.assignment && draft.run.assignment?.state === "running") run = { ...run, assignment: draft.run.assignment };
        this.runs.set(run.runId, run);
        this.runs.delete(replaces);
        draft.run = run;
        this.o.store.save(s);
      } else if (entry?.kind === "qa") {
        entry.run = run;
        this.o.store.save(s);
      } else {
        s.transcript.push({ kind: "qa", run });
        this.o.store.save(s);
        this.o.host.events.publish("transcript.added", { sessionId: s.id, entry: { kind: "qa", run } as unknown as Record<string, unknown> });
      }
    }
    // No sessionId: the open chat would load its whole transcript again on each step. The card takes the run from here.
    this.o.host.events.publish("qa.changed", { runId: run.runId, run: run as unknown as Record<string, unknown>, ...(replaces ? { replaces } : {}) });
  }

  /** Each step's player, from what Studio keeps for the run's script. */
  private withPlayers(run: QaRun): QaRun {
    if (run.script === "inline" || !this.o.playtests) return run;
    const players = this.o.playtests.players(run.script);
    if (Object.keys(players).length === 0 || run.steps.every((s) => s.player || !players[s.index])) return run;
    return { ...run, steps: run.steps.map((s) => (s.player || !players[s.index] ? s : { ...s, player: players[s.index] })) };
  }
}

export function registerQa(api: DaemonExtensionApi, store: SessionStore, forms?: FormBroker, playtests?: PlaytestStore): QaBroker {
  const broker = new QaBroker({ host: api as unknown as QaHost, store, forms, playtests });
  const id = (req: { params: Record<string, string> }) => req.params.id;
  api.route("GET", "/qa/runs", () => ({ body: { runs: broker.unowned() } }));
  api.route("GET", "/qa/runs/:id/status", async (req) => {
    const raw = (req.query as Record<string, unknown> | undefined)?.since_seq;
    const since = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const r = await broker.status(id(req), since);
    return "error" in r ? { status: 409, body: { error: r.error } } : { body: r };
  });
  api.route("POST", "/qa/runs/:id/verdict", async (req) => {
    const r = await broker.verdict(id(req), req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("GET", "/qa/runs/:id/steps/:step/captures/:n", (req) => {
    const p = broker.capture(id(req), Number(req.params.step), Number(req.params.n));
    return p ? { headers: { "content-type": p.type, "cache-control": "private, max-age=86400" }, body: p.bytes } : { status: 404, body: { error: "no such capture" } };
  });
  api.route("GET", "/qa/runs/:id/results", async (req) => {
    const r = await broker.results(id(req));
    return "error" in r && typeof r.error === "string" && Object.keys(r).length === 1 ? { status: 404, body: r } : { body: r };
  });
  api.route("POST", "/qa/runs/:id/assign", async (req) => {
    const r = await broker.assign(id(req), req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("POST", "/qa/runs/:id/loop/revert", async (req) => {
    const r = await broker.revertLoop(id(req), req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("DELETE", "/qa/runs/:id/assign", (req) => {
    const r = broker.cancel(id(req));
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("POST", "/qa/runs/:id/stop", async (req) => {
    const r = await broker.stopRun(id(req));
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("POST", "/qa/runs/:id/run", async (req) => {
    const r = await broker.runScript(id(req), req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("PUT", "/qa/runs/:id/script", async (req) => {
    const r = await broker.saveScript(id(req), req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("DELETE", "/qa/runs/:id/script", async (req) => {
    const r = await broker.deleteScript(id(req));
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("DELETE", "/qa/runs/:id", (req) => {
    const error = broker.dismiss(id(req));
    return error ? { status: 409, body: { error } } : { status: 204 };
  });
  void broker.resume();
  return broker;
}
