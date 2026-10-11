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
 */
import * as fs from "node:fs";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import type { ContentBlock, ModelProvider, MessageParam } from "./providers.js";
import { SessionStore, type PendingTool, type StoredSession } from "./sessions.js";
import { TOOLS, editorConnected, executeTool, packageFile, verifyUnknown, type AgentHost } from "./tools.js";
import { runSubscriptionTurn } from "./subscription.js";

const SYSTEM = [
  "You work inside Unreal Editor for the user, through ue-mcp.",
  "Find the action for a task with ue_mcp search, check its parameters with ue_mcp describe, then call it.",
  "Prefer a dedicated action to editor.execute_python. Save what you change when the task is done, unless the user says otherwise.",
  "Results report what happened (created, existed, updated, saved): read them instead of assuming.",
  "When the editor restarts or crashes during your work, a note tells you why and what was lost. Do not repeat a call whose outcome is unknown without reading the state first.",
].join("\n");

export interface RunnerOptions {
  host: AgentHost;
  store: SessionStore;
  provider: () => ModelProvider;
  model: () => string;
  /** Experimental: the turn runs on the Claude subscription through the Agent SDK. */
  subscription?: () => boolean;
}

const now = (): string => new Date().toISOString();

export class AgentRunner {
  private readonly active = new Map<string, AbortController>();
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

  dispose(): void {
    this.unsubscribe();
    for (const c of this.active.values()) c.abort();
  }

  /** After a daemon restart: anything that was mid-turn continues, and a call that was mid-flight becomes unknown. */
  recover(): void {
    for (const s of this.o.store.all()) {
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
  async send(sessionId: string, text: string): Promise<void> {
    const s = this.require(sessionId);
    if (this.active.has(s.id) || s.status === "running" || s.status === "waiting") {
      throw new Error("a turn is already in progress; stop it or wait for it to finish");
    }
    if (s.messages.length === 0) s.title = text.trim().split("\n")[0].slice(0, 60) || s.title;
    if (s.crashed) this.reconcileCrash(s);
    const content: Array<{ type: "text"; text: string }> = [];
    for (const note of s.notes.splice(0)) content.push({ type: "text", text: `[Studio] ${note}` });
    content.push({ type: "text", text });
    s.messages.push({ role: "user", content });
    s.transcript.push({ kind: "user", text, at: now() });
    s.draft = "";
    s.error = null;
    this.setStatus(s, "running", null);
    if (this.o.subscription?.()) return this.runSubscription(s.id, content.map((c) => c.text).join("\n\n"));
    await this.runTurn(s.id);
  }

  /** Experimental: the Agent SDK runs the loop; tool calls still go through executeTool and the transcript. */
  private async runSubscription(id: string, prompt: string): Promise<void> {
    const controller = new AbortController();
    this.active.set(id, controller);
    const s = this.require(id);
    let lastId: string | null = null;
    try {
      const error = await runSubscriptionTurn({
        projectDir: this.o.host.projectDir,
        model: this.o.model(),
        system: SYSTEM,
        prompt,
        resume: s.sdkSession ?? null,
        signal: controller.signal,
        onSession: (sid) => {
          s.sdkSession = sid;
          this.o.store.save(s);
        },
        onDelta: (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
        onAssistant: (mid, blocks) => {
          const last = s.messages[s.messages.length - 1];
          if (mid === lastId && last?.role === "assistant" && Array.isArray(last.content)) (last.content as ContentBlock[]).push(...blocks);
          else s.messages.push({ role: "assistant", content: blocks } as MessageParam);
          lastId = mid;
          for (const b of blocks) {
            if (b.type === "text" && b.text) this.addEntry(s, { kind: "assistant", text: b.text, at: now() });
            if (b.type === "tool_use") {
              this.addEntry(s, { kind: "tool", call: { id: b.id, name: b.name, input: b.input, outcome: "pending", startedAt: now() } });
            }
          }
          this.o.store.save(s);
        },
        onToolResults: (content) => {
          s.messages.push({ role: "user", content } as MessageParam);
          lastId = null;
          this.o.store.save(s);
        },
        runTool: async (toolId, name, input) => {
          if (name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, controller.signal);
          const exec = await executeTool(this.o.host, name, input);
          this.mergeTouched(s, exec.touched, exec.outcome !== "unknown");
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
    this.setStatus(s, "stopped", null);
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
          { sessionId: s.id, model: this.o.model(), system: [{ type: "text", text: SYSTEM }], tools: TOOLS, messages: s.messages },
          (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
          controller.signal,
        );
        if (controller.signal.aborted) return;

        s.messages.push({ role: "assistant", content: turn.content } as MessageParam);
        const text = turn.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
        if (text) this.addEntry(s, { kind: "assistant", text, at: now() });

        if (turn.stopReason === "refusal") {
          s.error = `The model declined: ${turn.refusal ?? "no reason given"}`;
          this.setStatus(s, "error", null);
          return;
        }
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
    for (const p of pending) {
      if (signal.aborted) return true;
      if (p.state === "done") continue;

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

      p.state = "running";
      this.o.store.save(s);
      const exec = await executeTool(this.o.host, p.name, p.input);
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

  private pause(s: StoredSession): boolean {
    this.setStatus(s, "waiting", this.lastCause);
    return true;
  }

  private recordOutcome(s: StoredSession, p: PendingTool, outcome: "done" | "error" | "unknown"): void {
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
