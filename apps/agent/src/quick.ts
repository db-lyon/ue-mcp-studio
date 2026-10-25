/**
 * The editor's quick ask, under /v1/ext/studio:
 *
 *   POST /quick                { text, context? } a new session with that first message; answers { sessionId }
 *   GET  /quick/:id            the session as the pill shows it while it runs (QuickThread)
 *   POST /quick/:id/continue   open the Studio panel on the session, for a follow-up
 *
 * The plugin's Ask Studio pill and its "Chat about this" menu entries call it.
 * The UI is sent to the session with studio.session.focus, and a Studio window
 * started afterwards opens on it through the location file the window reads.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { richText } from "./rich-text.js";
import type { QuickContextItem, QuickRequest, QuickStep, QuickThread, SessionDetail, ToolCallRecord } from "@ue-mcp-studio/shared";

export const NO_MODEL = "No model is connected. Open Studio and sign in or add an API key in the model picker, then ask again.";
const MAX_CONTEXT = 100;
const KINDS: ReadonlyArray<QuickContextItem["kind"]> = ["actor", "asset", "location", "graph", "node"];

/** One line of a label or path: no newlines, trimmed, capped. */
const line = (s: string, max = 400): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export function parseQuickRequest(body: unknown): QuickRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.text !== "string" || !b.text.trim()) return "body must be { text: string, context?: Array<{ kind, label, path, class? }> } with text";
  if (b.context === undefined) return { text: b.text };
  if (!Array.isArray(b.context)) return "context must be an array";
  if (b.context.length > MAX_CONTEXT) return `context holds at most ${MAX_CONTEXT} items`;
  const context: QuickContextItem[] = [];
  for (const raw of b.context) {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (!KINDS.includes(c.kind as QuickContextItem["kind"])) return `context kind must be one of ${KINDS.join(", ")}`;
    if (typeof c.path !== "string" || !line(c.path)) return "every context item needs a path";
    const named = typeof c.label === "string" && line(c.label) ? line(c.label) : "";
    const label = named || (c.kind === "location" ? "" : line(c.path).split(/[.:]/).pop()!);
    const cls = typeof c.class === "string" && line(c.class) ? line(c.class, 120) : undefined;
    const at = typeof c.at === "string" && line(c.at) ? line(c.at, 120) : undefined;
    context.push({ kind: c.kind as QuickContextItem["kind"], label, path: line(c.path), ...(cls ? { class: cls } : {}), ...(at ? { at } : {}) });
  }
  return { text: b.text, context };
}

/** The package an actor's object path lives in: /Game/Maps/L.L:PersistentLevel.A gives /Game/Maps/L. */
export function mapOf(actorPath: string): string {
  return actorPath.split(":")[0].split(".")[0];
}

const describe = (c: QuickContextItem): string => `${c.label}${c.class ? ` (${c.class})` : ""} at ${c.path}`;

/** The first message: one Context line per map's actors and one for assets, then the user's text. */
export function formatQuickMessage(req: QuickRequest): string {
  const context = req.context ?? [];
  if (context.length === 0) return req.text.trim();
  const lines: string[] = [];
  const byMap = new Map<string, QuickContextItem[]>();
  for (const c of context.filter((x) => x.kind === "location")) {
    lines.push(`Context: the point under the cursor${c.class ? ` in ${c.class}` : ""}${c.label ? `, on ${c.label}` : ""}: ${c.path}. "Here" means this point.`);
  }
  for (const c of context.filter((x) => x.kind === "actor")) {
    const m = mapOf(c.path);
    byMap.set(m, [...(byMap.get(m) ?? []), c]);
  }
  for (const [m, actors] of byMap) lines.push(`Context: ${actors.length === 1 ? "actor" : "actors"} in ${m}: ${actors.map(describe).join("; ")}`);
  for (const g of context.filter((x) => x.kind === "graph")) {
    lines.push(`Context: the graph ${g.label}${g.class ? ` in ${g.class}` : ""} (${g.path})${g.at ? `, cursor at graph position ${g.at}; "here" in the graph means that position` : ""}.`);
  }
  const hovered = context.filter((x) => x.kind === "node" && x.at === "under the cursor");
  if (hovered.length) lines.push(`Context: node under the cursor: ${hovered.map(describe).join("; ")}`);
  const selected = context.filter((x) => x.kind === "node" && x.at !== "under the cursor");
  if (selected.length) lines.push(`Context: selected ${selected.length === 1 ? "node" : "nodes"}: ${selected.map(describe).join("; ")}`);
  const assets = context.filter((x) => x.kind === "asset");
  if (assets.length) lines.push(`Context: ${assets.length === 1 ? "asset" : "assets"}: ${assets.map(describe).join("; ")}`);
  return `${lines.join("\n")}\n\n${req.text.trim()}`;
}

/** The session's title: the first line of what the user typed. */
export function quickTitle(text: string): string {
  const first = text.trim().split("\n")[0].trim();
  return first.slice(0, 60).trimEnd() || "Quick ask";
}

