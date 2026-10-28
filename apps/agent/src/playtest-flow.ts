/**
 * /playtest, Make playtest and Retry: ue-mcp's built-in playtest flow, run
 * through the daemon's POST /v1/flows/playtest/run. The flow gathers context,
 * drafts the script in an agent step on the model Studio registered, checks
 * it, and saves it with pie(script_create). Studio passes what to test and the
 * recent conversation, follows the run's flow.* events to show its stage, and
 * reads the saved script or the errors from the run's answer.
 */
import type { PlaytestStage, TouchedItem, TranscriptEntry } from "@ue-mcp-studio/shared";

export const PLAYTEST_FLOW = "playtest";

/**
 * How a drafted step names an asset: a markdown link to its object path, which
 * the Playtest card links exactly, with no lookup.
 */
export const PLAYTEST_LINKS_LINE = "In each step's instruction, write every asset it names (a map, a Blueprint, an Input Action) as a markdown link to its object path, for example [L_WG_Meadow](/Game/Maps/L_WG_Meadow.L_WG_Meadow).";

/** How much of the conversation goes to the flow as context. */
const CONTEXT_ENTRIES = 16;
const CONTEXT_CHARS = 12_000;

/** The daemon's HTTP address and bearer token, from its discovery file. */
export interface DaemonEndpoint {
  port: number;
  token: string;
}

/** A flow.* event as the daemon publishes it. */
export interface FlowEventLike {
  type: string;
  data?: Record<string, unknown>;
}

export interface PlaytestFlowParams {
  /** What the playtest is to test. */
  target: string;
  /** The recent conversation, as text. */
  context: string;
}

export type PlaytestFlowOutcome =
  | { made: true; script: Record<string, unknown> }
  | { made: false; errors: string[] };

export interface PlaytestFlowOptions {
  endpoint: () => DaemonEndpoint | null;
  subscribe: (listener: (e: FlowEventLike) => void) => () => void;
  fetchImpl?: typeof fetch;
}

/** The stage each of the playtest flow's tasks stands for. playtest.save is what makes the script. */
const STAGES: Record<string, PlaytestStage> = {
  "playtest.gather": "gathering",
  "playtest.draft": "drafting",
  "playtest.check": "checking",
  "playtest.save": "created",
};

export const stageOf = (step: string): PlaytestStage | null => STAGES[step] ?? null;

