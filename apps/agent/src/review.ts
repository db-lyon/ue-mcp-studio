/**
 * Per-turn review, on ue-mcp's checkpoints (api.checkpoints, feature
 * "checkpoints"). Under /v1/ext/studio:
 *
 *   GET  /review/status                          whether review can run here, and the Settings default
 *   PUT  /sessions/:id/review                    the session's switch: { on: true | false | null }, null for the default
 *   GET  /sessions/:id/reviews/:rid/diff?path=   one item's diff, with before and after pictures for a mesh, texture or material
 *   POST /sessions/:id/reviews/:rid/keep         { paths }
 *   POST /sessions/:id/reviews/:rid/revert       { paths, force? }: put them back as they were before the turn
 *   POST /sessions/:id/reviews/:rid/undo         { path }: undo that item's revert
 *   POST /sessions/:id/timeline/restore          { checkpoint, force? }: Restore to here
 *   POST /sessions/:id/timeline/undo             { checkpoint }: undo the restore whose mark it is
 *   GET  /review/images/:name                    a picture the diff view shows
 *
 * Edits stay live. With review on, Studio takes a checkpoint before a turn
 * and after it; when the turn changed files, a review entry in the transcript
 * lists them with Keep or Revert. A revert is a restore of those paths to the
 * checkpoint before the turn, which the daemon itself checkpoints, so it can
 * be undone. A path the user edited after the agent is refused by the daemon
 * and shown as a conflict, reverted only when the user confirms (force).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  reviewItemOf,
  reviewOn,
  type CheckpointChange,
  type RestoreOutcome,
  type ReviewStatus,
  type TimelineMark,
  type TranscriptEntry,
  type TurnReview,
} from "@ue-mcp-studio/shared";
import type { SessionStore, StoredSession } from "./sessions.js";
import { resultImages } from "./tools.js";

/** The daemon's checkpoint shapes (db-lyon/ue-mcp#1482). */
export interface CheckpointInfo {
  id: string;
  label: string;
  createdAt: string;
  trigger: "client" | "restore-before" | "restore-after";
  files: number;
}
export interface CheckpointState {
  editor: string;
  enabled: boolean;
  source: "config" | "session";
  configured: boolean;
  repository: string | null;
  checkpoints: CheckpointInfo[];
}
export interface CheckpointResult extends CheckpointInfo {
  editor: string;
  changes: CheckpointChange[];
  dirtyPackages: string[];
  editorConnected: boolean;
}
export interface ChangesResult {
  editor: string;
  from: string;
  to: string | null;
  changes: CheckpointChange[];
}
export interface RestoreResult {
  editor: string;
  checkpoint: string;
  before: string;
  after: string;
  restored: Array<{ path: string; action: "written" | "deleted" }>;
  refused: Array<{ path: string; reason: "edited-outside" | "not-recorded" }>;
  reloaded: string[];
  unloaded: string[];
  configsReloaded: string[];
  reopened: string[];
}

/** api.checkpoints, as an extension sees it. */
export interface CheckpointApi {
  state(opts?: { editor?: string; limit?: number }): Promise<CheckpointState>;
  setEnabled(enabled: boolean | null, opts?: { editor?: string }): Promise<CheckpointState>;
  create(label?: string, opts?: { editor?: string }): Promise<CheckpointResult>;
  changes(from: string, to?: string, opts?: { editor?: string }): Promise<ChangesResult>;
  restore(checkpoint: string, opts?: { paths?: string[]; force?: boolean; editor?: string }): Promise<RestoreResult>;
}

export interface ReviewHost {
  checkpoints?: CheckpointApi;
  features?: readonly string[];
  projectDir: string;
  dataDir: string;
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  events: { publish(type: string, data?: Record<string, unknown>): unknown };
  log: { warn(message: string, detail?: unknown): void };
}

export interface ReviewOptions {
  host: ReviewHost;
  store: SessionStore;
  /** Settings > Agent: Review each turn. */
  defaultOn: () => boolean;
  now?: () => string;
}

/** Why review cannot run on a daemon without checkpoints. */
export const NO_CHECKPOINTS = "This ue-mcp has no checkpoints, so turns cannot be reviewed. Update ue-mcp.";

/** The most pictures one turn's review captures. */
const MAX_PICTURES = 12;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A package name (/Game/Props/SM_Box) from an object path (/Game/Props/SM_Box.SM_Box). */
const packageOf = (p: string): string => p.replace(/\.[^/]*$/, "");

