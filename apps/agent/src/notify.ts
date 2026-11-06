/**
 * Notifications: the moments worth telling the owner about, read off the
 * daemon's own event stream and published once as `studio.notify` (a Notice).
 * Every device decides for itself whether to show one (decideNotice); this
 * side drops only what the project's shared settings turn off. Under
 * /v1/ext/studio:
 *
 *   GET  /notifications            { project, prefs, recent }
 *   PUT  /notifications            a ProjectNotifyUpdate: events, mute, unmute
 *   POST /notifications/presence   { id, device, active, inputAgeMs? }: whether the owner is using a device (inUse), for "only when I'm away"
 *   GET  /notifications/desktop    { prefs }: the computer's own device settings, null before any
 *   PUT  /notifications/desktop    the computer's own device settings
 *   POST /notifications/test       { id }: a test notice only the device with that presence id shows, or every device of a class (desktop, browser, phone)
 *   POST /notifications/delivery   a NotifyDelivery: what a device did with a notice
 *
 * Every decision is one line in the daemon's log and one studio.notify.trace
 * event (Settings > Diagnostics): the agent's here, each device's as it reports it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import {
  TEST_TITLE,
  applyProjectNotify,
  contextView,
  deliveryLine,
  deviceNotifyOf,
  inputAge,
  notifyDeliveryOf,
  projectNotifyOf,
  type ContextUsage,
  type DialogsState,
  type Notice,
  type NotifyDelivery,
  type NotifyDevice,
  type NotifyKind,
  type NotifyTarget,
  type ProjectNotifyPrefs,
  type ProjectNotifyUpdate,
  type QaRun,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";

/** What the notifier reads of a session. */
export interface NotifySession {
  title: string;
  transcript: TranscriptEntry[];
  context?: Record<string, ContextUsage>;
  model?: string;
  error?: string | null;
}

export interface NotifierOptions {
  project: string;
  session: (id: string) => NotifySession | undefined;
  prefs: () => ProjectNotifyPrefs;
  publish: (type: string, data: Record<string, unknown>) => void;
  /** The context window a model list stated for a model. */
  window?: (model: string) => number | undefined;
  now?: () => number;
  /** One line per decision, for the daemon's log. */
  log?: (line: string) => void;
}

/** A device that reported itself active more than this long ago is away. */
export const PRESENCE_TTL_MS = 45_000;
const RECENT = 20;

const clip = (s: string, n = 160): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export class Presence {
  private readonly seen = new Map<string, { device: NotifyDevice; active: boolean; at: number; inputAgeMs?: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  report(id: string, device: NotifyDevice, active: boolean, inputAgeMs?: number): void {
    if (this.seen.size > 200) this.seen.clear();
    this.seen.set(id, { device, active, at: this.now(), ...(typeof inputAgeMs === "number" ? { inputAgeMs } : {}) });
  }

  /** Each device class reported lately, active or idle, with its input age now: "desktop idle input=1h03m, phone active input=20s". */
  describe(): string {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    const parts: string[] = [];
    for (const p of this.seen.values()) {
      if (p.at < cutoff) continue;
      const age = typeof p.inputAgeMs === "number" ? p.inputAgeMs + (this.now() - p.at) : undefined;
      parts.push(`${p.device} ${p.active ? "active" : "idle"} input=${inputAge(age)}`);
    }
    return parts.join(", ") || "none";
  }

  /** Device classes in use now. */
  active(): NotifyDevice[] {
    const out = new Set<NotifyDevice>();
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const p of this.seen.values()) if (p.active && p.at >= cutoff) out.add(p.device);
    return [...out];
  }
}