/** An asset path such as /Game/Blueprints/BP_Hero, the way the flow takes a target as given. */
const ASSET_PATH = /(?:^|[\s`'"(])(\/(?:Game|[A-Z][A-Za-z0-9_]*)\/[A-Za-z0-9_/.-]*[A-Za-z0-9_])/;

/**
 * The flow's target: the first asset path in the user's words, the agent
 * message it is made from, or the conversation, newest first; else the user's
 * words or that message as a description, which the flow looks up.
 */
export function playtestTarget(text: string, source: string | null, conversation: string[] = []): string {
  for (const t of [text, source ?? "", ...[...conversation].reverse()]) {
    const m = ASSET_PATH.exec(t);
    if (m) return m[1].replace(/\.$/, "");
  }
  if (text.trim()) return text.trim();
  if (source?.trim()) return source.trim().slice(0, 500);
  const last = [...conversation].reverse().find((c) => c.trim());
  return last ? last.trim().slice(0, 500) : "the feature this conversation is about";
}

/** The main thread's recent messages, oldest first, without /playtest commands. */
function recentMessages(transcript: TranscriptEntry[]): Array<{ who: "User" | "Assistant"; text: string }> {
  const out: Array<{ who: "User" | "Assistant"; text: string }> = [];
  for (const e of transcript) {
    if (e.parent) continue;
    if (e.kind === "user" && e.text.trim() && !e.text.trim().startsWith("/playtest")) out.push({ who: "User", text: e.text.trim() });
    else if (e.kind === "assistant" && e.text.trim()) out.push({ who: "Assistant", text: e.text.trim() });
  }
  return out.slice(-CONTEXT_ENTRIES);
}

/**
 * The flow's params for a /playtest: the target, and as context what the user
 * asked to test, the agent message it is made from, and the recent
 * conversation, newest kept within CONTEXT_CHARS.
 */
export function playtestParams(text: string, source: string | null, transcript: TranscriptEntry[]): PlaytestFlowParams {
  const recent = recentMessages(transcript);
  const target = playtestTarget(text, source, recent.map((m) => m.text));
  const head = [
    text.trim() ? `The user asked to test: ${text.trim()}` : "",
    source?.trim() ? `Made from this agent message:\n${source.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  const lines = recent.map((m) => `${m.who}: ${m.text}`);
  let convo = lines.join("\n\n");
  while (head.length + convo.length + PLAYTEST_LINKS_LINE.length > CONTEXT_CHARS && lines.length > 1) {
    lines.shift();
    convo = lines.join("\n\n");
  }
  // Last, since an overlong context keeps its end.
  const parts = [head, convo ? `The recent conversation:\n${convo}` : "", PLAYTEST_LINKS_LINE].filter(Boolean).join("\n\n");
  return { target, context: parts.length > CONTEXT_CHARS ? parts.slice(parts.length - CONTEXT_CHARS) : parts };
}

/**
 * The flow's params for the Make playtest pill: the assets and actors the
 * turn changed as the target, the first asset first, and the turn itself as
 * the context: what it changed, and its messages.
 */
export function playtestTurnParams(turn: TranscriptEntry[], targets: TouchedItem[]): PlaytestFlowParams {
  const assets = targets.filter((t) => t.kind === "asset").map((t) => t.path);
  const actors = targets.filter((t) => t.kind === "actor").map((t) => t.path);
  const messages = recentMessages(turn);
  const target = assets[0] ?? actors[0] ?? playtestTarget("", null, messages.map((m) => m.text));
  const changed = [
    assets.length ? `Assets it changed: ${assets.join(", ")}` : "",
    actors.length ? `Actors it changed: ${actors.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  const lines = messages.map((m) => `${m.who}: ${m.text}`);
  let convo = lines.join("\n\n");
  while (changed.length + convo.length + PLAYTEST_LINKS_LINE.length > CONTEXT_CHARS && lines.length > 1) {
    lines.shift();
    convo = lines.join("\n\n");
  }
  // Before the turn, since an overlong context keeps its start.
  const context = [`Test what the agent's last turn changed.${changed ? `\n${changed}` : ""}`, PLAYTEST_LINKS_LINE, convo ? `That turn:\n${convo}` : ""].filter(Boolean).join("\n\n");
  return { target, context: context.length > CONTEXT_CHARS ? context.slice(0, CONTEXT_CHARS) : context };
}

interface FlowStepReport {
  name?: string;
  success?: boolean;
  skipped?: boolean;
  error?: { message?: string };
  data?: unknown;
}

/** One line per draft-time problem a step reported: [{ step, field, message, candidates }]. */
function structuredErrors(data: unknown): string[] {
  const list = (data as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const x = e as { step?: unknown; field?: unknown; message?: unknown; candidates?: unknown };
    if (typeof x?.message !== "string") return typeof e === "string" ? [e] : [];
    const where = [typeof x.step === "number" ? `Step ${x.step + 1}` : null, typeof x.field === "string" ? x.field : null].filter(Boolean).join(" ");
    const near = Array.isArray(x.candidates) && x.candidates.length ? ` (did you mean ${x.candidates.slice(0, 5).join(", ")}?)` : "";
    return [`${where ? `${where}: ` : ""}${x.message}${near}`];
  });
}

/** The saved script, from the step that ran pie(script_create). */
function savedScript(steps: FlowStepReport[]): Record<string, unknown> | null {
  for (const s of [...steps].reverse()) {
    if (!s.success || s.skipped) continue;
    const d = s.data as Record<string, unknown> | undefined;
    if (d && typeof d.path === "string") return d;
    const inner = d?.result as Record<string, unknown> | undefined;
    if (inner && typeof inner.path === "string") return inner;
  }
  return null;
}

/** Why a run made no playtest: each failed step's problems, else its error, else the run's. */
export function flowErrors(body: Record<string, unknown>): string[] {
  const steps = (Array.isArray(body.steps) ? body.steps : []) as FlowStepReport[];
  const out: string[] = [];
  for (const s of steps) {
    if (s.success || s.skipped) continue;
    const listed = structuredErrors(s.data);
    if (listed.length) out.push(...listed);
    else if (s.error?.message) out.push(s.name ? `${s.name}: ${s.error.message}` : s.error.message);
  }
  if (!out.length && typeof body.error === "string") out.push(body.error);
  if (!out.length && typeof body.summary === "string" && body.summary.trim()) out.push(body.summary.trim());
  return out.length ? out : ["The playtest flow ended without saving a script."];
}

/** The answer of POST /v1/flows/playtest/run as an outcome. */
export function outcomeOf(status: number, body: Record<string, unknown>): PlaytestFlowOutcome {
  if (status >= 200 && status < 300 && body.success === true) {
    const script = savedScript((Array.isArray(body.steps) ? body.steps : []) as FlowStepReport[]);
    if (script) return { made: true, script };
    return { made: false, errors: ["The playtest flow finished but its answer names no saved script."] };
  }
  return { made: false, errors: flowErrors(body) };
}

/**
 * Runs the playtest flow. One at a time per daemon, so the flow.* events of the
 * run in progress are this run's: the first run_started of the playtest flow
 * after the request is sent names its runId.
 */
export class PlaytestFlow {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: PlaytestFlowOptions) {}

  run(params: PlaytestFlowParams, onStage: (stage: PlaytestStage, attempt: number) => void, signal: AbortSignal): Promise<PlaytestFlowOutcome> {
    const next = this.queue.then(() => this.runOne(params, onStage, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOne(params: PlaytestFlowParams, onStage: (stage: PlaytestStage, attempt: number) => void, signal: AbortSignal): Promise<PlaytestFlowOutcome> {
    const end = this.o.endpoint();
    if (!end) return { made: false, errors: ["The daemon's address could not be read, so the playtest flow could not start."] };
    let runId: string | null = null;
    const drafts = new Map<PlaytestStage, number>();
    const unsubscribe = this.o.subscribe((e) => {
      if (!e.type.startsWith("flow.")) return;
      const d = e.data ?? {};
      if (d.flowName !== PLAYTEST_FLOW) return;
      if (e.type === "flow.run_started" && runId === null) runId = String(d.runId ?? "");
      if (runId === null || d.runId !== runId) return;
      if (e.type !== "flow.step_started") return;
      const step = d.step as { name?: string } | undefined;
      const stage = stageOf(String(step?.name ?? ""));
      if (!stage || stage === "created") return;
      const n = (drafts.get(stage) ?? 0) + 1;
      drafts.set(stage, n);
      onStage(stage, drafts.get("drafting") ?? 1);
    });
    try {
      onStage("gathering", 1);
      const res = await (this.o.fetchImpl ?? fetch)(`http://127.0.0.1:${end.port}/v1/flows/${PLAYTEST_FLOW}/run`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${end.token}` },
        body: JSON.stringify({ params }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return outcomeOf(res.status, body);
    } catch (e) {
      return { made: false, errors: [signal.aborted ? "Stopped." : e instanceof Error ? e.message : String(e)] };
    } finally {
      unsubscribe();
    }
  }
}