/** The label a turn's checkpoints carry: its first message, short. */
function turnLabel(s: StoredSession, turn: number): string {
  const e = s.transcript[turn];
  const text = e && e.kind === "user" ? e.text.trim().split("\n")[0] : "";
  return text ? text.slice(0, 60) : `Turn ${turn}`;
}

export class ReviewBroker {
  private readonly now: () => string;
  /** Each session's review work, one step at a time, so a turn's end lands before the next turn's start. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly o: ReviewOptions) {
    this.now = o.now ?? (() => new Date().toISOString());
  }

  private get cp(): CheckpointApi | undefined {
    return this.o.host.checkpoints;
  }

  /** Why checkpoints cannot be used here, or null when they can. */
  unavailable(): string | null {
    return this.cp ? null : NO_CHECKPOINTS;
  }

  status(): ReviewStatus {
    const reason = this.unavailable();
    return { available: !reason, ...(reason ? { reason } : {}), default: this.o.defaultOn() };
  }

  /** Whether a session reviews its turns. */
  on(s: StoredSession): boolean {
    return reviewOn(s, this.o.defaultOn()) && !this.unavailable();
  }

  private serial<T>(sessionId: string, f: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(f, f);
    this.chains.set(sessionId, next.catch(() => undefined));
    return next;
  }

  /** Checkpoints on for this editor: the daemon's override, unless ue-mcp.yml has them on already. */
  async ensureEnabled(): Promise<void> {
    const cp = this.cp;
    if (!cp) throw new Error(NO_CHECKPOINTS);
    const st = await cp.state({ limit: 1 });
    if (!st.enabled) await cp.setEnabled(true);
  }

  /** The session's switch. Off everywhere drops Studio's override, so no save is intercepted for it. */
  async setSession(sessionId: string, on: boolean | null): Promise<StoredSession | null> {
    const s = this.o.store.get(sessionId);
    if (!s) return null;
    s.review = on;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    const cp = this.cp;
    if (cp && !reviewOn(s, this.o.defaultOn()) && !this.o.store.all().some((x) => reviewOn(x, this.o.defaultOn()))) {
      try {
        const st = await cp.state({ limit: 1 });
        if (st.source === "session") await cp.setEnabled(null);
      } catch (e) {
        this.o.host.log.warn("could not drop the checkpoint override", e);
      }
    }
    return s;
  }

  /** A checkpoint for the session's timeline, from the review itself or a playtest loop attempt. */
  async checkpoint(label: string): Promise<CheckpointResult> {
    await this.ensureEnabled();
    return this.cp!.create(label);
  }

  async changes(from: string, to?: string): Promise<CheckpointChange[]> {
    const cp = this.cp;
    if (!cp) throw new Error(NO_CHECKPOINTS);
    return (await cp.changes(from, to)).changes;
  }

  /** Restore paths (all of them when none are given) to a checkpoint, as the card reports it. */
  async restore(checkpoint: string, paths?: string[], force = false): Promise<RestoreOutcome & { before: string; after: string }> {
    const cp = this.cp;
    if (!cp) throw new Error(NO_CHECKPOINTS);
    const r = await cp.restore(checkpoint, { ...(paths ? { paths } : {}), ...(force ? { force: true } : {}) });
    return {
      restored: r.restored.map((x) => x.path),
      conflicts: r.refused.filter((x) => x.reason === "edited-outside").map((x) => x.path),
      missing: r.refused.filter((x) => x.reason === "not-recorded").map((x) => x.path),
      before: r.before,
      after: r.after,
    };
  }

  /** A turn began: the checkpoint before it, while review is on. */
  turnStarted(s: StoredSession): Promise<void> {
    return this.serial(s.id, async () => {
      s.reviewing = null;
      if (!this.on(s) || !s.turn || s.turn.playtest) return;
      try {
        const before = await this.checkpoint(`Before: ${turnLabel(s, s.turn.start)}`);
        s.reviewing = { before: before.id, turn: s.turn.start };
      } catch (e) {
        this.o.host.log.warn("the checkpoint before the turn failed; this turn is not reviewed", e);
      }
      this.o.store.save(s);
    });
  }

