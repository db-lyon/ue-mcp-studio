/**
 * Conversations on disk, one JSON file per session under the extension's data
 * dir (per project, outside Saved/, which users delete). Every state change is
 * written before it is announced, so a daemon restart resumes exactly where
 * the last write left off.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionDetail, SessionSummary, TouchedItem, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";
import type { MessageParam } from "./providers.js";

/** A tool call the model asked for that has not been answered yet. */
export interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** running survives a crash or restart only as unknown: whether it took effect is not known. */
  state: "queued" | "running" | "unknown" | "done";
  result?: string;
  isError?: boolean;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: TurnStatus;
  waitingCause: string | null;
  error: string | null;
  draft: string;
  /** The conversation as the model sees it. */
  messages: MessageParam[];
  /** The conversation as the UI shows it. */
  transcript: TranscriptEntry[];
  touched: TouchedItem[];
  pending: PendingTool[] | null;
  /** System notes waiting to be given to the model with the next tool results or user message. */
  notes: string[];
  /** The editor crashed since the last reconcile. */
  crashed: boolean;
  /** Experimental: the Agent SDK session a Claude subscription turn continues. */
  sdkSession?: string | null;
}

export class SessionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, StoredSession>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as StoredSession;
        this.cache.set(s.id, s);
      } catch {
        // A half-written file from a crash mid-write: the rename never happened, so the previous version is the .json.
      }
    }
  }

  create(title = "New session"): StoredSession {
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      waitingCause: null,
      error: null,
      draft: "",
      messages: [],
      transcript: [],
      touched: [],
      pending: null,
      notes: [],
      crashed: false,
    };
    this.save(s);
    return s;
  }

  get(id: string): StoredSession | undefined {
    return this.cache.get(id);
  }

  all(): StoredSession[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Write through a rename, so a reader or a restart never sees half a session. */
  save(s: StoredSession): void {
    s.updatedAt = new Date().toISOString();
    this.cache.set(s.id, s);
    const file = path.join(this.dir, `${s.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }

  delete(id: string): boolean {
    this.cache.delete(id);
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  static summary(s: StoredSession): SessionSummary {
    return { id: s.id, title: s.title, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, waitingCause: s.waitingCause };
  }

  static detail(s: StoredSession): SessionDetail {
    return { ...SessionStore.summary(s), transcript: s.transcript, touched: s.touched, draft: s.draft, error: s.error };
  }
}
