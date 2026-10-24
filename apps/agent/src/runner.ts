/**
 * The agent loop, and how a turn survives the editor going away.
 *
 * A turn is model call, tool calls, model call, until the model stops asking
 * for tools. It pauses at the tool-call boundary when the editor is down, and
 * resumes on its own when the editor is back. A call that was running when
 * the editor died has an unknown outcome: it is never run again blindly. On
 * reattach the runner reports what it can establish from disk and tells the
 * model to read the state back. After a crash, every change the session made
 * and never saved is listed as lost before the model continues.
 *
 * A command or a file change waits for the user to allow it (gate), unless the
 * setting is off or the user allowed that kind for the session. The request
 * goes out on the event stream and the answer comes back through answerApproval.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ApprovalDecision, ApprovalRequest, Effort, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { ContentBlock, ModelProvider, MessageParam, WebSearchRecord } from "./providers.js";
import { DEFAULT_SESSION_TITLE, SessionStore, type PendingTool, type StoredSession } from "./sessions.js";
import type { QueuedMessage } from "@ue-mcp-studio/shared";
import type { BusyTracker } from "./busy.js";
import type { DialogBroker } from "./dialogs.js";
import type { QaBroker } from "./qa.js";
import { TOOLS, WORK_TOOLS, editorConnected, executeTool, packageFile, validateInput, verifyUnknown, type AgentHost, type ToolExecution } from "./tools.js";
import { CHANGING_TOOLS, approvalFor, shell } from "./local-tools.js";

/** Set by the release bundle: false leaves the Agent SDK out of it. Unset in development and tests. */
declare const __CLAUDE_SIGN_IN__: boolean | undefined;
import { modelName } from "./models.js";
import { AttachmentStore, contentFor } from "./attachments.js";
import { keptName, toolResultContent } from "./images.js";
import { USER_STOP, interruptedResult, interruptionNote, type Interruption } from "./interruptions.js";
import type { Attachment } from "@ue-mcp-studio/shared";

/**
 * Testing gameplay with the user: a test script run as a checklist card in the
 * chat, never a list of steps written out in a reply.
 */
export const QA = [
  "When the user wants gameplay tested or checked in Play In Editor (a QA pass, a test plan, a checklist, steps to try), do not write the steps out as a list in your reply. "
    + "Run them as a ue-mcp test script: pie.script_create saves a script asset to run again later, or pass the steps inline to pie.script_run. Studio shows the run as a live checklist card the user answers in the chat.",
  "Make a step auto with an expect when a value the observer reads can decide it (a property, a distance, visibility), and manual when only a person can judge it (how it looks or feels). Describe pie.script_create first for the step format.",
  "Run it with pie.script_run and wait: true (start_pie: true when PIE is not running), then report the summary and the results_path from its answer. "
    + "The user answers manual steps with the Pass, Fail and Skip buttons on the card. Never call pie.verdict for a manual step yourself unless the user told you that step's outcome in a message. "
    + "If the answer says steps are awaiting a verdict, tell the user to answer them on the card and end your turn.",
];

const WORK = [
  "Anything in the running editor (assets, levels, actors, Blueprints, materials, Niagara) goes through ue_mcp: find the action with ue_mcp search, check its parameters with ue_mcp describe, then call it.",
  "Prefer a dedicated action to editor.execute_python. Save what you change when the task is done, unless the user says otherwise.",
  "Results report what happened (created, existed, updated, saved): read them instead of assuming.",
  "When you name an Unreal asset in a reply, write it as a markdown link to its full object path, for example [SG_PlaceAssembly](/Game/Environment/PCG/Library/SG_PlaceAssembly.SG_PlaceAssembly).",
  "You also have the user's machine: shell for git, builds and scripts; read_file, glob and grep for source, docs and config; write_file and edit_file to change text files; web_fetch to read a URL or call a web API; and web_search when it is offered.",
  "Use those for files, version control and the web, never for what ue_mcp does in the editor. .uasset and .umap files are binary and the editor owns them: change them through ue_mcp, not the file tools.",
  "Stop or restart this project's editor with editor_restart or ue_mcp editor.stop_editor. Never kill an editor process from the shell, by PID or by name: other projects' editors run on the same machine.",
  "Read a file before you edit it. Commands and file changes may wait for the user to allow them; when the user declines one, do not try it again in another form: take another way or ask.",
  ...QA,
];

/** Where the machine tools work, for the prompts. */
const where = (projectDir: string): string =>
  `The project folder is ${projectDir}: commands run there and relative paths start there. The shell is ${shell().name}.`;

const system = (projectDir: string): string => [
  "You work inside Unreal Editor for the user, through ue-mcp, and on the project's files on their machine.",
  ...WORK,
  where(projectDir),
  "For work that splits into independent parts, start a subagent per part with the agent tool, several in one message so they run at the same time. Give each one different assets and files, then check what they report.",
  "When the editor restarts or crashes during your work, a note tells you why and what was lost. Do not repeat a call whose outcome is unknown without reading the state first.",
].join("\n");

/** What a subagent is told: the same way of working, and to end with a report for the agent that started it. */
export const SUBAGENT_SYSTEM = [
  "You are a subagent working inside Unreal Editor through ue-mcp, and on the project's files, on one task another agent gave you.",
  ...WORK,
  "Stay within the task. Other subagents may be working on other assets and files at the same time.",
  "Finish with a short report: what you created or changed (asset paths and files), what you saved, and anything that failed.",
].join("\n");

const subagentSystem = (projectDir: string): string => `${SUBAGENT_SYSTEM}\n${where(projectDir)}`;

/** What the model is told when the user declines a call. */
const declinedText = (name: string): string =>
  `The user declined this ${name === "shell" ? "command" : "file change"}, so it did not run. Do not try it again in another form: take a different approach, or ask the user what they want.`;

/** A gate's answer: run the call (null), or why it must not. */
type GateResult = null | { declined: string } | { stopped: true };

/** What the model is told when the user edits an earlier message and the conversation after it is gone. */
export const REWOUND_NOTE = "The user edited an earlier message, so the conversation was cut back to it and continues from the edited message below. "
  + "Nothing done after it in the earlier version was undone: assets, levels and files it changed stay changed. Read their current state before relying on it.";

/** How many model calls one subagent may make before it is stopped. */
const SUBAGENT_STEPS = 200;