  /**
   * A turn ended: the checkpoint after it, its mark on the timeline, and when
   * it changed files, a review entry. Packages the turn changed and left
   * unsaved are saved first, since the shadow history records disk.
   */
  turnEnded(s: StoredSession): Promise<void> {
    return this.serial(s.id, async () => {
      const r = s.reviewing;
      if (!r) return;
      s.reviewing = null;
      this.o.store.save(s);
      const label = turnLabel(s, r.turn);
      try {
        let after = await this.checkpoint(`After: ${label}`);
        const mine = new Set((s.turn?.targets ?? []).filter((t) => t.kind === "asset").map((t) => packageOf(t.path)));
        const unsaved = after.dirtyPackages.filter((p) => mine.has(packageOf(p)));
        if (unsaved.length) {
          const saved = await this.o.host.callAction("asset", "save", { assetPaths: unsaved }).catch(() => null);
          if (saved && !saved.isError) after = await this.checkpoint(`After: ${label}`);
        }
        const changes = await this.changes(r.before, after.id);
        const at = this.now();
        this.mark(s, { checkpoint: after.id, label, at, kind: "turn", turn: r.turn });
        if (changes.length === 0) return;
        const review: TurnReview = {
          id: crypto.randomUUID(),
          turn: r.turn,
          before: r.before,
          after: after.id,
          at,
          items: changes.map(reviewItemOf),
          ...(after.dirtyPackages.length ? { dirty: after.dirtyPackages } : {}),
        };
        const entry: TranscriptEntry = { kind: "review", review };
        s.transcript.push(entry);
        this.o.store.save(s);
        this.o.host.events.publish("transcript.added", { sessionId: s.id, entry: entry as unknown as Record<string, unknown> });
        await this.pictures(review);
      } catch (e) {
        this.o.host.log.warn("the checkpoint after the turn failed; this turn is not reviewed", e);
      }
    });
  }

  /** Add a mark to the session's timeline. */
  mark(s: StoredSession, m: TimelineMark): void {
    s.timeline = [...(s.timeline ?? []), m];
    this.o.store.save(s);
    this.o.host.events.publish("review.changed", { sessionId: s.id });
  }

  private find(sessionId: string, reviewId: string): { s: StoredSession; review: TurnReview } | null {
    const s = this.o.store.get(sessionId);
    const e = s?.transcript.find((t) => t.kind === "review" && t.review.id === reviewId);
    return s && e?.kind === "review" ? { s, review: e.review } : null;
  }

  private changed(s: StoredSession, review: TurnReview): void {
    this.o.store.save(s);
    this.o.host.events.publish("review.changed", { sessionId: s.id, reviewId: review.id, review: review as unknown as Record<string, unknown> });
  }

  keep(sessionId: string, reviewId: string, body: unknown): { review: TurnReview } | { error: string; status: number } {
    const f = this.find(sessionId, reviewId);
    if (!f) return { error: `no review ${reviewId}`, status: 404 };
    const paths = (body as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) return { error: "body must be { paths: string[] }", status: 400 };
    for (const it of f.review.items) if (paths.includes(it.path) && it.state === "pending") it.state = "kept";
    this.changed(f.s, f.review);
    return { review: f.review };
  }

  /** Revert items: each path back to the checkpoint before the turn. The rest of the turn stays. */
  async revert(sessionId: string, reviewId: string, body: unknown): Promise<{ review: TurnReview; outcome: RestoreOutcome } | { error: string; status: number }> {
    const f = this.find(sessionId, reviewId);
    if (!f) return { error: `no review ${reviewId}`, status: 404 };
    const b = (body ?? {}) as { paths?: unknown; force?: unknown };
    if (!Array.isArray(b.paths) || b.paths.length === 0 || !b.paths.every((p) => typeof p === "string")) return { error: "body must be { paths: string[], force? }", status: 400 };
    const paths = (b.paths as string[]).filter((p) => f.review.items.some((it) => it.path === p && it.state !== "reverted"));
    if (paths.length === 0) return { error: "nothing to revert", status: 409 };
    let outcome: RestoreOutcome & { before: string; after: string };
    try {
      outcome = await this.restore(f.review.before, paths, b.force === true);
    } catch (e) {
      return { error: messageOf(e), status: 409 };
    }
    for (const it of f.review.items) {
      if (outcome.restored.includes(it.path)) {
        it.state = "reverted";
        it.undo = outcome.before;
        delete it.conflict;
      } else if (outcome.conflicts.includes(it.path)) it.conflict = true;
    }
    if (outcome.restored.length) this.mark(f.s, { checkpoint: outcome.after, label: `Reverted ${outcome.restored.length === 1 ? outcome.restored[0].split("/").pop() : `${outcome.restored.length} files`}`, at: this.now(), kind: "restore", undo: outcome.before });
    this.changed(f.s, f.review);
    return { review: f.review, outcome };
  }

