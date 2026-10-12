/**
 * Studio and Claude Code share one Claude home, so their sessions are one
 * list: Studio's turns on a Claude sign-in are ordinary transcripts Claude
 * Code resumes, and Claude Code's sessions for the project open in Studio,
 * rebuilt from their transcript and continued on the same conversation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionSummary, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { MessageParam } from "./providers.js";
import type { StoredSession } from "./sessions.js";

/** How recently a transcript must have been written for its session to count as open elsewhere. */
export const ACTIVE_MS = 30_000;

/** The folder Claude keeps a project's transcripts in: the path with every other character a dash. */
export function projectKey(projectDir: string): string {
  return path.resolve(projectDir).replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptsDir(home: string, projectDir: string): string {
  return path.join(home, "projects", projectKey(projectDir));
}

interface Line {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  aiTitle?: string;
  message?: { role?: string; content?: unknown };
}

function readLines(file: string): Line[] {
  const out: Line[] = [];
  for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Line);
    } catch {
      // A line cut off mid-write by a session still running.
    }
  }
  return out;
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
const blocks = (c: unknown): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as Block[]) : []);
const userText = (t: string) => !/^<(command|local-command|system-reminder)/.test(t.trim());
/** Tool names as Studio's transcript writes them. */
const toolName = (n: string) => (n.startsWith("mcp__studio__") ? n.slice("mcp__studio__".length) : n === "Agent" || n === "Task" ? "agent" : n);

/** Title and times of a transcript, cached by modification time. */
const summaries = new Map<string, { mtime: number; title: string; createdAt: string; turns: number }>();

function summarize(file: string): { title: string; createdAt: string; turns: number } | null {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = summaries.get(file);
  if (hit && hit.mtime === mtime) return hit;
  let title = "";
  let first = "";
  let createdAt = "";
  let turns = 0;
  for (const e of readLines(file)) {
    if (e.isSidechain) continue;
    if (e.type === "ai-title" && e.aiTitle) title = e.aiTitle;
    if (e.type !== "user" && e.type !== "assistant") continue;
    createdAt ||= e.timestamp ?? "";
    if (e.type === "user") {
      const t = blocks(e.message?.content).find((b) => b.type === "text" && b.text && userText(b.text));
      if (t) {
        turns++;
        first ||= t.text!.trim().split("\n")[0];
      }
    }
  }
  if (turns === 0) return null;
  const s = { mtime, title: (title || first).slice(0, 120), createdAt: createdAt || new Date(mtime).toISOString(), turns };
  summaries.set(file, s);
  return s;
}

/** The project's Claude Code sessions Studio does not hold yet, newest first. */
export function claudeCodeSessions(home: string, projectDir: string, known: Set<string>, now = Date.now()): SessionSummary[] {
  const dir = transcriptsDir(home, projectDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of files) {
    const id = f.slice(0, -".jsonl".length);
    if (known.has(id)) continue;
    const file = path.join(dir, f);
    try {
      const s = summarize(file);
      if (!s) continue;
      const mtime = fs.statSync(file).mtimeMs;
      out.push({
        id, title: s.title, status: "idle", createdAt: s.createdAt, updatedAt: new Date(mtime).toISOString(),
        waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0,
        origin: "claude-code", activeElsewhere: now - mtime < ACTIVE_MS,
      });
    } catch {
      // Removed while being read.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** When this session's transcript was last written, or null when it has none. */
export function transcriptTime(home: string, projectDir: string, sdkSession: string | null | undefined): number | null {
  if (!sdkSession) return null;
  try {
    return fs.statSync(path.join(transcriptsDir(home, projectDir), `${sdkSession}.jsonl`)).mtimeMs;
  } catch {
    return null;
  }
}

/** Written after Studio last saved the session: another program continued it. */
export function writtenElsewhere(transcript: number | null, studioSaved: string): boolean {
  return transcript !== null && transcript > Date.parse(studioSaved) + 10_000;
}

/** Continued elsewhere within the last ACTIVE_MS, so it is likely still open there. */
export function activeElsewhere(transcript: number | null, studioSaved: string, now = Date.now()): boolean {
  return writtenElsewhere(transcript, studioSaved) && now - transcript! < ACTIVE_MS;
}

/** A Studio session rebuilt from a Claude transcript, continuing the same conversation. */
export function importTranscript(home: string, projectDir: string, id: string): StoredSession | null {
  const file = path.join(transcriptsDir(home, projectDir), `${id}.jsonl`);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !fs.existsSync(file)) return null;
  const s = summarize(file);
  if (!s) return null;
  const transcript: TranscriptEntry[] = [];
  const messages: MessageParam[] = [];
  const calls = new Map<string, ToolCallRecord>();
  let last = s.createdAt;
  for (const e of readLines(file)) {
    if (e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    const at = e.timestamp ?? last;
    last = at;
    for (const b of blocks(e.message?.content)) {
      if (b.type === "text" && b.text?.trim()) {
        if (e.type === "user" && !userText(b.text)) continue;
        transcript.push({ kind: e.type, text: b.text, at });
        const prev = messages[messages.length - 1];
        const head = prev?.content as Array<{ type: "text"; text: string }> | undefined;
        if (prev && prev.role === e.type && head?.[0]) head[0].text += `\n\n${b.text}`;
        else messages.push({ role: e.type, content: [{ type: "text", text: b.text }] });
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
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continued from Claude Code)" }] });
  return {
    id, title: s.title, createdAt: s.createdAt, updatedAt: last, status: "idle", waitingCause: null, error: null, draft: "",
    messages, transcript, touched: [], pending: null, notes: [], crashed: false, sdkSession: id,
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
