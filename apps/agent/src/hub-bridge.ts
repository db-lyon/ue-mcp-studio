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
 * - broker: runs start on a script's card in a chat session and are followed
 *   there (QaBroker), so cards, players and verdicts keep working;
 * - fixer: a fix item is the Assign loop on that card;
 * - writePlaytests: the /playtest flow in a session of its own;
 * - replay: pie(script_replay) through the card's session;
 * - signer, playtestRuns, enabled, inputAgeMs: Studio's account and settings;
 * - agentCalls: the editor calls Studio's own agents have in flight.
 */
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
  store: Pick<SessionStore, "create" | "get">;
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
}

/** Whether the daemon offers the hub (its feature "hub"). */
export const offersHub = (api: DaemonExtensionApi): boolean => !!api.hub && (api.features ?? []).includes("hub");

/**
 * Give the daemon's hub Studio's pieces. Returns the function that takes them
 * back, or a no-op where the daemon has no hub (an older ue-mcp).
 */
export function configureHub(o: HubBridgeOptions): () => void {
  if (!offersHub(o.api)) return () => {};
  const bridge = new HubBridge(o);
  return o.api.hub!.configure(bridge.options());
}

/** The cards Studio runs a plan on. Exported for tests. */
export class HubBridge {
  /** One session per plan (or fix) for scripts no session has a card of yet. */
  private readonly planSessions = new Map<string, string>();

  constructor(private readonly o: HubBridgeOptions) {}

  options(): HubClientOptions {
    return {
      broker: this.broker(),
      fixer: this.fixer(),
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
        const card = await this.cardFor(script, start.planRunId, start.title);
        if ("error" in card) return card;
        const r = await qa.runScript(card.runId, { startPie: true });
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
        // An item put back by a release keeps the session it had.
        const own = item.sessionId && this.o.store.get(item.sessionId) ? qa.all().find((r) => r.sessionId === item.sessionId && qaScriptKey(r.script) === item.check.target && !r.deleted) : undefined;
        const card = own ?? (await this.cardFor(item.check.target, `${plan.id}:${item.check.target}`, `Fix ${item.name}`));
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

  /** Write playtests for a goal: the /playtest flow in a session of its own, which ue-mcp's hub links to the goal. */
  private writePlaytests(): HubWritePlaytests {
    return (request) => {
      const session = this.newSession(request.title);
      return { sessionId: session.id, done: this.o.writePlaytests(session.id, request.text) };
    };
  }

  /** A replay a plan starts goes through the card's session, as an assigned subagent's would, so the run takes the card. */
  private async replay(script: string, args: Record<string, unknown>): Promise<ActionResult> {
    const card = await this.cardFor(script, `replay:${script}`, `Replay ${script.split("/").pop() ?? script}`);
    if ("error" in card || !card.sessionId) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: "error" in card ? card.error : "the playtest's card has no chat session" }) }] };
    }
    return this.o.qa.wrap(this.o.api as unknown as AgentHost, card.sessionId, { assigned: true }).callAction("pie", "script_replay", args);
  }

  private newSession(title: string) {
    const s = this.o.store.create(title.slice(0, 80));
    this.o.api.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return s;
  }

  /**
   * The card a plan runs a script on: the newest run or draft of it a session
   * holds, else a draft card in the plan's own session (`key`), made once per plan.
   */
  private async cardFor(script: string, key: string, title: string): Promise<QaRun | { error: string }> {
    const runs = this.o.qa.all().filter((r) => qaScriptKey(r.script) === script).sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1));
    const had = runs.find((r) => r.sessionId && this.o.store.get(r.sessionId) && !r.deleted);
    if (had) return had;
    const read = await this.o.api.callAction("pie", "script_read", { path: script }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ActionResult);
    const body = answerOf(read);
    if (!body) return { error: `the script could not be read: ${failureOf(read) ?? "no answer"}` };
    let sid = this.planSessions.get(key);
    if (!sid || !this.o.store.get(sid)) {
      sid = this.newSession(title).id;
      this.planSessions.set(key, sid);
    }
    const draft = await this.o.qa.drafted(sid, body);
    return draft ?? { error: "the script's card could not be made" };
  }
}