  /** Undo one item's revert: the path back as it was just before the revert. */
  async undoRevert(sessionId: string, reviewId: string, body: unknown): Promise<{ review: TurnReview; outcome: RestoreOutcome } | { error: string; status: number }> {
    const f = this.find(sessionId, reviewId);
    if (!f) return { error: `no review ${reviewId}`, status: 404 };
    const p = (body as { path?: unknown } | undefined)?.path;
    const it = f.review.items.find((x) => x.path === p);
    if (!it || it.state !== "reverted" || !it.undo) return { error: "that item has no revert to undo", status: 409 };
    let outcome: RestoreOutcome;
    try {
      outcome = await this.restore(it.undo, [it.path], (body as { force?: unknown }).force === true);
    } catch (e) {
      return { error: messageOf(e), status: 409 };
    }
    if (outcome.restored.includes(it.path)) {
      it.state = "pending";
      delete it.undo;
      delete it.conflict;
    } else if (outcome.conflicts.includes(it.path)) it.conflict = true;
    this.changed(f.s, f.review);
    return { review: f.review, outcome };
  }

  /** Restore to here: every recorded path back to a mark's checkpoint. The restore is a mark of its own, with Undo. */
  async restoreTo(sessionId: string, body: unknown): Promise<{ timeline: TimelineMark[]; outcome: RestoreOutcome } | { error: string; status: number }> {
    const s = this.o.store.get(sessionId);
    if (!s) return { error: `no session ${sessionId}`, status: 404 };
    const b = (body ?? {}) as { checkpoint?: unknown; force?: unknown };
    const m = (s.timeline ?? []).find((x) => x.checkpoint === b.checkpoint && x.kind !== "restore");
    if (!m) return { error: "that checkpoint is not on this session's timeline", status: 404 };
    let outcome: RestoreOutcome & { before: string; after: string };
    try {
      outcome = await this.restore(m.checkpoint, undefined, b.force === true);
    } catch (e) {
      return { error: messageOf(e), status: 409 };
    }
    this.mark(s, { checkpoint: outcome.after, label: `Restored to: ${m.label}`, at: this.now(), kind: "restore", undo: outcome.before });
    return { timeline: s.timeline ?? [], outcome };
  }

  /** Undo a restore: back to the checkpoint taken just before it. */
  async undoRestore(sessionId: string, body: unknown): Promise<{ timeline: TimelineMark[]; outcome: RestoreOutcome } | { error: string; status: number }> {
    const s = this.o.store.get(sessionId);
    if (!s) return { error: `no session ${sessionId}`, status: 404 };
    const b = (body ?? {}) as { checkpoint?: unknown; force?: unknown };
    const m = (s.timeline ?? []).find((x) => x.checkpoint === b.checkpoint && x.kind === "restore");
    if (!m?.undo || m.undone) return { error: "that restore cannot be undone", status: 409 };
    let outcome: RestoreOutcome;
    try {
      outcome = await this.restore(m.undo, undefined, b.force === true);
    } catch (e) {
      return { error: messageOf(e), status: 409 };
    }
    m.undone = true;
    this.o.store.save(s);
    this.o.host.events.publish("review.changed", { sessionId: s.id });
    return { timeline: s.timeline ?? [], outcome };
  }

  // ── Diffs and pictures ────────────────────────────────────────────

  /** One item's diff, read from the daemon, with the pictures kept for it. */
  async diff(sessionId: string, reviewId: string, file: string): Promise<{ change: CheckpointChange; before?: string; after?: string } | { error: string; status: number }> {
    const f = this.find(sessionId, reviewId);
    if (!f) return { error: `no review ${reviewId}`, status: 404 };
    const item = f.review.items.find((x) => x.path === file);
    if (!item) return { error: `the review has no ${file}`, status: 404 };
    let change: CheckpointChange | undefined;
    try {
      change = (await this.changes(f.review.before, f.review.after)).find((c) => c.path === file);
    } catch (e) {
      return { error: messageOf(e), status: 409 };
    }
    if (!change) return { error: `${file} is no longer in the turn's changes`, status: 404 };
    if (!item.visual || !item.asset) return { change };
    const pics = this.picturesOf(item.asset);
    const after = pics.find((p) => p.checkpoint === f.review.after);
    const before = pics.filter((p) => p.checkpoint !== f.review.after && p.at <= Date.parse(f.review.at)).pop();
    return { change, ...(before ? { before: before.name } : {}), ...(after ? { after: after.name } : {}) };
  }

