/**
 * The hub's run history, per machine: <dataDir>/hub/runs.jsonl, one RunRecord
 * per line, appended as runs change and finish. The newest line for a run
 * wins. On start the file is compacted to one line per run, the newest
 * MAX_RUNS of them, so it never grows without end.
 *
 * Studio's own runs are recorded as the QaBroker saves them. Runs ue-mcp has a
 * record of (pie(script_runs), or results.json without it) are backfilled, so
 * runs started outside Studio, or before this daemon, are history too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkId,
  outcomeOf,
  qaEnded,
  qaIsDraft,
  qaScriptKey,
  type CheckKind,
  type QaRun,
  type RunOutcome,
  type RunRecord,
  type RunSource,
  type TrackerLink,
} from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "../atomic-write.js";
import { readLinks } from "./util.js";

/** The most runs kept. */
export const MAX_RUNS = 5000;
const OUTCOMES: readonly RunOutcome[] = ["passed", "failed", "needs_you", "running", "incomplete", "stopped", "error"];
const SOURCES: readonly RunSource[] = ["person", "agent", "plan", "schedule", "outside"];
const KINDS: readonly CheckKind[] = ["script", "uat", "repro", "automation", "manual"];

/** What started a run, as far as its QaRun tells: no session is outside Studio; a subagent or tool call is an agent; a card's button is a person. */
export function sourceOf(run: QaRun): RunSource {
  if (!run.sessionId) return "outside";
  if (run.subagent || run.assignment || run.toolUseId) return "agent";
  return "person";
}

/** Who started a run when the hub did it: a plan's run, or a schedule's. */
export interface RunTag {
  source: RunSource;
  planRunId: string;
}

/**
 * A run's record from its QaRun, keeping what the earlier record already
 * settled (when it started, when it ended, who started it). Null for what is
 * no run of a check: a draft, inline steps, a manual run (it judges the
 * manual steps alone, the full run holds the evidence), an idle answer.
 */
export function recordOf(run: QaRun, o: { prev?: RunRecord; times?: { startedAt?: string; endedAt?: string }; tag?: RunTag; now: string }): RunRecord | null {
  if (qaIsDraft(run) || run.script === "inline" || run.manual || run.state === "idle") return null;
  const prev = o.prev;
  const outcome = outcomeOf(run);
  const ended = qaEnded(run.state);
  const startedAt = prev?.startedAt ?? o.times?.startedAt ?? run.seenAt;
  const endedAt = ended ? prev?.endedAt ?? o.times?.endedAt ?? o.now : null;
  const ms = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
  // A plan's or a schedule's run stays theirs; otherwise the better-informed QaRun says.
  const source = o.tag?.source ?? (prev && (prev.source === "plan" || prev.source === "schedule") ? prev.source : sourceOf(run));
  const failedSteps = run.steps.filter((s) => s.status === "failed").map((s) => s.index);
  return {
    runId: run.runId,
    kind: "script",
    target: qaScriptKey(run.script),
    name: run.scriptName,
    outcome,
    startedAt,
    endedAt,
    durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
    summary: run.summary,
    ...(failedSteps.length ? { failedSteps } : {}),
    source,
    sessionId: run.sessionId,
    planRunId: o.tag?.planRunId ?? prev?.planRunId ?? null,
    replayOf: run.replayOf ?? null,
    recordingId: run.recordingId ?? null,
    map: run.map ?? null,
    // Links are the hub's, never the QaRun's: a run changing keeps them.
    ...(prev?.links?.length ? { links: prev.links } : {}),
  };
}

/** A record read from the file, or null when the line is not one. */
function recordFrom(v: unknown): RunRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<RunRecord>;
  if (typeof r.runId !== "string" || !r.runId || typeof r.target !== "string" || typeof r.name !== "string" || typeof r.startedAt !== "string") return null;
  if (!KINDS.includes(r.kind as CheckKind) || !OUTCOMES.includes(r.outcome as RunOutcome) || !SOURCES.includes(r.source as RunSource)) return null;
  if (r.links === undefined) return r as RunRecord;
  const { links } = readLinks(r.links);
  const { links: _had, ...rest } = r as RunRecord;
  return links.length ? { ...rest, links } : rest;
}

/** Newest first: by start, then by id, which carries the start time too. */
const newest = (a: RunRecord, b: RunRecord): number => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0);

export interface RunIndexOptions {
  dataDir: string;
  max?: number;
  now?: () => string;
  /** A record was added or changed. */
  changed?: (runId: string) => void;
  log?: { warn(message: string, detail?: unknown): void };
}

export class RunIndex {
  private readonly runs = new Map<string, RunRecord>();
  /** Runs by check id, newest first; rebuilt when a record changes. */
  private byCheckCache: Map<string, RunRecord[]> | null = null;
  private sortedCache: RunRecord[] | null = null;
  /** Hub runs' tags, kept until their record takes them. */
  private readonly tags = new Map<string, RunTag>();
  private readonly file: string;
  private readonly max: number;
  private readonly now: () => string;
  /** Lines appended since the file was last compacted. */
  private appended = 0;
  /** Linked runs the last compaction kept past the cap. */
  private beyond = 0;