export class Notifier {
  readonly presence: Presence;
  private readonly recentList: Notice[] = [];
  private readonly status = new Map<string, string>();
  private readonly runs = new Map<string, string>();
  private readonly dialogsSeen = new Set<string>();
  private readonly highContext = new Set<string>();
  private readonly compactionsSeen = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly o: NotifierOptions) {
    this.now = o.now ?? Date.now;
    this.presence = new Presence(this.now);
  }

  recent(): Notice[] {
    return [...this.recentList];
  }

  /** Read one daemon event; publish a notice when it is one worth telling. */
  observe(e: { type: string; data: Record<string, unknown> }): void {
    const d = e.data ?? {};
    const sessionId = typeof d.sessionId === "string" ? d.sessionId : undefined;
    switch (e.type) {
      case "studio.session.changed":
        if (sessionId) this.sessionChanged(sessionId, String(d.status ?? ""));
        return;
      case "studio.approval.requested":
        if (sessionId) this.emit("approval.waiting", sessionId, "Approval waiting", `Allow ${String(d.tool ?? "a tool call")}?`, { sessionId, approvalId: typeof d.approvalId === "string" ? d.approvalId : undefined });
        return;
      case "studio.dialog.changed":
        this.dialogs(d as unknown as DialogsState);
        return;
      case "studio.qa.attention":
        if (sessionId) this.emit("playtest.needs-you", sessionId, String(d.title ?? "Playtest needs you"), String(d.text ?? "A playtest loop stopped and needs you."), { sessionId, runId: typeof d.runId === "string" ? d.runId : undefined });
        return;
      case "studio.qa.changed":
        if (d.run) this.run(d.run as unknown as QaRun);
        return;
      case "studio.tool.finished":
        if (sessionId && typeof d.toolUseId === "string") this.toolFinished(sessionId, d.toolUseId, String(d.outcome ?? ""));
        return;
      case "studio.context.changed":
        if (sessionId) this.context(sessionId, typeof d.agent === "string" ? d.agent : "main");
        return;
    }
  }

  private sessionChanged(id: string, status: string): void {
    const was = this.status.get(id);
    this.status.set(id, status);
    if (was !== "running" && was !== "waiting") return;
    const s = this.o.session(id);
    if (status === "idle") {
      const last = [...(s?.transcript ?? [])].reverse().find((t) => t.kind === "assistant" && !t.parent);
      const text = last?.kind === "assistant" && last.text.trim() ? clip(last.text) : "The agent finished its turn.";
      this.emit("turn.finished", id, s?.title ? `Done: ${clip(s.title, 60)}` : "Turn finished", text, { sessionId: id });
    } else if (status === "error") {
      this.emit("turn.failed", id, s?.title ? `Failed: ${clip(s.title, 60)}` : "Turn failed", s?.error ? clip(s.error) : "The turn ended with an error.", { sessionId: id });
    } else if (status === "stopped") {
      this.emit("turn.failed", id, s?.title ? `Stopped: ${clip(s.title, 60)}` : "Turn stopped", "The turn was stopped.", { sessionId: id });
    }
  }

  private dialogs(state: DialogsState): void {
    for (const dlg of state?.dialogs ?? []) {
      if (!dlg.asking || dlg.outcome || this.dialogsSeen.has(dlg.id)) continue;
      this.dialogsSeen.add(dlg.id);
      const sid = dlg.sessionId ?? undefined;
      this.emit("dialog.waiting", sid, `Editor dialog: ${clip(dlg.title || "Unreal Editor", 60)}`, clip(dlg.message || "An editor dialog waits for your answer."), { ...(sid ? { sessionId: sid } : {}), dialogId: dlg.id });
    }
    if (this.dialogsSeen.size > 500) this.dialogsSeen.clear();
  }

  private run(run: QaRun): void {
    const was = this.runs.get(run.runId);
    this.runs.set(run.runId, run.state);
    if (was === run.state) return;
    const sid = run.sessionId ?? undefined;
    const target: NotifyTarget = { ...(sid ? { sessionId: sid } : {}), runId: run.runId };
    if (run.state === "awaiting_verdict") {
      const step = run.steps.find((s) => s.status === "awaiting_verdict");
      this.emit("playtest.needs-you", sid, "Verdict needed", clip(`${run.scriptName}: ${step ? `step ${step.index + 1}` : "a manual step"} waits for your verdict.`), target);
    } else if (run.state === "finished" && was && was !== "draft") {
      const failed = run.summary?.failed ?? run.steps.filter((s) => s.status === "failed").length;
      this.emit("playtest.finished", sid, failed ? "Playtest failed" : "Playtest passed", clip(`${run.scriptName}: ${failed ? `${failed} step${failed === 1 ? "" : "s"} failed` : "every step passed"}.`), target);
    }
  }

  private toolFinished(sessionId: string, toolUseId: string, outcome: string): void {
    const s = this.o.session(sessionId);
    const entry = s?.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId);
    if (entry?.kind !== "tool" || !/^(agent|task)$/i.test(entry.call.name) || entry.parent) return;
    const input = entry.call.input as { description?: unknown; name?: unknown };
    const task = typeof input.description === "string" ? input.description : typeof input.name === "string" ? input.name : "A subagent";
    const how = outcome === "done" ? "finished" : outcome === "stopped" ? "was stopped" : "ended with an error";
    this.emit("subagent.finished", sessionId, "Subagent finished", clip(`${task} ${how}.`), { sessionId });
  }

  private context(sessionId: string, agent: string): void {
    const s = this.o.session(sessionId);
    if (!s) return;
    const key = `${sessionId}/${agent}`;
    const c = s.context?.[agent];
    const model = s.model ?? c?.model ?? "";
    const view = c ? contextView(c, model, this.o.window?.(model)) : null;
    if (view?.level === "high") {
      if (!this.highContext.has(key)) {
        this.highContext.add(key);
        this.emit("context.limit", sessionId, "Context near the limit", clip(`${s.title || "A conversation"} is at ${Math.round(view.fraction * 100)}% of its context window.`), { sessionId });
      }
    } else if (view) this.highContext.delete(key);
    for (const t of s.transcript) {
      if (t.kind !== "compaction" || t.state !== "failed") continue;
      const id = `${sessionId}/${t.at}`;
      if (this.compactionsSeen.has(id)) continue;
      this.compactionsSeen.add(id);
      this.emit("context.limit", sessionId, "Compaction failed", clip(t.error ?? "The conversation could not be compacted."), { sessionId });
    }
  }

  /** Publish a notice unless the project's settings turn its event or its session off. */
  emit(kind: NotifyKind, sessionId: string | undefined, title: string, text: string, target: NotifyTarget): Notice | null {
    const prefs = this.o.prefs();
    const rule = !prefs.events[kind] ? "event" : sessionId && prefs.mutedSessions.includes(sessionId) ? "session-muted" : null;
    if (rule) {
      this.trace(`notify ${kind} project=${this.o.project}${sessionId ? ` session=${sessionId}` : ""} suppressed rule=${rule}`, { stage: "agent", kind, ...(sessionId ? { sessionId } : {}), decision: "suppressed", rule });
      return null;
    }
    return this.send(kind, sessionId, title, text, target);
  }

  /**
   * A test from Settings > Notifications, on the same way as a real notice:
   * published as studio.notify, decided and shown by the device that asked.
   */
  test(device: string): Notice {
    return this.send("turn.finished", undefined, TEST_TITLE, "Notifications from this project reach this device.", {}, { device });
  }

  /** A device's report of what it did with a notice: logged and traced. */
  delivered(report: NotifyDelivery): void {
    this.trace(`${deliveryLine(report)} project=${this.o.project}`, { stage: "device", ...report });
  }

  private trace(line: string, data: Record<string, unknown>): void {
    this.o.log?.(line);
    this.o.publish("notify.trace", data);
  }

  private send(kind: NotifyKind, sessionId: string | undefined, title: string, text: string, target: NotifyTarget, test?: { device: string }): Notice {
    const s = sessionId ? this.o.session(sessionId) : undefined;
    const clean = Object.fromEntries(Object.entries(target).filter(([, v]) => typeof v === "string")) as NotifyTarget;
    const n: Notice = {
      id: crypto.randomUUID(),
      kind,
      project: this.o.project,
      at: new Date(this.now()).toISOString(),
      ...(sessionId ? { sessionId } : {}),
      ...(s?.title ? { sessionTitle: s.title } : {}),
      title,
      text,
      target: clean,
      active: this.presence.active(),
      ...(test ? { test } : {}),
    };
    // A test is not something that happened: "open the latest" never goes to it.
    if (!test) {
      this.recentList.push(n);
      if (this.recentList.length > RECENT) this.recentList.shift();
    }
    this.trace(`notify ${test ? "test" : kind} id=${n.id} project=${this.o.project}${sessionId ? ` session=${sessionId}` : ""} sent active=${n.active?.join(",") || "none"} presence=[${this.presence.describe()}]`, { stage: "agent", kind, noticeId: n.id, ...(sessionId ? { sessionId } : {}), ...(test ? { test: true } : {}), decision: "sent" });
    this.o.publish("notify", n as unknown as Record<string, unknown>);
    return n;
  }
}