/** How long editor_restart waits for the editor to connect again after the daemon reports it started. */
export const EDITOR_BACK_MS = 10 * 60_000;

/**
 * How long an editor call waits for a disconnected editor when no restart or
 * rebuild is running to bring it back. Past this the call goes ahead and gets
 * the daemon's own answer, instead of the turn waiting on nothing (#1384).
 */
export const IDLE_EDITOR_WAIT_MS = 60_000;

/** Why the daemon went down, written by whatever restarts it on purpose and read by the next daemon. */
export const RESTART_CAUSE_FILE = "restart-cause.json";
const RESTART_CAUSE_TTL_MS = 10 * 60_000;

export interface RunnerOptions {
  host: AgentHost;
  store: SessionStore;
  provider: () => ModelProvider;
  model: () => string;
  /** How long the model reasons; high when not given. */
  effort?: () => Effort;
  /** The turn runs on the Claude subscription through the Agent SDK. */
  subscription?: () => boolean;
  /** How the model is reached for this turn: a sign-in or a key, by name. */
  route?: () => string | null;
  /** Ask the user before a command runs or a file changes; on when not given. */
  askBeforeChanges?: () => boolean;
  /** Tracks each turn's editor calls, for the window's busy state. */
  busy?: BusyTracker;
  /** Puts the editor dialogs a session's calls meet in the chat. */
  dialogs?: DialogBroker;
  /** Puts the PIE test script runs a session's calls start in the chat, as checklists. */
  qa?: QaBroker;
}

const now = (): string => new Date().toISOString();

/** A promise's value, or null as soon as the signal aborts. The work goes on; its result is dropped. */
export function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => {
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    }, (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}

/** The conversation so far as text, for a Claude session that starts in the middle of it. Keeps the most recent part when long. */
/**
 * A call ue-mcp answered without doing it: a result whose JSON says success is
 * false, or that the call was blocked or refused. ue-mcp returns these as
 * ordinary results, so the call would otherwise read as done.
 */
export function refused(result: unknown): boolean {
  if (typeof result !== "string" || !result.trimStart().startsWith("{")) return false;
  try {
    const r = JSON.parse(result) as Record<string, unknown>;
    return r.success === false || r.blocked === true || r.dialogBlocking === true || typeof r.refusedMethod === "string";
  } catch {
    return false;
  }
}

export function carryOver(messages: MessageParam[], max = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>);
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim() && !p.text.startsWith("[Studio]")) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${p.text.trim()}`);
      else if (p.type === "tool_use" && p.name) lines.push(`Assistant called ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 300)}`);
    }
  }
  let text = lines.join("\n\n");
  if (text.length > max) text = `(earlier part left out)\n\n${text.slice(text.length - max)}`;
  return `[Studio] This session continues a conversation that ran on other models. Here it is so far:\n\n${text}\n\n[Studio] End of the earlier conversation. The user's new message follows.`;
}

export class AgentRunner {
  private readonly active = new Map<string, AbortController>();
  /** Each running subagent, by its agent call id, so one can be stopped without the turn. */
  private readonly subagents = new Map<string, () => void>();
  /** Calls waiting for the user, by approval id, with how to answer each. */
  private readonly waitingApprovals = new Map<string, { sessionId: string; parent: string | null; answer: (d: ApprovalDecision | "stopped") => void }>();
  /** Why the editor last went away, for waiting turns and unknown outcomes. */
  private lastCause = "the editor is not connected";
  private readonly unsubscribe: () => void;
  /** Where the images a tool showed the model are kept for the panel. */
  private readonly files: AttachmentStore;

  constructor(private readonly o: RunnerOptions) {
    this.files = new AttachmentStore(o.host.dataDir);
    o.host.setBusy(() => o.store.all().some((s) => s.status === "running" || s.status === "waiting"));
    this.unsubscribe = o.host.events.subscribe((e) => {
      if (e.type === "editor.disconnected") {
        const cause = String(e.data.cause ?? "unknown");
        this.lastCause = cause === "crashed" ? "the editor crashed"
          : cause === "closed" ? "the editor was closed"
          : cause === "restarting" ? "the editor is restarting"
          : cause === "rebuild" ? "the project is rebuilding"
          : "the editor connection dropped";
        if (cause === "crashed") {
          for (const s of o.store.all()) {
            if (s.touched.length > 0) {
              s.crashed = true;
              o.store.save(s);
            }
          }
        }
      } else if (e.type === "editor.connected") {
        this.resumeAll();
      } else if (e.type === "studio.busy.changed" && e.data.failure && !e.data.operation) {
        // The restart or rebuild ended without the editor: nothing will bring it back, so stop waiting for it.
        this.resumeAll();
      }
    });
  }

  /** The host a session's tool calls run on: its editor calls are tracked when there is a busy tracker. */
  private hostFor(sessionId: string): AgentHost {
    const host = this.o.dialogs ? this.o.dialogs.wrap(this.o.host, sessionId) : this.o.host;
    const tracked = this.o.busy ? this.o.busy.wrap(host, sessionId) : host;
    return this.o.qa ? this.o.qa.wrap(tracked, sessionId) : tracked;
  }

  /** The daemon is going down: every turn on the SDK route ends here, saying so. An API turn resumes in the next daemon. */
  dispose(): void {
    this.unsubscribe();
    const cause: Interruption = { by: "studio", why: this.restartCause(false) ?? "Studio's daemon shut down" };
    for (const [id, c] of [...this.active]) {
      if (this.o.subscription?.()) this.interrupt(id, cause);
      else c.abort(cause);
    }
  }