  private picturesDir(): string {
    return path.join(this.o.host.dataDir, "review-images");
  }

  /** The pictures kept for an asset, oldest first. */
  private picturesOf(asset: string): Array<{ name: string; checkpoint: string; at: number }> {
    const key = crypto.createHash("sha1").update(asset).digest("hex").slice(0, 16);
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.picturesDir()).filter((n) => n.startsWith(`${key}-`));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const m = /^[0-9a-f]+-([0-9a-f]+)-(\d+)\.(png|jpg)$/.exec(name);
        return m ? { name, checkpoint: m[1], at: Number(m[2]) } : null;
      })
      .filter((x): x is { name: string; checkpoint: string; at: number } => !!x)
      .sort((a, b) => a.at - b.at);
  }

  /** The after picture of each mesh, texture and material a turn changed, kept for its diff and the next turn's before. */
  private async pictures(review: TurnReview): Promise<void> {
    const visual = review.items.filter((it) => it.visual && it.asset && it.status !== "deleted").slice(0, MAX_PICTURES);
    if (!visual.length) return;
    fs.mkdirSync(this.picturesDir(), { recursive: true });
    for (const it of visual) {
      const since = Date.now();
      const r = await this.o.host.callAction("editor", "epic_capture_asset_image", { assetPath: it.asset }).catch(() => null);
      if (!r || r.isError) continue;
      const img = (await resultImages(this.o.host.projectDir, r, since, 3000).catch(() => []))[0];
      if (!img) continue;
      const key = crypto.createHash("sha1").update(it.asset!).digest("hex").slice(0, 16);
      const ext = img.mediaType === "image/jpeg" ? "jpg" : "png";
      fs.writeFileSync(path.join(this.picturesDir(), `${key}-${review.after}-${Date.parse(review.at)}.${ext}`), Buffer.from(img.data, "base64"));
    }
  }

  /** A kept picture's bytes, by its name. */
  picture(name: string): { type: string; bytes: Buffer } | null {
    const m = /^[0-9a-f]+-[0-9a-f]+-\d+\.(png|jpg)$/.exec(name);
    if (!m) return null;
    try {
      return { type: m[1] === "jpg" ? "image/jpeg" : "image/png", bytes: fs.readFileSync(path.join(this.picturesDir(), name)) };
    } catch {
      return null;
    }
  }
}

type Answer = { status?: number; body?: unknown };
const answer = (r: object): Answer => ("error" in r && "status" in r ? { status: (r as { status: number }).status, body: { error: (r as { error: string }).error } } : { body: r });

export function registerReview(api: DaemonExtensionApi, store: SessionStore, defaultOn: () => boolean): ReviewBroker {
  const broker = new ReviewBroker({ host: api as unknown as ReviewHost, store, defaultOn });
  api.route("GET", "/review/status", () => ({ body: broker.status() }));
  api.route("PUT", "/sessions/:id/review", async (req) => {
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (on !== true && on !== false && on !== null) return { status: 400, body: { error: "body must be { on: true | false | null }" } };
    const s = await broker.setSession(req.params.id, on);
    return s ? { body: { review: s.review ?? null } } : { status: 404, body: { error: `no session ${req.params.id}` } };
  });
  api.route("GET", "/sessions/:id/reviews/:rid/diff", async (req) => {
    const file = (req.query as Record<string, string | undefined>).path;
    if (!file) return { status: 400, body: { error: "path is required" } };
    return answer(await broker.diff(req.params.id, req.params.rid, file));
  });
  api.route("POST", "/sessions/:id/reviews/:rid/keep", (req) => answer(broker.keep(req.params.id, req.params.rid, req.body)));
  api.route("POST", "/sessions/:id/reviews/:rid/revert", async (req) => answer(await broker.revert(req.params.id, req.params.rid, req.body)));
  api.route("POST", "/sessions/:id/reviews/:rid/undo", async (req) => answer(await broker.undoRevert(req.params.id, req.params.rid, req.body)));
  api.route("POST", "/sessions/:id/timeline/restore", async (req) => answer(await broker.restoreTo(req.params.id, req.body)));
  api.route("POST", "/sessions/:id/timeline/undo", async (req) => answer(await broker.undoRestore(req.params.id, req.body)));
  api.route("GET", "/review/images/:name", (req) => {
    const p = broker.picture(req.params.name);
    return p ? { headers: { "content-type": p.type, "cache-control": "private, max-age=86400" }, body: p.bytes } : { status: 404, body: { error: "no such picture" } };
  });
  return broker;
}