/** The project's shared settings, in the extension's data dir. */
export class NotifyPrefsStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "notifications.json");
  }
  get(): ProjectNotifyPrefs {
    try {
      return projectNotifyOf(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      return projectNotifyOf({});
    }
  }
  update(u: ProjectNotifyUpdate): ProjectNotifyPrefs {
    const next = applyProjectNotify(this.get(), u);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}

const DEVICES: readonly NotifyDevice[] = ["desktop", "browser", "phone"];

export function registerNotifications(api: DaemonExtensionApi, o: Omit<NotifierOptions, "prefs" | "publish">): { notifier: Notifier; dispose(): void } {
  const store = new NotifyPrefsStore(api.dataDir);
  const notifier = new Notifier({ ...o, prefs: () => store.get(), publish: (type, data) => api.events.publish(type, data), log: (line) => api.log.info(line) });
  const unsubscribe = api.events.subscribe((e) => {
    try {
      notifier.observe(e as { type: string; data: Record<string, unknown> });
    } catch (err) {
      api.log.warn("a notification could not be made", err);
    }
  });
  const state = (prefs: ProjectNotifyPrefs) => ({
    project: o.project,
    prefs,
    recent: notifier.recent(),
    titles: Object.fromEntries(prefs.mutedSessions.map((id) => [id, o.session(id)?.title ?? ""]).filter(([, t]) => t)),
  });
  api.route("GET", "/notifications", () => ({ body: state(store.get()) }));
  api.route("PUT", "/notifications", (req) => {
    const b = (req.body ?? {}) as ProjectNotifyUpdate;
    if (typeof b !== "object" || Array.isArray(b)) return { status: 400, body: { error: "body must be { events?, mute?, unmute? }" } };
    const prefs = store.update(b);
    api.events.publish("notify.settings", {});
    return { body: state(prefs) };
  });
  api.route("POST", "/notifications/presence", (req) => {
    const b = (req.body ?? {}) as { id?: unknown; device?: unknown; active?: unknown; inputAgeMs?: unknown };
    if (typeof b.id !== "string" || !b.id || b.id.length > 100 || !DEVICES.includes(b.device as NotifyDevice) || typeof b.active !== "boolean") {
      return { status: 400, body: { error: "body must be { id, device: desktop | browser | phone, active, inputAgeMs? }" } };
    }
    const age = typeof b.inputAgeMs === "number" && Number.isFinite(b.inputAgeMs) && b.inputAgeMs >= 0 ? b.inputAgeMs : undefined;
    notifier.presence.report(b.id, b.device as NotifyDevice, b.active, age);
    return { status: 204 };
  });
  // The computer's own device settings: the window's page storage belongs to the daemon's port, which changes on every restart.
  const desktopFile = path.join(api.dataDir, "notify-desktop.json");
  api.route("GET", "/notifications/desktop", () => {
    try {
      return { body: { prefs: deviceNotifyOf(JSON.parse(fs.readFileSync(desktopFile, "utf-8"))) } };
    } catch {
      return { body: { prefs: null } };
    }
  });
  api.route("PUT", "/notifications/desktop", (req) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return { status: 400, body: { error: "body must be this device's notification settings" } };
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, JSON.stringify(deviceNotifyOf(req.body), null, 2));
    return { status: 204 };
  });
  api.route("POST", "/notifications/test", (req) => {
    const b = (req.body ?? {}) as { id?: unknown };
    if (typeof b.id !== "string" || !b.id || b.id.length > 100) return { status: 400, body: { error: "body must be { id }: the asking device's presence id, or desktop, browser or phone" } };
    return { body: { notice: notifier.test(b.id) } };
  });
  api.route("POST", "/notifications/delivery", (req) => {
    const report = notifyDeliveryOf(req.body);
    if (!report) return { status: 400, body: { error: "body must be a delivery report: { noticeId, kind, device, shown, why?, via?, ok?, detail? }" } };
    notifier.delivered(report);
    return { status: 204 };
  });
  return { notifier, dispose: unsubscribe };
}
