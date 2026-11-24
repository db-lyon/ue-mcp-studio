/**
 * What Studio brings to the Playtest Hub, which runs in ue-mcp's daemon.
 *
 * The hub (goals, evidence, the plan queue, the editor lease, its routes and
 * tools) is ue-mcp's. Studio has what ue-mcp does not: chat sessions with a
 * card for each playtest, the Assign fix loop, the /playtest flow, the
 * Manual/Automatic setting, the experiment switch and the signed-in account.
 * They go in through api.hub.configure (feature "hub"), each member optional
 * on the daemon's side:
 *
 * - broker: a plan's runs start on a script's card in the plan's own chat
 *   session and are followed there (QaBroker), so cards, players and verdicts
 *   keep working;
 * - fixer: a fix item is the Assign loop on a card in a new session of its own,
 *   given only while Fix failing playtests with an agent is on;
 * - writePlaytests: the /playtest flow in a session of its own;
 * - replay: pie(script_replay) through a card in the hub's replay session;
 *
 * Every session the hub writes to is one it made for that work (hubKey).
 * A session the user made, or one that is archived or deleted, is never picked.
 * - signer, playtestRuns, enabled, inputAgeMs: Studio's account and settings;
 * - agentCalls: the editor calls Studio's own agents have in flight.
 */
import * as crypto from "node:crypto";
import type { ActionResult, BusyCall as HubBusyCall, DaemonExtensionApi, HubBroker, HubClientOptions, HubFixer, HubWritePlaytests, PlaytestRunsMode } from "ue-mcp/daemon";
import { qaScriptKey, type BusyState, type QaRun } from "@ue-mcp-studio/shared";
import type { QaBroker } from "./qa.js";
import type { SessionStore } from "./sessions.js";
import type { AgentHost } from "./tools.js";
import { answerOf, failureOf } from "./action-answer.js";

/** What the bridge reads of Studio: its cards, sessions, settings and account. */
export interface HubBridgeOptions {
  api: DaemonExtensionApi;
  qa: QaBroker;
  store: Pick<SessionStore, "create" | "get" | "save">;
  /** The /playtest flow in a session; resolves when it ends. */
  writePlaytests: (sessionId: string, text: string) => Promise<void>;
  /** The Manual/Automatic setting: an agent's plan runs only under Automatic. */
  playtestRuns: () => PlaytestRunsMode;
  /** The signed-in ue-mcp account's login, who a sign-off is from; null when none is signed in. */
  signer: () => string | null;
  /** The Playtest Hub experiment's switch. */
  enabled: () => boolean;
  /** How long since someone used this computer; null when no window reports it. */
  inputAgeMs: () => number | null;
  /** What the editor is working on (BusyTracker): the calls Studio's agents have in flight are the hub's agentCalls. */
  busy: () => BusyState;
  /** Fix failing playtests with an agent: off, the hub is given no fixer, so POST /hub/fix answers 409 and no fix loop starts. */
  agentFixes: () => boolean;
  /** Hear that setting change; returns the unsubscribe. */
  onAgentFixes?: (listener: (on: boolean) => void) => () => void;
}

/** Whether the daemon offers the hub (its feature "hub"). */
export const offersHub = (api: DaemonExtensionApi): boolean => !!api.hub && (api.features ?? []).includes("hub");

/**
 * Give the daemon's hub Studio's pieces. Returns the function that takes them
 * back, or a no-op where the daemon has no hub (an older ue-mcp).
 */
export function configureHub(o: HubBridgeOptions): () => void {
  if (!offersHub(o.api)) return () => {};
  const hub = o.api.hub!;
  const bridge = new HubBridge(o);
  let off = hub.configure(bridge.options());
  // The hub reads a client's pieces when it is built, so the fixer comes and goes by configuring again.
  // The new options go in before the old come out, so the hub is never built without Studio's broker.
  const unlisten = o.onAgentFixes?.((on) => {
    if (!on) bridge.stopFixes();
    const old = off;
    off = hub.configure(bridge.options());
    old();
  });
  return () => {
    unlisten?.();
    off();
  };
}

/** The cards Studio runs a plan on. Exported for tests. */
export class HubBridge {
  /** The hub's own session per key: a plan, one fix item of a plan, or a script's replays. */
  private readonly planSessions = new Map<string, string>();

  constructor(private readonly o: HubBridgeOptions) {}

  options(): HubClientOptions {
    return {
      broker: this.broker(),
      ...(this.o.agentFixes() ? { fixer: this.fixer() } : {}),
      writePlaytests: this.writePlaytests(),
      replay: (script, args) => this.replay(script, args),
      signer: this.o.signer,
      playtestRuns: this.o.playtestRuns,
      enabled: this.o.enabled,
      inputAgeMs: this.o.inputAgeMs,
      agentCalls: () => this.agentCalls(),
    };
  }

  /** The editor calls Studio's agents have in flight, which reach the editor through api.callAction and so publish no call events. */
  private agentCalls(): HubBusyCall[] {
    return this.o.busy().calls.flatMap((c) => (c.source === "studio" ? [{ ...c, source: "agent" as const }] : []));
  }

