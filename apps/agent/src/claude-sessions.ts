/**
 * Studio and Claude Code share one Claude home, so their sessions are one
 * list: Studio's turns on a Claude sign-in are ordinary transcripts Claude
 * Code resumes, and Claude Code's sessions for the project open in Studio,
 * read through the Agent SDK's session API and continued on the same conversation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionMessages, listSessions, type SDKSessionInfo, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSummary, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { MessageParam } from "./providers.js";
import type { StoredSession } from "./sessions.js";

/** How recently another program must have written a session for it to count as open there. */
export const ACTIVE_MS = 30_000;

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
const blocks = (c: unknown): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as Block[]) : []);
const userText = (t: string) => !/^<(command|local-command|system-reminder)/.test(t.trim());
/** Tool names as Studio's transcript writes them. */
const toolName = (n: string) => (n.startsWith("mcp__studio__") ? n.slice("mcp__studio__".length) : n === "Agent" || n === "Task" ? "agent" : n);
const iso = (ms: number | undefined) => new Date(ms ?? Date.now()).toISOString();
const titleOf = (i: SDKSessionInfo) => (i.customTitle || i.summary || i.firstPrompt || "Claude Code session").trim().split("\n")[0].slice(0, 120);

/** The project's Claude sessions, through the Agent SDK's own listing; none when it cannot read them. */
export async function projectSessions(projectDir: string, list = listSessions): Promise<SDKSessionInfo[]> {
  try {
    return await list({ dir: projectDir });
  } catch {
    return [];
  }
}

/** The project's Claude Code sessions Studio does not hold yet, as list rows. */
export function claudeCodeRows(sessions: SDKSessionInfo[], known: Set<string>, now = Date.now()): SessionSummary[] {
  return sessions
    .filter((i) => !known.has(i.sessionId))
    .map((i) => ({
      id: i.sessionId, title: titleOf(i), status: "idle" as const, createdAt: iso(i.createdAt ?? i.lastModified), updatedAt: iso(i.lastModified),
      waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0,
      origin: "claude-code" as const, ...(now - i.lastModified < ACTIVE_MS ? { activeElsewhere: true } : {}),
    }));
}

/** Written after Studio last saved the session: another program continued it. */
export function writtenElsewhere(lastModified: number | null | undefined, studioSaved: string): boolean {
  return lastModified != null && lastModified > Date.parse(studioSaved) + 10_000;
}

/** Continued elsewhere within the last ACTIVE_MS, so it is likely still open there. */
export function activeElsewhere(lastModified: number | null | undefined, studioSaved: string, now = Date.now()): boolean {
  return writtenElsewhere(lastModified, studioSaved) && now - lastModified! < ACTIVE_MS;
}

/** A Studio session rebuilt from a Claude session, continuing the same conversation. */
export async function importSession(projectDir: string, info: SDKSessionInfo, read = getSessionMessages): Promise<StoredSession | null> {
  let lines: SessionMessage[];
  try {
    lines = await read(info.sessionId, { dir: projectDir });
  } catch {
    return null;
  }
  const at = iso(info.lastModified);
  const transcript: TranscriptEntry[] = [];
  const messages: MessageParam[] = [];
  const calls = new Map<string, ToolCallRecord>();
  for (const e of lines) {
    if (e.parent_tool_use_id || (e.type !== "user" && e.type !== "assistant")) continue;
    const role = e.type;
    for (const b of blocks((e.message as { content?: unknown } | null)?.content)) {
      if (b.type === "text" && b.text?.trim()) {
        if (role === "user" && !userText(b.text)) continue;
        transcript.push({ kind: role, text: b.text, at });
        const prev = messages[messages.length - 1];
        const head = prev?.content as Array<{ type: "text"; text: string }> | undefined;
        if (prev && prev.role === role && head?.[0]) head[0].text += `\n\n${b.text}`;
        else messages.push({ role, content: [{ type: "text", text: b.text }] });
      } else if (b.type === "tool_use" && b.id && b.name) {
        const call: ToolCallRecord = { id: b.id, name: toolName(b.name), input: b.input ?? {}, outcome: "done", startedAt: at };
        calls.set(b.id, call);
        transcript.push({ kind: "tool", call });
      } else if (b.type === "tool_result" && b.tool_use_id && calls.has(b.tool_use_id)) {
        const c = calls.get(b.tool_use_id)!;
        c.result = (typeof b.content === "string" ? b.content : blocks(b.content).map((x) => x.text ?? "").join("\n")).slice(0, 20_000);
        c.outcome = b.is_error ? "error" : "done";
        c.endedAt = at;
      }
    }
  }
  if (transcript.length === 0) return null;
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continued from Claude Code)" }] });
  return {
    id: info.sessionId, title: titleOf(info), createdAt: iso(info.createdAt ?? info.lastModified), updatedAt: at, status: "idle", waitingCause: null, error: null, draft: "",
    messages, transcript, touched: [], pending: null, notes: [], crashed: false, sdkSession: info.sessionId,
  };
}

/**
 * Move what Studio kept in its own Claude home into the shared one, once: the
 * transcripts it does not have, and the sign-in when the shared home has none.
 */
export function migrateHome(oldHome: string, home: string): void {
  const marker = path.join(oldHome, "moved-to-shared-home");
  if (!fs.existsSync(oldHome) || fs.existsSync(marker) || path.resolve(oldHome) === path.resolve(home)) return;
  const copyMissing = (from: string, to: string) => {
    if (!fs.existsSync(from)) return;
    for (const name of fs.readdirSync(from)) {
      const a = path.join(from, name);
      const b = path.join(to, name);
      if (fs.statSync(a).isDirectory()) copyMissing(a, b);
      else if (!fs.existsSync(b)) {
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(a, b);
      }
    }
  };
  copyMissing(path.join(oldHome, "projects"), path.join(home, "projects"));
  const creds = path.join(oldHome, ".credentials.json");
  if (fs.existsSync(creds) && !fs.existsSync(path.join(home, ".credentials.json"))) {
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(creds, path.join(home, ".credentials.json"));
  }
  fs.writeFileSync(marker, `${home}\n`);
}
