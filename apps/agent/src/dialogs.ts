/**
 * Editor dialogs, shown in the chat and answered from it.
 *
 * A modal dialog parks the editor, and ue-mcp refuses every call until it is
 * answered. Studio's window is a separate process, so it can show the dialog
 * while the editor is stuck. Three sources feed one record per dialog:
 *
 *   the prompt     ue-mcp puts a dialog that a Studio call met to the
 *                  dialogPrompt Studio passes with that call (interactive
 *                  mode). The card's buttons answer it; the project's policy
 *                  answers it when nobody does: hand it to the agent, or press
 *                  the safe default, after N minutes.
 *   the events     dialog.opened, answered, delegated and closed, for every
 *                  dialog, including ones Studio is not asked about (auto and
 *                  defer, or another client's call).
 *   the agent      in auto mode the agent presses with respond_to_dialog; an
 *                  answer that discards work is held for a countdown the user
 *                  can override.
 */
import * as crypto from "node:crypto";
import type { ActionResult } from "ue-mcp/daemon";
import { type ElicitParams, type ElicitResult, type FormBroker } from "./forms.js";
import {
  DESTRUCTIVE_HOLD_SECONDS,
  isDestructiveAnswer,
  safeButton,
  type DialogAnswer,
  type DialogPolicy,
  type DialogsState,
  type EditorDialog,
} from "@ue-mcp-studio/shared";
import type { SessionStore } from "./sessions.js";
import type { AgentHost } from "./tools.js";

/** ue-mcp's dialog prompt (ue-mcp/daemon 1.4.1), restated so Studio builds against older releases. */
export interface DialogPromptRequest {
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  dialog: {
    editor: string;
    title: string;
    message: string;
    buttons: string[];
    items?: Array<{ index: number; label: string; cells: string[]; checked: boolean }>;
    subject: string;
    minHumanMs: number;
  };
}
export type DialogPromptResult =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" | "cancel" | "delegate" };
export interface CallOptions {
  dialogPrompt?: (request: DialogPromptRequest) => Promise<DialogPromptResult>;
  dialogWaitMs?: number;
  elicit?: (params: ElicitParams) => Promise<ElicitResult>;
}

/** How long a call waits on a prompt under the wait policy before returning the refusal to the agent. */
export const WAIT_POLICY_CALL_MS = 6 * 60 * 60 * 1000;