  /** Why a deliberate daemon restart happened, when it left a recent note. `consume` deletes the note. */
  private restartCause(consume: boolean): string | null {
    const file = `${this.o.host.dataDir}/${RESTART_CAUSE_FILE}`;
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf-8")) as { cause?: unknown; at?: unknown };
      if (consume) fs.rmSync(file, { force: true });
      return typeof r.cause === "string" && typeof r.at === "number" && Date.now() - r.at < RESTART_CAUSE_TTL_MS ? r.cause : null;
    } catch {
      return null;
    }
  }

  /** After a daemon restart: anything that was mid-turn continues, and a call that was mid-flight becomes unknown. */
  recover(): void {
    const why = this.restartCause(true) ?? "Studio's daemon restarted";
    for (const s of this.o.store.all()) {
      const asked = new Set((s.approvals ?? []).map((a) => a.toolUseId));
      // An approval only the previous daemon could answer; its call asks again when the turn resumes.
      if (s.approvals?.length) {
        s.approvals = [];
        this.o.store.save(s);
      }
      if (s.status !== "running" && s.status !== "waiting") continue;
      if (this.o.subscription?.()) {
        // The SDK cannot pick up a turn a restart cut off: end it, saying what was cut off and by what.
        this.endTurn(s, { by: "studio", why }, asked);
        continue;
      }
      for (const p of s.pending ?? []) if (p.state === "running") p.state = "unknown";
      s.status = "waiting";
      s.waitingCause = s.waitingCause ?? why.replace(/^Studio's daemon/, "the daemon");
      this.o.store.save(s);
    }
    this.resumeAll();
  }

  resumeAll(): void {
    for (const s of this.o.store.all()) {
      if (s.status === "waiting" && !this.active.has(s.id)) void this.runTurn(s.id);
    }
  }

  /** Add the user's message and run the turn. Resolves when the turn ends, pauses or fails. */
  async send(sessionId: string, text: string, attachments: Array<Attachment & { path: string }> = []): Promise<void> {
    const s = this.require(sessionId);
    if (this.active.has(s.id) || s.status === "running" || s.status === "waiting") {
      throw new Error("a turn is already in progress; stop it or wait for it to finish");
    }
    s.archived = false;
    if (s.messages.length === 0 && s.title === DEFAULT_SESSION_TITLE) s.title = text.trim().split("\n")[0].slice(0, 60) || attachments[0]?.name || s.title;
    if (s.crashed) this.reconcileCrash(s);
    const content: unknown[] = [];
    for (const note of s.notes.splice(0)) content.push({ type: "text", text: `[Studio] ${note}` });
    for (const a of attachments) content.push(...(await contentFor(a)));
    if (text.trim()) content.push({ type: "text", text });
    s.messages.push({ role: "user", content } as MessageParam);
    s.transcript.push({
      kind: "user",
      text,
      at: now(),
      ...(attachments.length ? { attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
    });
    s.draft = "";
    s.error = null;
    this.setStatus(s, "running", null);
    const onClaude = !!this.o.subscription?.();
    const rewound = !!s.rewound;
    s.rewound = false;
    s.model = this.o.model();
    s.route = this.o.route?.() ?? null;
    if (onClaude) {
      // The SDK session has not seen the turns that ran on other models: a new one starts, carrying the whole conversation.
      const earlier = s.messages.slice(0, -1);
      if (earlier.length > 0 && (!s.sdkSession || s.offClaude)) {
        if (s.sdkSession) s.sdkPast = [...(s.sdkPast ?? []), s.sdkSession];
        s.sdkSession = null;
        s.offClaude = false;
        // After an edit the model only changed sessions, not the user: nothing to tell them.
        if (!rewound) this.addEntry(s, { kind: "note", text: `On ${modelName(s.model)} via your Claude sign-in from here, with the whole conversation so far.`, at: now() });
        return this.runSubscription(s.id, [{ type: "text", text: carryOver(earlier) }, ...content]);
      }
      return this.runSubscription(s.id, content);
    }
    // The Claude conversation misses this turn: a later turn on the Claude sign-in carries the whole session again.
    if (s.sdkSession) s.offClaude = true;
    await this.runTurn(s.id);
  }

  /** The Agent SDK runs the loop; tool calls still go through executeTool and the transcript. */
  private async runSubscription(id: string, prompt: unknown[]): Promise<void> {
    const controller = new AbortController();
    this.active.set(id, controller);
    const s = this.require(id);
    let lastId: string | null = null;
    // Agent calls the SDK runs in the background: their tool result only says they started.
    const background = new Set<string>();
    try {
      // A dynamic import the bundler drops when the sign-in is off, and the Agent SDK with it.
      const sdk = typeof __CLAUDE_SIGN_IN__ === "undefined" || __CLAUDE_SIGN_IN__ ? await import("./subscription.js") : null;
      if (!sdk) throw new Error("This Studio build does not include the Claude sign-in.");
      const error = await sdk.runSubscriptionTurn({
        projectDir: this.o.host.projectDir,
        model: this.o.model(),
        effort: this.o.effort?.() ?? "high",
        system: system(this.o.host.projectDir),
        subagentSystem: subagentSystem(this.o.host.projectDir),
        prompt,
        resume: s.sdkSession ?? null,
        signal: controller.signal,
        onSession: (sid) => {
          s.sdkSession = sid;
          this.o.store.save(s);
        },
        onDelta: (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
        onAssistant: (mid, blocks, parent) => {
          // A subagent's messages are its own conversation: only the main agent's mirror into the session's.
          if (!parent) {
            const last = s.messages[s.messages.length - 1];
            if (mid === lastId && last?.role === "assistant" && Array.isArray(last.content)) (last.content as ContentBlock[]).push(...blocks);
            else s.messages.push({ role: "assistant", content: blocks } as MessageParam);
            lastId = mid;
          }
          const tag = parent ? { parent } : {};
          for (const b of blocks) {
            if (b.type === "text" && b.text) this.addEntry(s, { kind: "assistant", text: b.text, at: now(), ...tag });
            if (b.type === "tool_use") {
              this.addEntry(s, { kind: "tool", call: { id: b.id, name: b.name, input: b.input, outcome: "pending", startedAt: now() }, ...tag });
            }
          }
          this.o.store.save(s);
        },
        onToolResults: (content, parent) => {
          if (!parent) {
            s.messages.push({ role: "user", content } as MessageParam);
            lastId = null;
          }
          // Studio's own tools record their outcome as they run; an agent call's result arrives only here.
          for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (b.type !== "tool_result" || !b.tool_use_id) continue;
            const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === b.tool_use_id);
            if (entry?.kind !== "tool" || entry.call.outcome !== "pending" || background.has(b.tool_use_id)) continue;
            const text = typeof b.content === "string" ? b.content
              : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
            this.recordOutcome(s, { id: b.tool_use_id, name: entry.call.name, input: {}, state: "done", result: text, isError: !!b.is_error }, b.is_error ? "error" : "done");
          }
          this.o.store.save(s);
        },
        onTask: (toolUseId, status, detail) => {
          if (status === "started") {
            if (detail.background) background.add(toolUseId);
            return;
          }
          // A subagent that ended cannot be waiting on the user any more.
          this.dropApprovals(s.id, toolUseId);
          const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId);
          if (entry?.kind !== "tool" || entry.call.outcome !== "pending") return;
          const failed = status !== "completed";
          const result = detail.summary || (status === "stopped" ? "Stopped by the user." : "");
          this.recordOutcome(s, { id: toolUseId, name: entry.call.name, input: {}, state: "done", result, isError: failed }, status === "stopped" ? "stopped" : failed ? "error" : "done");
        },
        onStopper: (callId, stop) => {
          if (stop) this.subagents.set(callId, () => void stop());
          else this.subagents.delete(callId);
        },
        runTool: async (toolId, name, input) => {
          // The turn ended while the binary was still asking: nothing runs after a stop.
          if (controller.signal.aborted) return { text: interruptedResult({ name, input }, this.causeOf(controller), false), isError: true, outcome: "error", touched: [], saved: [] };
          // A subagent's call also ends when the user stops that subagent.
          const owner = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolId)?.parent;
          const sub = owner ? this.subagentAbort(owner).signal : null;
          const signal = sub ? AbortSignal.any([controller.signal, sub]) : controller.signal;
          const stoppedHere = (): ToolExecution => ({ text: interruptedResult({ name, input }, USER_STOP, true), isError: true, outcome: "error", touched: [], saved: [] });
          if (sub?.aborted) return stoppedHere();
          if (name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, signal);
          if (sub?.aborted) return stoppedHere();
          const gate = await this.gate(s, toolId, name, input, signal);
          if (sub?.aborted) return stoppedHere();
          if (gate) {
            const text = "stopped" in gate ? "Stopped by the user." : gate.declined;
            this.recordOutcome(s, { id: toolId, name, input, state: "done", result: text, isError: true }, "stopped" in gate ? "stopped" : "declined");
            return { text, isError: true, outcome: "error", touched: [], saved: [] };
          }
          const running = executeTool(this.hostFor(s.id), name, input, signal);
          // What a call does after its subagent was stopped is still tracked for the crash report.
          if (sub) void running.then((e) => sub.aborted && this.mergeTouched(s, e.touched, e.outcome !== "unknown"), () => {});
          const done = sub ? await unlessAborted(running, sub) : await running;
          if (!done) return stoppedHere();
          let exec = done;
          this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
          // Stopped while the editor worked: the stop already answered this call.
          if (controller.signal.aborted) return exec;
          if (name === "editor_restart" && !exec.isError) exec = await this.editorBack(s, exec, controller.signal);
          if (controller.signal.aborted) return exec;
          this.markSaved(s, exec.saved);
          const p: PendingTool = { id: toolId, name, input, state: "done", result: exec.text, isError: exec.isError, ...(exec.images ? { images: exec.images } : {}) };
          this.recordOutcome(s, p, exec.outcome);
          if (s.status !== "running") this.setStatus(s, "running", null);
          return exec;
        },
      });
      if (controller.signal.aborted) return;
      s.error = error;
      this.setStatus(s, error ? "error" : "idle", null);
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
      for (const t of s.transcript) if (t.kind === "tool" && t.call.name === "agent") this.subagentStops.delete(t.call.id);
      // A call the turn ended without answering never finishes now. A stop answered its own already.
      if (!controller.signal.aborted) this.endCalls(s, () => "The turn ended before this call returned a result.", "error");
    }
  }

  /** What a turn's controller was aborted for. */
  private causeOf(c: AbortController): Interruption {
    const r = c.signal.reason as Interruption | undefined;
    return r && (r.by === "user" || r.by === "studio") ? r : USER_STOP;
  }

  /**
   * After editor_restart reports the editor started: the turn goes on once the
   * editor has connected again, so the model's next call finds it. The result
   * says which happened.
   */
  private async editorBack(s: StoredSession, exec: ToolExecution, signal: AbortSignal): Promise<ToolExecution> {
    const back = await this.waitForEditor(s, signal, EDITOR_BACK_MS);
    if (signal.aborted) return exec;
    return {
      ...exec,
      text: back
        ? `${exec.text}\nThe editor is running and connected.`
        : `${exec.text}\nThe editor has not connected within ${EDITOR_BACK_MS / 60_000} minutes of starting. Check it with ue_mcp project.get_status before going on.`,
    };
  }

  /**
   * Why the editor is not here right now. A restart or rebuild that has ended
   * no longer is the reason, whatever the last disconnect said.
   */
  private causeNow(): string {
    const busy = this.o.busy?.state();
    if (busy?.operation) {
      const op = busy.operation.op;
      return op === "rebuild" ? "the project is rebuilding" : op === "stop" ? "the editor is stopping" : op === "start" ? "the editor is starting" : "the editor is restarting";
    }
    if (busy?.failure) return `the ${busy.failure.op} did not bring the editor back: ${busy.failure.reason}`;
    if (this.o.busy && (this.lastCause === "the project is rebuilding" || this.lastCause === "the editor is restarting")) return "the editor is not running";
    return this.lastCause;
  }

  /** Whether a restart or rebuild is under way that will bring the editor back. */
  private operating(): boolean {
    return this.o.busy ? !!this.o.busy.state().operation : true;
  }

  /**
   * Hold a tool call until the editor is back, showing the session as waiting
   * meanwhile. While a restart or rebuild runs it waits up to `limitMs`; with
   * none running, only IDLE_EDITOR_WAIT_MS. False when it gave up first.
   */
  private async waitForEditor(s: StoredSession, signal: AbortSignal, limitMs = Infinity): Promise<boolean> {
    if (editorConnected(this.o.host)) return true;
    const start = Date.now();
    const end = start + limitMs;
    let cause = this.causeNow();
    this.setStatus(s, "waiting", cause);
    while (!editorConnected(this.o.host) && !signal.aborted && Date.now() < end && (this.operating() || Date.now() - start < IDLE_EDITOR_WAIT_MS)) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = this.causeNow();
      if (now !== cause && !signal.aborted && !editorConnected(this.o.host)) this.setStatus(s, "waiting", (cause = now));
    }
    if (!signal.aborted) this.setStatus(s, "running", null);
    return editorConnected(this.o.host);
  }

  /** The user's Stop. Unanswered tool calls are answered as stopped so the conversation stays valid. */
  stop(sessionId: string): void {
    this.interrupt(sessionId, USER_STOP);
  }

  /** The sessions with a turn running or waiting. */
  activeSessions(): string[] {
    return this.o.store.all().filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.id);
  }

  /**
   * End a turn now: the user stopped it, or Studio has to (its daemon is about
   * to restart). Every call it leaves unanswered says who ended it and what
   * goes on regardless, and the model hears the same with the next message.
   */
  interrupt(sessionId: string, cause: Interruption): void {
    const s = this.require(sessionId);
    const asked = new Set((s.approvals ?? []).map((a) => a.toolUseId));
    this.active.get(s.id)?.abort(cause);
    this.active.delete(s.id);
    this.endTurn(s, cause, asked);
  }

  /** Answer what a turn left open, leave the model a note, and set the session's state. `asked`: calls waiting for approval, which never ran. */
  private endTurn(s: StoredSession, cause: Interruption, asked: Set<string>): void {
    const running: Array<{ name: string; input: Record<string, unknown> }> = [];
    const outcome = cause.by === "user" ? "stopped" : "unknown";
    if (s.pending) {
      for (const p of s.pending) {
        if (p.state === "done") continue;
        const ran = p.state === "running" || p.state === "unknown";
        if (ran) running.push(p);
        p.state = "done";
        p.result = interruptedResult(p, cause, ran);
        p.isError = true;
        this.recordOutcome(s, p, outcome);
      }
      this.flushPending(s);
    }
    this.endCalls(s, (call) => {
      const ran = !asked.has(call.id);
      if (ran && !call.parent) running.push(call);
      return interruptedResult(call, cause, ran);
    }, outcome);
    if (running.length > 0 || cause.by === "studio") {
      const note = interruptionNote(running, cause);
      s.notes.push(note);
      this.addEntry(s, { kind: "note", text: note, at: now() });
    }
    if (cause.by === "user") {
      this.setStatus(s, "stopped", null);
    } else {
      s.error = `The turn ended because ${cause.why}. Send a message to continue.`;
      this.setStatus(s, "error", null);
    }
  }

  /** Every call the transcript still shows running, answered with the text `result` gives it. */
  private endCalls(
    s: StoredSession,
    result: (call: { id: string; name: string; input: Record<string, unknown>; parent?: string }) => string,
    outcome: "stopped" | "unknown" | "error",
    parent?: string,
  ): void {
    for (const t of s.transcript) {
      if (t.kind !== "tool" || t.call.outcome !== "pending") continue;
      if (parent !== undefined && t.parent !== parent) continue;
      const call = { id: t.call.id, name: t.call.name, input: (t.call.input ?? {}) as Record<string, unknown>, ...(t.parent ? { parent: t.parent } : {}) };
      this.recordOutcome(s, { id: call.id, name: call.name, input: call.input, state: "done", result: result(call), isError: true }, outcome);
    }
  }

  /**
   * Stop one subagent and let the turn go on: the main agent is told the user
   * stopped it. Returns false when no subagent of that id is running.
   */
  stopSubagent(sessionId: string, callId: string): boolean {
    const s = this.require(sessionId);
    const stop = this.subagents.get(callId);
    if (!stop) return false;
    stop();
    // Its calls in flight are let go now, as Stop lets a turn's go: each says it was stopped, whatever it returns later.
    this.subagentAbort(callId).abort(USER_STOP);
    this.endSubagentCalls(s, callId);
    return true;
  }

  /** Each subagent's own stop signal, by its agent call id, for the calls it makes. */
  private readonly subagentStops = new Map<string, AbortController>();
  private subagentAbort(callId: string): AbortController {
    let c = this.subagentStops.get(callId);
    if (!c) this.subagentStops.set(callId, (c = new AbortController()));
    return c;
  }

  /** Answer every call a stopped subagent still has running, the way Stop answers a turn's. */
  private endSubagentCalls(s: StoredSession, callId: string): void {
    this.endCalls(s, (call) => interruptedResult(call, USER_STOP, true), "stopped", callId);
  }

  /**
   * Hold a command or a file change until the user answers. Returns null to
   * run it, or why it must not run: declined, or the turn was stopped.
   */
  private async gate(s: StoredSession, toolUseId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<GateResult> {
    if (!(CHANGING_TOOLS as readonly string[]).includes(name)) return null;
    // A bad input fails in the executor without changing anything.
    if (validateInput(name, input)) return null;
    if (!(this.o.askBeforeChanges?.() ?? true)) return null;
    const kind = name === "shell" ? "shell" : "edit";
    if (s.allowed?.includes(kind)) return null;
    const preview = approvalFor(this.o.host.projectDir, name, input);
    if (!preview) return null;
    if (signal.aborted) return { stopped: true };

    const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId);
    const parent = entry?.parent ?? null;
    const agent = parent ? s.transcript.find((t) => t.kind === "tool" && t.call.id === parent) : undefined;
    const subagent = agent?.kind === "tool" ? (agent.call.input as { description?: unknown }).description : undefined;
    const req: ApprovalRequest = { id: crypto.randomUUID(), toolUseId, parent, ...(typeof subagent === "string" ? { subagent } : {}), ...preview, at: now() };

    const decision = await new Promise<ApprovalDecision | "stopped">((resolve) => {
      const onAbort = () => resolve("stopped");
      signal.addEventListener("abort", onAbort, { once: true });
      this.waitingApprovals.set(req.id, {
        sessionId: s.id,
        parent,
        answer: (d) => {
          signal.removeEventListener("abort", onAbort);
          resolve(d);
        },
      });
      s.approvals = [...(s.approvals ?? []), req];
      this.o.store.save(s);
      this.o.host.events.publish("approval.requested", { sessionId: s.id, approvalId: req.id, tool: name });
      this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    });

    this.waitingApprovals.delete(req.id);
    s.approvals = (s.approvals ?? []).filter((a) => a.id !== req.id);
    if (decision === "session") s.allowed = [...new Set([...(s.allowed ?? []), kind])];
    this.o.store.save(s);
    this.o.host.events.publish("approval.resolved", { sessionId: s.id, approvalId: req.id, decision });
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    if (decision === "stopped") return { stopped: true };
    if (decision === "deny") return { declined: declinedText(name) };
    return null;
  }

  /** The user's answer to a waiting call. False when no such approval is waiting in that session. */
  answerApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const w = this.waitingApprovals.get(approvalId);
    if (!w || w.sessionId !== sessionId) return false;
    w.answer(decision);
    return true;
  }

  /** Answer as stopped every approval a subagent left waiting. */
  private dropApprovals(sessionId: string, parent: string): void {
    for (const w of [...this.waitingApprovals.values()]) if (w.sessionId === sessionId && w.parent === parent) w.answer("stopped");
  }

  /** A provider's own web searches, as finished calls in the transcript. */
  private recordSearches(s: StoredSession, searches: WebSearchRecord[] | undefined, parent?: string): void {
    for (const w of searches ?? []) {
      const result = w.error ? `The search failed: ${w.error}` : w.results.map((r) => `${r.title}\n${r.url}`).join("\n\n") || "No results.";
      const at = now();
      this.addEntry(s, { kind: "tool", call: { id: w.id, name: "web_search", input: { query: w.query }, outcome: w.error ? "error" : "done", result, startedAt: at, endedAt: at }, ...(parent ? { parent } : {}) });
    }
  }

  private require(id: string): StoredSession {
    const s = this.o.store.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return s;
  }

  private setStatus(s: StoredSession, status: StoredSession["status"], waitingCause: string | null): void {
    s.status = status;
    s.waitingCause = waitingCause;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status, waitingCause });
    // A turn that finished sends the next queued message. One that stopped or failed leaves the queue for the user.
    if (status === "idle" && s.queue?.length) setTimeout(() => void this.sendQueued(s.id), 0);
  }

  /** Queue a message behind the running turn. With no turn running it is sent at once. */
  enqueue(sessionId: string, text: string, attachments: Attachment[]): QueuedMessage {
    const s = this.require(sessionId);
    const q: QueuedMessage = { id: crypto.randomUUID(), text, attachments, at: now() };
    s.queue = [...(s.queue ?? []), q];
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    if (!this.busy(s)) void this.sendQueued(s.id);
    return q;
  }

  /** Change a queued message's text, or remove it. False when it has been sent already. */
  editQueued(sessionId: string, id: string, text: string | null): boolean {
    const s = this.require(sessionId);
    const q = s.queue?.find((x) => x.id === id);
    if (!q) return false;
    if (text === null) s.queue = s.queue!.filter((x) => x.id !== id);
    else q.text = text;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return true;
  }

  /** Send the first queued message, when no turn is running. */
  async sendQueued(sessionId: string): Promise<void> {
    const s = this.o.store.get(sessionId);
    if (!s || this.busy(s) || !s.queue?.length) return;
    const [next, ...rest] = s.queue;
    s.queue = rest;
    this.o.store.save(s);
    const files = next.attachments.flatMap((a) => {
      const f = this.files.get(s.id, a.id);
      return f ? [f] : [];
    });
    await this.send(s.id, next.text, files).catch((e) => this.o.host.log.warn(`a queued message in session ${s.id} failed`, e));
  }

  /** Stop the running turn, as Stop does, and send this message now, ahead of the queue. */
  async sendNow(sessionId: string, text: string, attachments: Array<Attachment & { path: string }> = []): Promise<void> {
    const s = this.require(sessionId);
    if (this.busy(s)) this.stop(sessionId);
    await this.send(sessionId, text, attachments);
  }

  /**
   * Replace one of the user's messages: the conversation is cut back to just
   * before it, for the model as well as the panel, and the new text is sent
   * as a new turn with the files the message carried. A running turn is
   * stopped first. What the agent changed in the project stays changed.
   */
  async editMessage(sessionId: string, index: number, text: string): Promise<boolean> {
    const s = this.require(sessionId);
    const entry = s.transcript[index];
    if (!entry || entry.kind !== "user" || entry.parent) return false;
    const notes = s.notes.length;
    if (this.busy(s)) this.stop(sessionId);
    // What the stop would tell the model is about turns the edit removes.
    s.notes = s.notes.slice(0, notes);
    const files = (entry.attachments ?? []).flatMap((a) => {
      const f = this.files.get(s.id, a.id);
      return f ? [f] : [];
    });
    const later = index < s.transcript.length - 1;
    SessionStore.truncateAt(s, index);
    if (later) s.notes.push(REWOUND_NOTE);
    s.status = "idle";
    s.waitingCause = null;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: null });
    await this.send(s.id, text, files);
    return true;
  }

  /**
   * Edit one of the user's messages into a new session: a copy of this one up
   * to just before the message, which then continues from the new text. The
   * original is left as it was, running or not. Returns the new session's id.
   */
  async forkAt(sessionId: string, index: number, text: string): Promise<string | null> {
    const s = this.require(sessionId);
    const entry = s.transcript[index];
    if (!entry || entry.kind !== "user" || entry.parent) return null;
    const fork = this.o.store.create(`${s.title} (fork)`);
    const copy = structuredClone(s);
    Object.assign(copy, { id: fork.id, title: fork.title, createdAt: fork.createdAt, updatedAt: fork.updatedAt, status: "idle", waitingCause: null, notes: [], draft: "", crashed: false });
    SessionStore.truncateAt(copy, index);
    // The original's Claude conversations stay the original's: deleting the fork must not take them with it.
    copy.sdkPast = [];
    copy.archived = false;
    if (index < s.transcript.length - 1) copy.notes.push(REWOUND_NOTE);
    this.files.copy(s.id, copy.id);
    this.o.store.save(copy);
    this.o.host.events.publish("session.changed", { sessionId: copy.id, status: copy.status, waitingCause: null });
    const files = (entry.attachments ?? []).flatMap((a) => {
      const f = this.files.get(copy.id, a.id);
      return f ? [f] : [];
    });
    // The fork answers with its id at once; its first turn runs on.
    this.send(copy.id, text, files).catch((e) => this.o.host.log.warn(`the fork of session ${s.id} failed`, e));
    return copy.id;
  }

  private busy(s: StoredSession): boolean {
    return this.active.has(s.id) || s.status === "running" || s.status === "waiting";
  }

  private addEntry(s: StoredSession, entry: TranscriptEntry): void {
    s.transcript.push(entry);
    this.o.store.save(s);
    this.o.host.events.publish("transcript.added", { sessionId: s.id, entry: entry as unknown as Record<string, unknown> });
  }

  private async runTurn(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.active.set(id, controller);
    const s = this.require(id);
    if (this.o.subscription?.()) {
      // The SDK cannot pick up a turn a restart cut off; its session continues from the next message.
      this.active.delete(id);
      s.error = "The turn was interrupted. Send the next message to continue.";
      this.setStatus(s, "error", null);
      return;
    }
    try {
      for (;;) {
        if (controller.signal.aborted) return;

        if (s.pending) {
          const paused = await this.answerPending(s, controller.signal);
          if (paused || controller.signal.aborted) return;
        }

        if (s.status !== "running") this.setStatus(s, "running", null);
        const turn = await this.o.provider().run(
          { sessionId: s.id, model: this.o.model(), effort: this.o.effort?.(), system: [{ type: "text", text: system(this.o.host.projectDir) }], tools: TOOLS, messages: s.messages },
          (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
          controller.signal,
        );
        if (controller.signal.aborted) return;

        s.messages.push({ role: "assistant", content: turn.content } as MessageParam);
        this.recordSearches(s, turn.searches);
        const text = turn.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
        if (text) this.addEntry(s, { kind: "assistant", text, at: now() });

        if (turn.stopReason === "refusal") {
          s.error = `The model declined: ${turn.refusal ?? "no reason given"}`;
          this.setStatus(s, "error", null);
          return;
        }
        // A long server-side step (a web search) paused the turn: send it back to go on.
        if (turn.stopReason === "pause_turn") continue;
        const uses = turn.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (turn.stopReason !== "tool_use" || uses.length === 0) {
          this.setStatus(s, "idle", null);
          return;
        }
        s.pending = uses.map((u) => ({ id: u.id, name: u.name, input: (u.input ?? {}) as Record<string, unknown>, state: "queued" }));
        for (const p of s.pending) {
          this.addEntry(s, { kind: "tool", call: { id: p.id, name: p.name, input: p.input, outcome: "pending", startedAt: now() } });
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      s.error = e instanceof Error ? e.message : String(e);
      this.setStatus(s, "error", null);
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }

  /**
   * Answer every pending tool call, in order. Returns true when the turn
   * paused for the editor and must wait for it to come back.
   */
  private async answerPending(s: StoredSession, signal: AbortSignal): Promise<boolean> {
    const pending = s.pending!;
    // Subagents run at the same time, before the calls the main agent makes itself.
    const agents = pending.filter((p) => p.name === "agent" && p.state === "queued");
    if (agents.length > 0) {
      for (const p of agents) p.state = "running";
      this.o.store.save(s);
      await Promise.all(agents.map(async (p) => {
        const r = await this.runSubagent(s, p, signal);
        if (signal.aborted) return;
        p.state = "done";
        p.result = r.text;
        p.isError = r.isError;
        this.recordOutcome(s, p, r.stopped ? "stopped" : r.isError ? "error" : "done");
      }));
      if (signal.aborted) return true;
    }
    for (const p of pending) {
      if (signal.aborted) return true;
      if (p.state === "done") continue;

      if (p.state === "unknown" && p.name === "agent") {
        p.state = "done";
        p.result = `The subagent was cut off (${s.waitingCause ?? this.lastCause}) before it reported. Read back the state of what it was working on before redoing any of it.`;
        p.isError = true;
        this.recordOutcome(s, p, "unknown");
        continue;
      }

      if (p.state === "unknown") {
        if (!editorConnected(this.o.host)) return this.pause(s);
        p.state = "done";
        p.result = verifyUnknown(this.o.host, p.input, s.waitingCause ?? this.lastCause);
        p.isError = true;
        this.recordOutcome(s, p, "unknown");
        continue;
      }

      const needsEditor = p.name === "ue_mcp" && p.input.action === "call";
      // Paused only while a restart or rebuild will bring the editor back; otherwise the call gets the daemon's own answer.
      if (needsEditor && !editorConnected(this.o.host) && this.operating()) return this.pause(s);

      // Waiting for the user leaves the call queued, so a daemon restart asks again rather than guessing.
      const gate = await this.gate(s, p.id, p.name, p.input, signal);
      if (gate && "stopped" in gate) return true;
      if (gate) {
        p.state = "done";
        p.result = gate.declined;
        p.isError = true;
        this.recordOutcome(s, p, "declined");
        continue;
      }

      p.state = "running";
      this.o.store.save(s);
      const exec = await executeTool(this.hostFor(s.id), p.name, p.input, signal);
      if (signal.aborted) {
        // Stopped while the editor worked: the stop already answered this call.
        this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
        this.o.store.save(s);
        return true;
      }
      if (exec.outcome === "unknown") {
        p.state = "unknown";
        this.mergeTouched(s, exec.touched, false);
        this.o.store.save(s);
        return this.pause(s);
      }
      p.state = "done";
      p.result = exec.text;
      p.isError = exec.isError;
      if (exec.images) p.images = exec.images;
      this.mergeTouched(s, exec.touched, true);
      this.markSaved(s, exec.saved);
      this.recordOutcome(s, p, exec.outcome);
      if (p.name === "editor_restart" && !exec.isError && !editorConnected(this.o.host) && this.operating()) {
        // The restart returned; wait for the editor to reattach before the model continues.
        // Bounded: the busy tracker ends the wait for it to attach, and that resumes this turn.
        this.flushPending(s);
        return this.pause(s);
      }
    }
    this.flushPending(s);
    return false;
  }

  /**
   * One subagent: its own conversation on the same model, with the work tools
   * only. Its steps go into the session's transcript under the agent call; the
   * main agent gets its final report as the call's result.
   */
  private async runSubagent(s: StoredSession, call: PendingTool, signal: AbortSignal): Promise<{ text: string; isError: boolean; stopped?: boolean }> {
    const prompt = call.input.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) return { text: "Invalid input: agent needs prompt", isError: true };
    const parent = call.id;
    const messages: MessageParam[] = [{ role: "user", content: prompt }];
    let report = "";
    const turnSignal = signal;
    const own = new AbortController();
    const follow = () => own.abort();
    turnSignal.addEventListener("abort", follow);
    this.subagents.set(call.id, () => own.abort());
    this.subagentAbort(call.id).signal.addEventListener("abort", () => own.abort(), { once: true });
    signal = own.signal;
    const stopped = () => (turnSignal.aborted
      ? { text: "Stopped by the user.", isError: true }
      : { text: "The user stopped this subagent before it finished. Do not redo its task unless the user asks.", isError: true, stopped: true });
    try {
      for (let step = 0; step < SUBAGENT_STEPS; step++) {
        if (signal.aborted) return stopped();
        const turn = await this.o.provider().run(
          { sessionId: s.id, model: this.o.model(), effort: this.o.effort?.(), system: [{ type: "text", text: subagentSystem(this.o.host.projectDir) }], tools: WORK_TOOLS, messages },
          () => {},
          signal,
        );
        messages.push({ role: "assistant", content: turn.content } as MessageParam);
        this.recordSearches(s, turn.searches, parent);
        const text = turn.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
        if (text) {
          report = text;
          this.addEntry(s, { kind: "assistant", text, at: now(), parent });
        }
        if (turn.stopReason === "refusal") return { text: `The subagent's model declined: ${turn.refusal ?? "no reason given"}`, isError: true };
        if (turn.stopReason === "pause_turn") continue;
        const uses = turn.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (turn.stopReason !== "tool_use" || uses.length === 0) return { text: report || "The subagent finished without a report.", isError: false };
        const results: Array<{ type: "tool_result"; tool_use_id: string; content: ReturnType<typeof toolResultContent>; is_error?: boolean }> = [];
        for (const u of uses) {
          const input = (u.input ?? {}) as Record<string, unknown>;
          this.addEntry(s, { kind: "tool", call: { id: u.id, name: u.name, input, outcome: "pending", startedAt: now() }, parent });
          if (u.name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, signal);
          if (signal.aborted) return stopped();
          const gate = await this.gate(s, u.id, u.name, input, signal);
          if (gate && "stopped" in gate) return stopped();
          if (gate) {
            this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: gate.declined, isError: true }, "declined");
            results.push({ type: "tool_result", tool_use_id: u.id, content: gate.declined, is_error: true });
            continue;
          }
          const running = executeTool(this.hostFor(s.id), u.name, input, signal);
          // A stop lets the call go at once; what it does after is still tracked for the crash report.
          void running.then((e) => signal.aborted && this.mergeTouched(s, e.touched, e.outcome !== "unknown"), () => {});
          const exec = await unlessAborted(running, signal);
          if (!exec || signal.aborted) return stopped();
          this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
          this.markSaved(s, exec.saved);
          this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: exec.text, isError: exec.isError, ...(exec.images ? { images: exec.images } : {}) }, exec.outcome);
          results.push({ type: "tool_result", tool_use_id: u.id, content: toolResultContent(exec.text, exec.images), is_error: exec.isError || undefined });
        }
        messages.push({ role: "user", content: results } as MessageParam);
      }
      return { text: `The subagent stopped after ${SUBAGENT_STEPS} steps without finishing. Its last report: ${report || "none"}`, isError: true };
    } catch (e) {
      if (signal.aborted) return stopped();
      return { text: `The subagent failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    } finally {
      turnSignal.removeEventListener("abort", follow);
      this.subagents.delete(call.id);
      this.subagentStops.delete(call.id);
    }
  }

  private pause(s: StoredSession): boolean {
    this.setStatus(s, "waiting", this.causeNow());
    return true;
  }

  private recordOutcome(s: StoredSession, p: PendingTool, outcome: "done" | "error" | "unknown" | "stopped" | "declined"): void {
    const entry = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.id === p.id);
    if (entry && entry.kind === "tool") {
      entry.call.outcome = outcome === "done" && (p.isError || refused(p.result)) ? "error" : outcome;
      entry.call.result = p.result;
      entry.call.endedAt = now();
      if (p.images?.length) entry.call.images = this.keepImages(s.id, p.images);
    }
    this.o.store.save(s);
    this.o.host.events.publish("tool.finished", { sessionId: s.id, toolUseId: p.id, outcome: entry && entry.kind === "tool" ? entry.call.outcome : outcome });
  }

  /** The images a call showed the model, kept as the session's files so the panel can show them. */
  private keepImages(sessionId: string, images: NonNullable<PendingTool["images"]>): Attachment[] {
    const kept: Attachment[] = [];
    for (const img of images) {
      try {
        const { path: _path, ...a } = this.files.keep(sessionId, keptName(img), img.mediaType, Buffer.from(img.data, "base64"));
        kept.push(a);
      } catch (e) {
        this.o.host.log.warn("could not keep a tool's image for the panel", e);
      }
    }
    return kept;
  }

  /** Give the model every answered call in one message, with any notes the reattach produced. */
  private flushPending(s: StoredSession): void {
    if (!s.pending || s.pending.some((p) => p.state !== "done")) return;
    if (s.crashed) this.reconcileCrash(s);
    const content: Array<
      | { type: "tool_result"; tool_use_id: string; content: ReturnType<typeof toolResultContent>; is_error?: boolean }
      | { type: "text"; text: string }
    > = s.pending.map((p) => ({ type: "tool_result", tool_use_id: p.id, content: toolResultContent(p.result ?? "", p.images), is_error: p.isError || undefined }));
    for (const note of s.notes.splice(0)) content.push({ type: "text", text: `[Studio] ${note}` });
    s.messages.push({ role: "user", content } as MessageParam);
    s.pending = null;
    this.o.store.save(s);
  }

  private mergeTouched(s: StoredSession, items: { kind: "asset" | "actor"; path: string; saved: boolean }[], known: boolean): void {
    for (const t of items) {
      const existing = s.touched.find((x) => x.kind === t.kind && x.path === t.path);
      if (existing) existing.saved = known ? t.saved : existing.saved;
      else s.touched.push({ ...t, saved: known ? t.saved : false });
    }
  }

  private markSaved(s: StoredSession, paths: string[]): void {
    if (paths.length === 0) return;
    for (const t of s.touched) {
      if (paths.includes("*") || paths.includes(t.path)) t.saved = true;
    }
  }

  /** After a crash: list what the session changed and never saved, and saved assets that are not on disk. */
  private reconcileCrash(s: StoredSession): void {
    s.crashed = false;
    const lost: string[] = [];
    for (const t of s.touched) {
      if (!t.saved) {
        lost.push(`${t.kind} ${t.path} (not saved)`);
        continue;
      }
      if (t.kind === "asset") {
        const file = packageFile(this.o.host.projectDir, t.path);
        if (file && !fs.existsSync(file)) lost.push(`asset ${t.path} (saved, but not on disk)`);
      }
    }
    s.touched = s.touched.filter((t) => t.saved);
    const note = lost.length === 0
      ? "The editor crashed. Every change this session made had been saved."
      : `The editor crashed. These changes are gone and must be redone if still wanted:\n- ${lost.join("\n- ")}`;
    s.notes.push(note);
    this.addEntry(s, { kind: "note", text: note, at: now() });
  }
}