/** Where Studio's window keeps the panel's location (apps/window, locationPath()). */
export function windowLocationFile(projectDir: string): string {
  return path.join(projectDir, "Saved", "UE_MCP_Studio", "window-location.txt");
}

export interface QuickDeps {
  /** Whether a model can run: a sign-in or a key covers the selected one. */
  connected(): boolean;
  create(title: string): { id: string };
  send(sessionId: string, text: string): Promise<void>;
  /** The session as the panel reads it, or undefined when there is none. */
  detail(sessionId: string): SessionDetail | undefined;
}

/** How many steps the pill lists; earlier ones are counted, not shown. */
export const QUICK_STEPS = 6;

/** A tool call as one short line: ue-mcp calls by category and action, others by name. */
export function stepLabel(call: Pick<ToolCallRecord, "name" | "input">): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (typeof input.category === "string" && typeof input.method === "string") return `${input.category}.${input.method}`;
  if (call.name === "Bash" || call.name === "shell") return "shell";
  return call.name.replace(/^mcp__[^_]+__/, "");
}

const stepState = (o: ToolCallRecord["outcome"]): QuickStep["state"] =>
  o === "pending" ? "running" : o === "done" ? "done" : o === "stopped" || o === "declined" ? "stopped" : "failed";

/** A session as the pill shows it: the main thread's steps, the reply so far, and what waits on the user. */
export function quickThread(d: SessionDetail, streaming = ""): QuickThread {
  const main = d.transcript.filter((e) => !e.parent);
  const steps = main.flatMap((e) => (e.kind === "tool" ? [{ label: stepLabel(e.call), state: stepState(e.call.outcome) }] : []));
  const said = main.filter((e): e is Extract<typeof e, { kind: "assistant" }> => e.kind === "assistant");
  const asking = main.some((e) => e.kind === "dialog" && !e.dialog.outcome && e.dialog.mode === "interactive");
  const verdicts = main.reduce((n, e) => n + (e.kind === "qa" ? e.run.awaiting.length : 0), 0);
  const needsYou = d.approvals.length
    ? d.approvals.length === 1 ? "An action is waiting for your approval." : `${d.approvals.length} actions are waiting for your approval.`
    : asking ? "An editor dialog is waiting for you."
    : verdicts ? (verdicts === 1 ? "A playtest step needs you." : `${verdicts} playtest steps need you.`)
    : d.status === "waiting" && d.waitingCause ? d.waitingCause : null;
  const reply = streaming || (said.length ? said[said.length - 1].text : "");
  return {
    sessionId: d.id,
    status: d.status,
    steps: steps.slice(-QUICK_STEPS),
    earlier: Math.max(0, steps.length - QUICK_STEPS),
    reply,
    replyMarkup: richText(reply),
    needsYou,
    error: d.status === "error" ? d.error : null,
  };
}

/** Point Studio at a session: a window that starts later opens on it, one that is open follows the event. */
function focus(api: Pick<DaemonExtensionApi, "events" | "log" | "projectDir">, sessionId: string): void {
  try {
    const file = windowLocationFile(api.projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#/chat/${sessionId}\n`);
  } catch (e) {
    api.log.warn("could not write the window's location for the quick ask", e);
  }
  api.events.publish("session.focus", { sessionId });
}

export function registerQuickRoute(api: Pick<DaemonExtensionApi, "route" | "events" | "log" | "projectDir">, deps: QuickDeps): void {
  // The reply as it streams, per session, for the pill; a finished message replaces it.
  const streams = new Map<string, string>();
  api.events.subscribe((e) => {
    const type = e.type.replace(/^studio\./, "");
    const data = (e.data ?? {}) as Record<string, unknown>;
    const id = typeof data.sessionId === "string" ? data.sessionId : null;
    if (!id) return;
    if (type === "turn.delta") streams.set(id, (streams.get(id) ?? "") + String(data.text ?? ""));
    else if (type === "transcript.added" || (type === "session.changed" && data.status !== "running")) streams.delete(id);
  });
  api.route("GET", "/quick/:id", (req) => {
    const d = deps.detail(req.params.id);
    return d ? { body: quickThread(d, streams.get(d.id)) } : { status: 404, body: { error: `no session ${req.params.id}` } };
  });
  // "Continue this thread": the panel opens on the session, where follow-ups are written.
  api.route("POST", "/quick/:id/continue", (req) => {
    if (!deps.detail(req.params.id)) return { status: 404, body: { error: `no session ${req.params.id}` } };
    focus(api, req.params.id);
    return { status: 204 };
  });
  api.route("POST", "/quick", (req) => {
    const parsed = parseQuickRequest(req.body);
    if (typeof parsed === "string") return { status: 400, body: { error: parsed } };
    if (!deps.connected()) return { status: 409, body: { error: NO_MODEL } };
    const s = deps.create(quickTitle(parsed.text));
    deps.send(s.id, formatQuickMessage(parsed)).catch((e) => api.log.warn(`quick ask in session ${s.id} failed`, e));
    focus(api, s.id);
    return { status: 201, body: { sessionId: s.id } };
  });
}