  private broker(): HubBroker {
    const qa = this.o.qa;
    return {
      all: () => qa.all(),
      get: (runId) => qa.get(runId),
      onSaved: (listener) => qa.onSaved(listener),
      status: (runId) => qa.status(runId),
      readScriptAt: (script) => qa.readScriptAt(script),
      startScript: async (script, start) => {
        const card = await this.cardFor(script, `plan:${start.planRunId}`, start.title);
        if ("error" in card) return card;
        // The hub ends the PIE its plan's run started, under its editor lease, so the card does not end it as well.
        const r = await qa.runScript(card.runId, { startPie: true, endPie: false });
        return "error" in r ? { error: r.error } : { run: r.run };
      },
      stopRun: (runId, reason) => qa.stopRun(runId, reason),
      setPlanWait: (wait) => qa.setPlanWait(wait),
    };
  }

  /** Fix with an agent: the script's card in a chat session, and Assign's loop on it. */
  private fixer(): HubFixer {
    const qa = this.o.qa;
    return {
      start: async (item, plan) => {
        // A fix runs in a session of its own. The only one it goes back to is the session this plan made for
        // this item, when a release put the item back; never the user's, nor one from an earlier plan.
        const key = `fix:${plan.id}:${item.check.target}`;
        if (item.sessionId && this.ours(item.sessionId, key)) this.planSessions.set(key, item.sessionId);
        const card = await this.cardFor(item.check.target, key, `Fix ${item.name}`);
        if ("error" in card) return card;
        if (!card.sessionId) return { error: "the playtest's card has no chat session" };
        const r = await qa.assign(card.runId, {});
        return "error" in r ? { error: r.error } : { runId: r.run.runId, sessionId: card.sessionId };
      },
      stop: (item) => {
        const holder = qa.all().find((r) => r.assignment?.state === "running" && r.assignment.sessionId === item.sessionId && qaScriptKey(r.script) === item.check.target);
        if (!holder) return null;
        const r = qa.cancel(holder.runId);
        return "error" in r ? `the fix loop for ${item.name} could not be stopped: ${r.error}` : null;
      },
      running: () => new Set(qa.all().filter((r) => r.assignment?.state === "running").map((r) => qaScriptKey(r.script))),
    };
  }

  /** Agent fixes were turned off: every fix loop the hub started stops, so none goes on spending tokens. */
  stopFixes(): void {
    for (const r of this.o.qa.all()) {
      if (r.assignment?.state !== "running") continue;
      if (this.o.store.get(r.assignment.sessionId)?.hubKey?.startsWith("fix:")) this.o.qa.cancel(r.runId);
    }
  }

  /** Write playtests for a goal: the /playtest flow in a session of its own, which ue-mcp's hub links to the goal. */
  private writePlaytests(): HubWritePlaytests {
    return (request) => {
      const session = this.newSession(request.title, `write:${crypto.randomUUID()}`);
      return { sessionId: session.id, done: this.o.writePlaytests(session.id, request.text) };
    };
  }

  /** A replay a plan starts goes through a card in the hub's own replay session, as an assigned subagent's would, so the run takes the card. */
  private async replay(script: string, args: Record<string, unknown>): Promise<ActionResult> {
    const card = await this.cardFor(script, `replay:${script}`, `Replay ${script.split("/").pop() ?? script}`);
    if ("error" in card || !card.sessionId) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: "error" in card ? card.error : "the playtest's card has no chat session" }) }] };
    }
    return this.o.qa.wrap(this.o.api as unknown as AgentHost, card.sessionId, { assigned: true }).callAction("pie", "script_replay", args);
  }

  /** A session the hub makes for its own work, marked with its key so it is never mistaken for one the user made. */
  private newSession(title: string, key: string) {
    const s = this.o.store.create(title.slice(0, 80));
    s.hubKey = key;
    this.o.store.save(s, { touch: false });
    this.o.api.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return s;
  }

  /** Whether the hub may write to a session for `key`: one it made for that key, still there and not archived. */
  private ours(sessionId: string, key: string): boolean {
    const s = this.o.store.get(sessionId);
    return !!s && !s.archived && s.hubKey === key;
  }

  /** The hub's own session for `key`: the one it made for it while that is still usable, else a new one. */
  private sessionFor(key: string, title: string): string {
    const had = this.planSessions.get(key);
    if (had && this.ours(had, key)) return had;
    const sid = this.newSession(title, key).id;
    this.planSessions.set(key, sid);
    return sid;
  }

  /**
   * The card the hub runs a script on: always in its own session for `key` (a
   * plan, a fix item, a replay), never a session the user made or archived.
   * The newest card of the script that session holds, else a draft from the script.
   */
  private async cardFor(script: string, key: string, title: string): Promise<QaRun | { error: string }> {
    const sid = this.sessionFor(key, title);
    const had = this.o.qa.all()
      .filter((r) => r.sessionId === sid && qaScriptKey(r.script) === script && !r.deleted)
      .sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1))[0];
    if (had) return had;
    const read = await this.o.api.callAction("pie", "script_read", { path: script }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ActionResult);
    const body = answerOf(read);
    if (!body) return { error: `the script could not be read: ${failureOf(read) ?? "no answer"}` };
    const draft = await this.o.qa.drafted(sid, body);
    if (!draft) return { error: "the script's card could not be made" };
    // A draft a subagent is running stays in that subagent's session: the hub does not take it over there.
    if (draft.sessionId !== sid) return { error: "a subagent in another chat session is working on this playtest" };
    return draft;
  }
}
