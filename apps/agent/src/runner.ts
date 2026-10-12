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
import { SessionStore, type PendingTool, type StoredSession } from "./sessions.js";
import type { BusyTracker } from "./busy.js";
import { TOOLS, WORK_TOOLS, editorConnected, executeTool, packageFile, validateInput, verifyUnknown, type AgentHost } from "./tools.js";
import { CHANGING_TOOLS, approvalFor, shell } from "./local-tools.js";
import { runSubscriptionTurn } from "./subscription.js";
import { contentFor } from "./attachments.js";
import type { Attachment } from "@ue-mcp-studio/shared";

const WORK = [
  "Anything in the running editor (assets, levels, actors, Blueprints, materials, Niagara) goes through ue_mcp: find the action with ue_mcp search, check its parameters with ue_mcp describe, then call it.",
  "Prefer a dedicated action to editor.execute_python. Save what you change when the task is done, unless the user says otherwise.",
  "Results report what happened (created, existed, updated, saved): read them instead of assuming.",
  "You also have the user's machine: shell for git, builds and scripts; read_file, glob and grep for source, docs and config; write_file and edit_file to change text files; web_fetch to read a URL or call a web API; and web_search when it is offered.",
  "Use those for files, version control and the web, never for what ue_mcp does in the editor. .uasset and .umap files are binary and the editor owns them: change them through ue_mcp, not the file tools.",
  "Read a file before you edit it. Commands and file changes may wait for the user to allow them; when the user declines one, do not try it again in another form: take another way or ask.",
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

/** How many model calls one subagent may make before it is stopped. */
const SUBAGENT_STEPS = 200;

export interface RunnerOptions {
  host: AgentHost;
  store: SessionStore;
  provider: () => ModelProvider;
  model: () => string;
  /** How long the model reasons; high when not given. */
  effort?: () => Effort;
  /** Experimental: the turn runs on the Claude subscription through the Agent SDK. */
  subscription?: () => boolean;
  /** Ask the user before a command runs or a file changes; on when not given. */
  askBeforeChanges?: () => boolean;
  /** Tracks each turn's editor calls, for the window's busy state. */
  busy?: BusyTracker;
}

const now = (): string => new Date().toISOString();

export class AgentRunner {
  private readonly active = new Map<string, AbortController>();
  /** Each running subagent, by its agent call id, so one can be stopped without the turn. */
  private readonly subagents = new Map<string, () => void>();
  /** Calls waiting for the user, by approval id, with how to answer each. */
  private readonly waitingApprovals = new Map<string, { sessionId: string; parent: string | null; answer: (d: ApprovalDecision | "stopped") => void }>();
  /** Why the editor last went away, for waiting turns and unknown outcomes. */
  private lastCause = "the editor is not connected";
  private readonly unsubscribe: () => void;

  constructor(private readonly o: RunnerOptions) {
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
      }
    });
  }

  /** The host a session's tool calls run on: its editor calls are tracked when there is a busy tracker. */
  private hostFor(sessionId: string): AgentHost {
    return this.o.busy ? this.o.busy.wrap(this.o.host, sessionId) : this.o.host;
  }

  dispose(): void {
    this.unsubscribe();
    for (const c of this.active.values()) c.abort();
  }

  /** After a daemon restart: anything that was mid-turn continues, and a call that was mid-flight becomes unknown. */
  recover(): void {
    for (const s of this.o.store.all()) {
      // An approval only the previous daemon could answer; its call asks again when the turn resumes.
      if (s.approvals?.length) {
        s.approvals = [];
        this.o.store.save(s);
      }
      if (s.status !== "running" && s.status !== "waiting") continue;
      for (const p of s.pending ?? []) if (p.state === "running") p.state = "unknown";
      s.status = "waiting";
      s.waitingCause = s.waitingCause ?? "the daemon restarted";
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
    if (s.messages.length === 0) s.title = text.trim().split("\n")[0].slice(0, 60) || attachments[0]?.name || s.title;
    if (s.crashed) this.reconcileCrash(s);
    const content: unknown[] = [];
    for (const note of s.notes.splice(0)) content.push({ type: "text", text: `[Studio] ${note}` });
    for (const a of attachments) content.push(...contentFor(a));
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
    if (this.o.subscription?.()) return this.runSubscription(s.id, content);
    await this.runTurn(s.id);
  }

  /** Experimental: the Agent SDK runs the loop; tool calls still go through executeTool and the transcript. */
  private async runSubscription(id: string, prompt: unknown[]): Promise<void> {
    const controller = new AbortController();
    this.active.set(id, controller);
    const s = this.require(id);
    let lastId: string | null = null;
    // Agent calls the SDK runs in the background: their tool result only says they started.
    const background = new Set<string>();
    try {
      const error = await runSubscriptionTurn({
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
          if (name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, controller.signal);
          const gate = await this.gate(s, toolId, name, input, controller.signal);
          if (gate) {
            const text = "stopped" in gate ? "Stopped by the user." : gate.declined;
            this.recordOutcome(s, { id: toolId, name, input, state: "done", result: text, isError: true }, "stopped" in gate ? "stopped" : "declined");
            return { text, isError: true, outcome: "error", touched: [], saved: [] };
          }
          const exec = await executeTool(this.hostFor(s.id), name, input, controller.signal);
          this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
          // Stopped while the editor worked: the stop already answered this call.
          if (controller.signal.aborted) return exec;
          this.markSaved(s, exec.saved);
          const p: PendingTool = { id: toolId, name, input, state: "done", result: exec.text, isError: exec.isError };
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
      // A call the turn ended or was stopped without answering never finishes now.
      this.markStopped(s);
    }
  }

  /** Hold a tool call until the editor is back, showing the session as waiting meanwhile. */
  private async waitForEditor(s: StoredSession, signal: AbortSignal): Promise<void> {
    if (editorConnected(this.o.host)) return;
    this.setStatus(s, "waiting", this.lastCause);
    while (!editorConnected(this.o.host) && !signal.aborted) await new Promise((r) => setTimeout(r, 1000));
    if (!signal.aborted) this.setStatus(s, "running", null);
  }

  /** Stop a turn. Unanswered tool calls are answered as stopped so the conversation stays valid. */
  stop(sessionId: string): void {
    const s = this.require(sessionId);
    this.active.get(s.id)?.abort();
    this.active.delete(s.id);
    if (s.pending) {
      for (const p of s.pending) {
        if (p.state !== "done") {
          p.state = "done";
          p.result = "Stopped by the user before this ran.";
          p.isError = true;
        }
      }
      this.flushPending(s);
    }
    this.markStopped(s);
    this.setStatus(s, "stopped", null);
  }

  /** Every call the transcript still shows running, recorded as stopped by the user. */
  private markStopped(s: StoredSession): void {
    for (const t of s.transcript) {
      if (t.kind === "tool" && t.call.outcome === "pending") {
        this.recordOutcome(s, { id: t.call.id, name: t.call.name, input: {}, state: "done", result: "Stopped by the user.", isError: true }, "stopped");
      }
    }
  }

  /**
   * Stop one subagent and let the turn go on: the main agent is told the user
   * stopped it. Returns false when no subagent of that id is running.
   */
  stopSubagent(sessionId: string, callId: string): boolean {
    this.require(sessionId);
    const stop = this.subagents.get(callId);
    if (!stop) return false;
    stop();
    return true;
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
      if (needsEditor && !editorConnected(this.o.host)) return this.pause(s);

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
      this.mergeTouched(s, exec.touched, true);
      this.markSaved(s, exec.saved);
      this.recordOutcome(s, p, exec.outcome);
      if (p.name === "editor_restart" && !exec.isError && !editorConnected(this.o.host)) {
        // The restart returned; wait for the editor to reattach before the model continues.
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
        const results: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];
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
          const exec = await executeTool(this.hostFor(s.id), u.name, input, signal);
          this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
          if (signal.aborted) return stopped();
          this.markSaved(s, exec.saved);
          this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: exec.text, isError: exec.isError }, exec.outcome);
          results.push({ type: "tool_result", tool_use_id: u.id, content: exec.text, is_error: exec.isError || undefined });
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
    }
  }

  private pause(s: StoredSession): boolean {
    this.setStatus(s, "waiting", this.lastCause);
    return true;
  }

  private recordOutcome(s: StoredSession, p: PendingTool, outcome: "done" | "error" | "unknown" | "stopped" | "declined"): void {
    const entry = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.id === p.id);
    if (entry && entry.kind === "tool") {
      entry.call.outcome = outcome === "done" && p.isError ? "error" : outcome;
      entry.call.result = p.result;
      entry.call.endedAt = now();
    }
    this.o.store.save(s);
    this.o.host.events.publish("tool.finished", { sessionId: s.id, toolUseId: p.id, outcome });
  }

  /** Give the model every answered call in one message, with any notes the reattach produced. */
  private flushPending(s: StoredSession): void {
    if (!s.pending || s.pending.some((p) => p.state !== "done")) return;
    if (s.crashed) this.reconcileCrash(s);
    const content: Array<
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
      | { type: "text"; text: string }
    > = s.pending.map((p) => ({ type: "tool_result", tool_use_id: p.id, content: p.result ?? "", is_error: p.isError || undefined }));
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