/** What the broker needs from the daemon. */
export interface DialogHost {
  callAction(category: string, action: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<ActionResult>;
  events: {
    publish(type: string, data?: Record<string, unknown>): unknown;
    subscribe(listener: (e: { type: string; data: Record<string, unknown> }) => void): () => void;
  };
}

type Timer = ReturnType<typeof setTimeout>;

interface Live {
  view: EditorDialog;
  key: string;
  /** Answers the prompt ue-mcp is waiting on. */
  resolve?: (r: DialogPromptResult) => void;
  policyTimer?: Timer;
  /** Answers a held destructive press: the agent's button, a user's override, or nothing when it closed. */
  hold?: { release: (r: { button: string; by: "agent" | "you" } | null) => void; timer: Timer };
  /** The next press reported was Studio's, on the user's behalf. */
  pressedForUser?: string;
  /** Whether it has a line in a session's transcript yet. */
  inTranscript: boolean;
}

interface InflightCall {
  sessionId: string;
  category: string;
  action: string;
  startedAt: number;
}

/**
 * Still on the card: nobody has answered, the agent is deciding (handed over),
 * or the agent's answer is held for its countdown.
 */
function isOpen(v: EditorDialog): boolean {
  return v.outcome === null || v.outcome.kind === "delegated" || v.held !== null;
}

/** "2 min", "6 s": how long the policy waited. */
export function span(minutes: number): string {
  const secs = Math.round(minutes * 60);
  return secs < 60 ? `${secs} s` : secs % 60 === 0 ? `${secs / 60} min` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
}

/** Which on-screen dialog a record is: the same rule ue-mcp's events follow. */
function keyOf(editor: string, title: string, buttons: string[]): string {
  return `${editor} :: ${title} :: ${buttons.join(" | ")}`;
}

function text(r: ActionResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

export interface DialogBrokerOptions {
  host: DialogHost;
  store: SessionStore;
  policy: () => DialogPolicy;
  now?: () => number;
  /** How long a destructive answer the agent chose is held, in ms. */
  holdMs?: number;
  /** Where the other forms a call raises go, such as feedback approval. */
  forms?: FormBroker;
}

export class DialogBroker {
  private readonly live = new Map<string, Live>();
  private readonly inflight = new Map<number, InflightCall>();
  private nextCall = 1;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly unsubscribe: () => void;

  constructor(private readonly o: DialogBrokerOptions) {
    this.now = o.now ?? Date.now;
    this.holdMs = o.holdMs ?? DESTRUCTIVE_HOLD_SECONDS * 1000;
    this.unsubscribe = o.host.events.subscribe((e) => this.observe(e));
  }

  dispose(): void {
    this.unsubscribe();
    for (const l of this.live.values()) {
      if (l.policyTimer) clearTimeout(l.policyTimer);
      if (l.hold) clearTimeout(l.hold.timer);
    }
  }

  state(): DialogsState {
    return {
      now: this.now(),
      dialogs: [...this.live.values()].filter((l) => isOpen(l.view)).map((l) => ({ ...l.view, steps: [...l.view.steps] })),
    };
  }

  /** The host a session's turn runs on: its calls carry Studio's dialog prompt, and a destructive press waits its countdown. */
  wrap(host: AgentHost & { callAction: DialogHost["callAction"] }, sessionId: string): AgentHost {
    const callAction = async (category: string, action: string, args: Record<string, unknown> = {}): Promise<ActionResult> => {
      const id = this.nextCall++;
      this.inflight.set(id, { sessionId, category, action, startedAt: this.now() });
      try {
        if (category === "editor" && action === "respond_to_dialog") return await this.agentPress(host, sessionId, args);
        const forms = this.o.forms ? { elicit: (p: ElicitParams) => this.o.forms!.ask(sessionId, `${category}(${action})`, p) } : {};
        return await host.callAction(category, action, args, {
          dialogPrompt: (req) => this.prompt(sessionId, category, action, req),
          dialogWaitMs: this.waitMs(),
          ...forms,
        });
      } finally {
        this.inflight.delete(id);
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

  /** How long one call waits on a prompt: past the policy's deadline, so the policy's answer reaches it. */
  private waitMs(): number {
    const p = this.o.policy();
    return p.kind === "wait" ? WAIT_POLICY_CALL_MS : p.minutes * 60_000 + 15_000;
  }

  // ── The prompt ────────────────────────────────────────────────────

  /** ue-mcp asks Studio about a dialog one of this session's calls met. */
  prompt(sessionId: string, category: string, action: string, req: DialogPromptRequest): Promise<DialogPromptResult> {
    const d = req.dialog;
    const l = this.recordFor(d.editor, d.title, d.buttons, { message: d.message, items: d.items, mode: "interactive" });
    this.attribute(l, sessionId, category, action);
    // A prompt replaces any earlier one for the same dialog: ue-mcp asks once per dialog.
    l.resolve?.({ action: "cancel" });
    if (l.policyTimer) clearTimeout(l.policyTimer);
    const policy = this.o.policy();
    const since = this.now();
    const safe = safeButton(d.buttons);
    // The safe policy with no safe button waits for the user rather than guessing.
    const acts = policy.kind === "agent" || (policy.kind === "safe" && safe !== null);
    l.view.outcome = null;
    l.view.mode = "interactive";
    this.step(l, policy.kind === "wait" ? "Asked you." : acts
      ? `Asked you. ${policy.kind === "agent" ? "The agent decides" : `${safe} is pressed`} if nobody answers in ${span(policy.minutes)}.`
      : "Asked you. It has no Cancel or Keep, so nothing is pressed for you.");
    l.view.asking = {
      since,
      minHumanMs: d.minHumanMs,
      policy,
      deadline: acts ? since + (policy as { minutes: number }).minutes * 60_000 : null,
      safeButton: safe,
    };
    return new Promise<DialogPromptResult>((resolve) => {
      l.resolve = (r) => {
        l.resolve = undefined;
        if (l.policyTimer) clearTimeout(l.policyTimer);
        l.policyTimer = undefined;
        resolve(r);
      };
      const deadline = l.view.asking?.deadline;
      if (deadline !== null && deadline !== undefined) {
        l.policyTimer = setTimeout(() => this.policyActs(l), Math.max(0, deadline - this.now()));
        l.policyTimer.unref?.();
      }
      this.changed(l);
    });
  }

  /** Nobody answered in time: the policy does. */
  private policyActs(l: Live): void {
    const a = l.view.asking;
    if (!l.resolve || !a) return;
    if (a.policy.kind === "agent") {
      l.view.outcome = { kind: "delegated", by: "policy", at: this.now() };
      l.view.asking = null;
      this.step(l, `Nobody answered in ${span(a.policy.minutes)}, so it was handed to the agent. The agent is deciding.`);
      l.resolve({ action: "delegate" });
    } else if (a.policy.kind === "safe" && a.safeButton) {
      l.view.outcome = { kind: "pressed", button: a.safeButton, by: "policy", at: this.now() };
      l.view.asking = null;
      this.step(l, `Nobody answered in ${span(a.policy.minutes)}, so ${a.safeButton} was pressed.`);
      l.resolve({ action: "accept", content: { button: a.safeButton } });
    } else {
      return;
    }
    this.changed(l);
  }

  /** The user's answer from the card. Returns an error to show, or null. */
  async answer(id: string, a: DialogAnswer, host: DialogHost = this.o.host): Promise<string | null> {
    const l = [...this.live.values()].find((x) => x.view.id === id);
    if (!l || !isOpen(l.view)) return "That dialog is no longer waiting.";

    if (a.answer === "release") {
      if (!l.hold || !l.view.held) return "Nothing is waiting to be pressed.";
      l.hold.release({ button: l.view.held.button, by: "agent" });
      return null;
    }

    if (a.answer === "delegate") {
      if (!l.resolve || !l.view.asking) return "The agent can only be handed a dialog Studio is asking about.";
      if (this.tooSoon(l)) return "Read the dialog first.";
      l.view.outcome = { kind: "delegated", by: "you", at: this.now() };
      l.view.asking = null;
      this.step(l, "You handed it to the agent. The agent is deciding.");
      l.resolve({ action: "delegate" });
      this.changed(l);
      return null;
    }

    if (!l.view.buttons.includes(a.button)) return `The dialog has no button "${a.button}".`;

    // An override of the agent's held press.
    if (l.hold) {
      l.hold.release({ button: a.button, by: "you" });
      return null;
    }

    if (l.resolve && l.view.asking) {
      if (this.tooSoon(l)) return "Read the dialog first.";
      l.view.outcome = { kind: "pressed", button: a.button, by: "you", at: this.now() };
      l.view.asking = null;
      this.step(l, `You pressed ${a.button}.`);
      l.resolve({ action: "accept", content: this.content(l, a.button, a.items) });
      this.changed(l);
      return null;
    }

    // Not asked about: in auto, or once handed to the agent, the press calls are open, so press it for the user.
    if (l.view.mode === "auto" || l.view.outcome?.kind === "delegated") {
      l.pressedForUser = a.button;
      const r = await host.callAction("editor", "respond_to_dialog", { buttonLabel: a.button, ...(a.items ? { items: a.items } : {}) });
      if (r.isError) {
        l.pressedForUser = undefined;
        return text(r) || "The editor did not take the press.";
      }
      if (l.view.outcome?.kind !== "pressed") {
        l.view.outcome = { kind: "pressed", button: a.button, by: "you", at: this.now() };
        this.step(l, `You pressed ${a.button}.`);
        this.changed(l);
      }
      return null;
    }
    return "Answer this one in the editor: ue-mcp did not put it to Studio.";
  }

  private tooSoon(l: Live): boolean {
    const a = l.view.asking;
    return !!a && this.now() < a.since + a.minHumanMs;
  }

  /** The form's answer: the button, and the rows ticked, in the shape ue-mcp's schema asked for. */
  private content(l: Live, button: string, items?: Array<{ index: number; checked: boolean }>): Record<string, string | boolean | string[]> {
    const out: Record<string, string | boolean | string[]> = { button };
    if (!items || !l.view.items) return out;
    const ticked = new Map(items.map((i) => [i.index, i.checked]));
    const checked = (index: number, was: boolean) => ticked.get(index) ?? was;
    out.items = l.view.items.filter((i) => checked(i.index, i.checked)).map((i) => `item_${i.index}`);
    return out;
  }

  // ── The agent's press, in auto mode ───────────────────────────────

  /** A press the agent sent. One that discards work waits DESTRUCTIVE_HOLD_SECONDS, and the user can override it. */
  private async agentPress(host: DialogHost, sessionId: string, args: Record<string, unknown>): Promise<ActionResult> {
    const l = this.current();
    const label = typeof args.buttonLabel === "string" ? args.buttonLabel
      : typeof args.buttonIndex === "number" && l ? l.view.buttons[args.buttonIndex] ?? "" : "";
    if (!label || !isDestructiveAnswer(label)) {
      if (l && label) {
        this.step(l, `The agent chose ${label}.`);
        this.changed(l);
      }
      return host.callAction("editor", "respond_to_dialog", args);
    }

    const held = l ?? this.recordFor("", "Editor dialog", [], { message: "", mode: "auto" });
    this.attribute(held, sessionId, "editor", "respond_to_dialog");
    // Handed to the agent earlier: it is open again until the press lands.
    if (held.view.outcome?.kind === "delegated") held.view.outcome = null;
    held.view.held = { button: label, until: this.now() + this.holdMs };
    this.step(held, `The agent chose ${label}, which discards work. It waits ${Math.round(this.holdMs / 1000)} s so you can override it.`);
    const decided = await new Promise<{ button: string; by: "agent" | "you" } | null>((resolve) => {
      const timer = setTimeout(() => held.hold?.release({ button: label, by: "agent" }), this.holdMs);
      timer.unref?.();
      held.hold = {
        timer,
        release: (r) => {
          clearTimeout(timer);
          held.hold = undefined;
          held.view.held = null;
          resolve(r);
        },
      };
      this.changed(held);
    });
    if (decided?.by === "you") this.step(held, `You overrode the agent: ${decided.button} instead of ${label}.`);
    this.changed(held);
    if (!decided) {
      return { isError: true, content: [{ type: "text", text: `The dialog closed before "${label}" was pressed, so nothing was pressed.` }] };
    }
    if (decided.by === "agent") return host.callAction("editor", "respond_to_dialog", args);
    held.pressedForUser = decided.button;
    const r = await host.callAction("editor", "respond_to_dialog", { buttonLabel: decided.button });
    const note = `The user overrode your choice: "${decided.button}" was pressed instead of "${label}". Do not press "${label}" again.`;
    return { isError: r.isError, content: [{ type: "text", text: note }, ...r.content] };
  }

  // ── Events ────────────────────────────────────────────────────────

  private observe(e: { type: string; data: Record<string, unknown> }): void {
    if (!e.type.startsWith("dialog.")) return;
    const d = e.data;
    const editor = typeof d.editor === "string" ? d.editor : "";
    const title = typeof d.title === "string" ? d.title : "";
    const buttons = Array.isArray(d.buttons) ? d.buttons.filter((b): b is string => typeof b === "string") : [];
    const key = keyOf(editor, title, buttons);
    if (e.type === "dialog.opened") {
      const mode = d.mode === "auto" || d.mode === "interactive" || d.mode === "defer" ? d.mode : null;
      const items = Array.isArray(d.items) ? (d.items as EditorDialog["items"]) : undefined;
      const l = this.recordFor(editor, title, buttons, { message: typeof d.message === "string" ? d.message : "", items, mode });
      if (l.view.steps.length === 0) {
        this.step(l, mode === "auto" ? "Opened. The agent answers dialogs in this project, so the agent is deciding."
          : mode === "defer" ? "Opened. Dialogs in this project are answered in the editor."
          : "Opened in the editor.");
      }
      // A Studio call in flight is what met it; the oldest is the one the editor was running.
      if (!l.view.sessionId) {
        const call = [...this.inflight.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
        if (call) this.attribute(l, call.sessionId, call.category, call.action);
      }
      this.changed(l);
      return;
    }
    const l = this.live.get(key);
    if (!l) return;
    if (e.type === "dialog.answered") {
      const button = typeof d.button === "string" ? d.button : "";
      if (l.view.outcome?.kind !== "pressed" || l.view.outcome.button !== button) {
        const by = l.pressedForUser === button || d.via === "prompt" ? "you" : "agent";
        l.view.outcome = { kind: "pressed", button, by, at: this.now() };
        this.step(l, by === "you" ? `You pressed ${button}.` : `The agent pressed ${button}.`);
      }
      l.pressedForUser = undefined;
      l.view.asking = null;
      this.changed(l);
    } else if (e.type === "dialog.delegated") {
      if (l.view.outcome === null) {
        l.view.outcome = { kind: "delegated", by: "you", at: this.now() };
        this.step(l, "Handed to the agent. The agent is deciding.");
      }
      this.changed(l);
    } else if (e.type === "dialog.closed") {
      // Gone from the screen: whoever was asked has nothing left to answer.
      l.resolve?.({ action: "cancel" });
      l.hold?.release(null);
      if (l.view.outcome?.kind !== "pressed") {
        l.view.outcome = { kind: "closed", at: this.now() };
        this.step(l, "Closed in the editor, with no answer from here.");
      }
      l.view.asking = null;
      l.view.held = null;
      this.changed(l);
      this.live.delete(key);
    }
  }

  // ── Records ───────────────────────────────────────────────────────

  /** The one open dialog, when there is exactly one to aim a press at; the newest otherwise. */
  private current(): Live | undefined {
    return [...this.live.values()].filter((l) => isOpen(l.view)).pop();
  }

  /** One transition, in order, for the card and the transcript. */
  private step(l: Live, text: string): void {
    l.view.steps.push({ at: this.now(), text });
  }

  private recordFor(
    editor: string,
    title: string,
    buttons: string[],
    rest: { message: string; items?: EditorDialog["items"]; mode: EditorDialog["mode"] },
  ): Live {
    const key = keyOf(editor, title, buttons);
    const existing = this.live.get(key);
    if (existing) {
      if (rest.message) existing.view.message = rest.message;
      if (rest.items) existing.view.items = rest.items;
      if (rest.mode && existing.view.mode === null) existing.view.mode = rest.mode;
      return existing;
    }
    const l: Live = {
      key,
      inTranscript: false,
      view: {
        id: crypto.randomUUID(),
        editor,
        title,
        message: rest.message,
        buttons,
        ...(rest.items ? { items: rest.items } : {}),
        mode: rest.mode,
        openedAt: this.now(),
        sessionId: null,
        toolUseId: null,
        parent: null,
        call: null,
        asking: null,
        held: null,
        outcome: null,
        steps: [],
      },
    };
    this.live.set(key, l);
    return l;
  }

  /** Name the session, call and subagent that met the dialog, and give it a line in that session's transcript. */
  private attribute(l: Live, sessionId: string, category: string, action: string): void {
    if (l.view.sessionId) return;
    const s = this.o.store.get(sessionId);
    if (!s) return;
    l.view.sessionId = sessionId;
    l.view.call = `${category}.${action}`;
    const call = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.outcome === "pending" && t.call.name === "ue_mcp"
      && (t.call.input as { category?: unknown }).category === category && (t.call.input as { method?: unknown }).method === action);
    if (call?.kind === "tool") {
      l.view.toolUseId = call.call.id;
      l.view.parent = call.parent ?? null;
      const agent = call.parent ? s.transcript.find((t) => t.kind === "tool" && t.call.id === call.parent) : undefined;
      const description = agent?.kind === "tool" ? (agent.call.input as { description?: unknown }).description : undefined;
      if (typeof description === "string") l.view.subagent = description;
    }
  }

  /** Keep the session's transcript line current and tell the UI. */
  private changed(l: Live): void {
    const sid = l.view.sessionId;
    const s = sid ? this.o.store.get(sid) : undefined;
    if (s) {
      const view = { ...l.view, steps: [...l.view.steps] };
      const entry = s.transcript.find((t) => t.kind === "dialog" && t.dialog.id === l.view.id);
      if (entry?.kind === "dialog") {
        entry.dialog = view;
        this.o.store.save(s);
      } else if (!l.inTranscript) {
        l.inTranscript = true;
        s.transcript.push({ kind: "dialog", dialog: view });
        this.o.store.save(s);
        this.o.host.events.publish("transcript.added", { sessionId: s.id, entry: { kind: "dialog", dialog: view } as unknown as Record<string, unknown> });
      }
    }
    this.o.host.events.publish("dialog.changed", { ...(sid ? { sessionId: sid } : {}), ...this.state() } as unknown as Record<string, unknown>);
  }
}