  constructor(private readonly o: RunIndexOptions) {
    this.file = path.join(o.dataDir, "hub", "runs.jsonl");
    this.max = o.max ?? MAX_RUNS;
    this.now = o.now ?? (() => new Date().toISOString());
    this.load();
    this.compact();
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = recordFrom(JSON.parse(line));
        if (r) this.runs.set(r.runId, r);
      } catch {
        // A line cut short by a crash: the rest of the file still counts.
      }
    }
  }

  /** The file rewritten with one line per run, the newest `max` of them. */
  private compact(): void {
    // A run someone linked to a tracker item stays past the cap.
    const keep = [...this.runs.values()].sort(newest).filter((r, i) => i < this.max || !!r.links?.length);
    if (keep.length < this.runs.size) {
      this.runs.clear();
      for (const r of keep) this.runs.set(r.runId, r);
    }
    this.beyond = Math.max(0, keep.length - this.max);
    this.dirty();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, keep.reverse().map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
      this.appended = 0;
    } catch (e) {
      this.o.log?.warn("hub: the run history could not be compacted", e);
    }
  }

  private dirty(): void {
    this.byCheckCache = null;
    this.sortedCache = null;
  }

  /** Keep a record; a change is appended to the file and announced. Returns whether anything changed. */
  put(r: RunRecord): boolean {
    const had = this.runs.get(r.runId);
    const line = JSON.stringify(r);
    if (had && JSON.stringify(had) === line) return false;
    this.runs.set(r.runId, r);
    this.dirty();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${line}\n`);
      this.appended++;
    } catch (e) {
      this.o.log?.warn("hub: a run could not be added to the history", e);
    }
    if (this.runs.size > this.max + this.beyond || this.appended > this.max) this.compact();
    this.o.changed?.(r.runId);
    return true;
  }

  /** A run's links replaced; an empty list removes them. Returns the record, or undefined for a run not held. */
  setLinks(runId: string, links: TrackerLink[]): RunRecord | undefined {
    const had = this.runs.get(runId);
    if (!had) return undefined;
    const { links: _old, ...rest } = had;
    this.put(links.length ? { ...rest, links } : rest);
    return this.runs.get(runId);
  }

  /** Mark a run the hub started as a plan's or a schedule's, now or when its record is first made. */
  tag(runId: string, tag: RunTag): void {
    this.tags.set(runId, tag);
    const had = this.runs.get(runId);
    if (had && (had.source !== tag.source || had.planRunId !== tag.planRunId)) this.put({ ...had, source: tag.source, planRunId: tag.planRunId });
  }

  /** A run as Studio has it now. */
  record(run: QaRun, times?: { startedAt?: string; endedAt?: string }): RunRecord | null {
    const r = recordOf(run, { prev: this.runs.get(run.runId), times, tag: this.tags.get(run.runId), now: this.now() });
    if (!r) return null;
    this.put(r);
    // The record keeps its source and plan from here on, so the tag is not kept for ever.
    this.tags.delete(r.runId);
    return this.runs.get(r.runId) ?? r;
  }

  /** A run ue-mcp recorded, kept unless Studio already holds a finished record of it. */
  backfill(run: QaRun, times: { startedAt?: string; endedAt?: string }): void {
    const had = this.runs.get(run.runId);
    if (had && had.outcome !== "running" && had.outcome !== "needs_you") return;
    // A record from results.json that says nothing new about an open run is left as Studio has it.
    if (had && !qaEnded(run.state)) return;
    this.record(run, times);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  size(): number {
    return this.runs.size;
  }

  /** Every run, newest first. */
  all(): RunRecord[] {
    if (!this.sortedCache) this.sortedCache = [...this.runs.values()].sort(newest);
    return this.sortedCache;
  }

  /** One check's runs, newest first. */
  byCheck(id: string): RunRecord[] {
    if (!this.byCheckCache) {
      const m = new Map<string, RunRecord[]>();
      for (const r of this.all()) {
        const k = checkId(r);
        const list = m.get(k);
        if (list) list.push(r);
        else m.set(k, [r]);
      }
      this.byCheckCache = m;
    }
    return this.byCheckCache.get(id) ?? [];
  }

  /** Every check id that has runs. */
  checkIds(): string[] {
    this.byCheck("");
    return [...this.byCheckCache!.keys()];
  }

  /**
   * A page of runs, newest first: of one check, or of all. `before` is a run
   * id (runs after it in the list) or an ISO time (runs that started earlier).
   */
  page(o: { check?: string | null; limit: number; before?: string | null }): { runs: RunRecord[]; more: boolean } {
    const list = o.check ? this.byCheck(o.check) : this.all();
    let start = 0;
    if (o.before) {
      const at = list.findIndex((r) => r.runId === o.before);
      start = at >= 0 ? at + 1 : list.findIndex((r) => r.startedAt < o.before!);
      if (start < 0) start = list.length;
    }
    const runs = list.slice(start, start + o.limit);
    return { runs, more: start + o.limit < list.length };
  }
}
