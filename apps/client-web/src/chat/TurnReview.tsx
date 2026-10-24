/**
 * Per-turn review in the chat: the turn card listing what a turn changed,
 * grouped by type, with Keep or Revert per item and Revert all; each item's
 * diff (text for config and source, the Blueprint diff for Blueprints, before
 * and after pictures for meshes, textures and materials); and the session's
 * checkpoint timeline with Restore to here and Undo.
 */
import { useContext, useEffect, useState } from "react";
import {
  REVIEW_GROUPS,
  unifiedLines,
  type CheckpointChange,
  type RestoreOutcome,
  type ReviewItem,
  type ReviewStatus,
  type TimelineMark,
  type TurnReview,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";
import { SessionIdContext } from "./attachments";

const STATUS: Record<ReviewItem["status"], string> = { added: "Added", modified: "Modified", deleted: "Deleted" };
const fileName = (p: string): string => p.split("/").pop() || p;

/** What a revert or restore left alone, in words. */
export function outcomeNote(o: RestoreOutcome): string | null {
  const parts: string[] = [];
  if (o.conflicts.length) parts.push(`${o.conflicts.length === 1 ? "1 file was" : `${o.conflicts.length} files were`} edited after the agent and left as they are`);
  if (o.missing.length) parts.push(`${o.missing.length === 1 ? "1 file has" : `${o.missing.length} files have`} no earlier version to put back`);
  return parts.length ? `${parts.join("; ")}.` : null;
}

/** A turn's changes, with Keep or Revert per item. */
export function TurnReviewCard({ review: saved }: { review: TurnReview }) {
  const sessionId = useContext(SessionIdContext);
  const [review, setReview] = useState(saved);
  useEffect(() => setReview(saved), [saved]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A conflict whose Revert anyway waits for its second click. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = (call: () => Promise<{ review: TurnReview; outcome?: RestoreOutcome }>) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    setNote(null);
    call().then((r) => {
      setReview(r.review);
      setNote(r.outcome ? outcomeNote(r.outcome) : null);
    }, (e: Error) => setError(e.message)).finally(() => {
      setBusy(false);
      setConfirming(null);
    });
  };
  const keep = (paths: string[]) => run(async () => api.reviewKeep(sessionId!, review.id, paths));
  const revert = (paths: string[], force = false) => run(() => api.reviewRevert(sessionId!, review.id, paths, force));
  const undo = (path: string) => run(() => api.reviewUndo(sessionId!, review.id, path));

  const open_ = review.items.filter((i) => i.state !== "reverted");
  const reverted = review.items.length - open_.length;
  return (
    <div className="card review-card" role="group" aria-label="Changes in this turn">
      <div className="review-head">
        <span className="eyebrow">Changes in this turn</span>
        <span className="dim small">{review.items.length === 1 ? "1 file" : `${review.items.length} files`}{reverted ? `, ${reverted} reverted` : ""}</span>
        <span className="spacer" />
        {open_.length > 0 && (
          <button className="small-button" disabled={busy || !sessionId} onClick={() => revert(open_.map((i) => i.path))}>Revert all</button>
        )}
      </div>
      {REVIEW_GROUPS.map(({ group, label }) => {
        const items = review.items.filter((i) => i.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="review-group">
            <div className="review-group-label small dim">{label}</div>
            <ul className="review-items">
              {items.map((it) => (
                <li key={it.path} className={`review-item state-${it.state}`} data-path={it.path}>
                  <div className="review-item-row">
                    <button className="ghost review-item-name" aria-expanded={open === it.path} onClick={() => setOpen(open === it.path ? null : it.path)} title={it.path}>
                      {fileName(it.path)}
                    </button>
                    <span className={`pill small review-status ${it.status}`}>{STATUS[it.status]}</span>
                    {it.untracked && <span className="pill small warn" title="Written outside the agent's calls">Outside the agent</span>}
                    <span className="spacer" />
                    {it.state === "kept" && <span className="pill small ok">Kept</span>}
                    {it.state === "reverted" ? (
                      <>
                        <span className="pill small">Reverted</span>
                        {it.undo && <button className="ghost small-button" disabled={busy} onClick={() => undo(it.path)}>Undo revert</button>}
                      </>
                    ) : (
                      <>
                        {it.state === "pending" && <button className="small-button" disabled={busy} onClick={() => keep([it.path])}>Keep</button>}
                        {!it.conflict && <button className="small-button" disabled={busy} onClick={() => revert([it.path])}>Revert</button>}
                      </>
                    )}
                  </div>
                  <div className="review-item-path dim small mono">{it.path}</div>
                  {it.conflict && it.state !== "reverted" && (
                    <div className="banner warn small review-conflict" role="alert">
                      You edited this file after the agent, so Revert left it alone.
                      {confirming === it.path ? (
                        <>
                          <button className="danger-button small-button" disabled={busy} onClick={() => revert([it.path], true)}>Revert and lose my edits</button>
                          <button className="ghost small-button" onClick={() => setConfirming(null)}>Keep my edits</button>
                        </>
                      ) : (
                        <button className="small-button" disabled={busy} onClick={() => setConfirming(it.path)}>Revert anyway</button>
                      )}
                    </div>
                  )}
                  {open === it.path && sessionId && <ItemDiff sessionId={sessionId} reviewId={review.id} item={it} />}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {review.dirty && review.dirty.length > 0 && (
        <div className="small dim">Unsaved in the editor, so not recorded: {review.dirty.join(", ")}</div>
      )}
      {note && <div className="banner warn small">{note}</div>}
      {error && <div className="banner bad small">{error}</div>}
    </div>
  );
}

/** An item's diff, read when it is opened. */
export function ItemDiff({ sessionId, reviewId, item }: { sessionId: string; reviewId: string; item: ReviewItem }) {
  const [diff, setDiff] = useState<{ change: CheckpointChange; before?: string; after?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.reviewDiff(sessionId, reviewId, item.path).then((d) => live && setDiff(d), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [sessionId, reviewId, item.path]);
  if (error) return <div className="banner bad small">{error}</div>;
  if (!diff) return <div className="dim small">Reading the diff.</div>;
  const c = diff.change;
  return (
    <div className="review-diff">
      {c.diff !== undefined && <DiffView lines={unifiedLines(c.diff)} label={`Diff of ${item.path}`} />}
      {c.blueprintDiff && <BlueprintDiff diff={c.blueprintDiff} />}
      {item.visual && (
        <div className="review-pictures">
          <figure>
            {diff.before ? <img src={api.reviewImageUrl(diff.before)} alt={`${fileName(item.path)} before the turn`} /> : <div className="review-nopicture dim small">No picture from before this turn.</div>}
            <figcaption className="small dim">Before</figcaption>
          </figure>
          <figure>
            {diff.after ? <img src={api.reviewImageUrl(diff.after)} alt={`${fileName(item.path)} after the turn`} /> : <div className="review-nopicture dim small">No picture.</div>}
            <figcaption className="small dim">After</figcaption>
          </figure>
        </div>
      )}
      {c.diff === undefined && !c.blueprintDiff && !item.visual && (
        <div className="dim small">{c.large ? "A large file: no diff is kept for it." : "A binary file: there is no text diff."}</div>
      )}
    </div>
  );
}

/** blueprint(diff)'s answer as nested lines: each key, and its value or its children. */
export function BlueprintDiff({ diff }: { diff: Record<string, unknown> }) {
  const lines: Array<{ depth: number; text: string }> = [];
  const walk = (v: unknown, depth: number, key?: string) => {
    if (lines.length > 400) return;
    const head = key === undefined ? "" : `${key}: `;
    if (v === null || typeof v !== "object") {
      lines.push({ depth, text: `${head}${String(v)}` });
      return;
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i + 1), x] as const) : Object.entries(v as Record<string, unknown>);
    if (key !== undefined) lines.push({ depth, text: key });
    if (entries.length === 0) lines.push({ depth: depth + 1, text: "none" });
    for (const [k, x] of entries) walk(x, key === undefined ? depth : depth + 1, k);
  };
  walk(diff, 0);
  return (
    <ul className="blueprint-diff small mono" aria-label="Blueprint diff">
      {lines.map((l, i) => <li key={i} style={{ paddingLeft: `${l.depth}em` }}>{l.text}</li>)}
    </ul>
  );
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * The session's switch and its checkpoint timeline, newest first. Restore to
 * here puts every recorded file back to that point; every restore is a mark of
 * its own with Undo.
 */
export function ReviewPanel({ sessionId, review, timeline, onChanged }: {
  sessionId: string;
  /** The session's switch, null for the Settings default. */
  review: boolean | null;
  timeline: TimelineMark[];
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; retry?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.reviewStatus().then(setStatus, () => setStatus({ available: false, reason: "This Studio agent cannot review turns.", default: false }));
  }, []);
  const on = typeof review === "boolean" ? review : !!status?.default;

  const run = (call: () => Promise<{ outcome?: RestoreOutcome }>, retry?: () => void) => {
    setBusy(true);
    setError(null);
    setNote(null);
    call().then((r) => {
      const text = r.outcome ? outcomeNote(r.outcome) : null;
      setNote(text ? { text, ...(r.outcome?.conflicts.length && retry ? { retry } : {}) } : null);
      onChanged();
    }, (e: Error) => setError(e.message)).finally(() => {
      setBusy(false);
      setConfirming(null);
    });
  };
  const restore = (m: TimelineMark, force = false) => run(() => api.timelineRestore(sessionId, m.checkpoint, force), force ? undefined : () => restore(m, true));
  const undo = (m: TimelineMark) => run(() => api.timelineUndo(sessionId, m.checkpoint));
  const toggle = (next: boolean) => run(async () => {
    await api.setSessionReview(sessionId, next === status?.default ? null : next);
    return {};
  });

  const marks = [...timeline].reverse();
  return (
    <div className="review-panel stack">
      {status && !status.available ? (
        <div className="banner warn small">{status.reason}</div>
      ) : (
        <label className="row toggle">
          <input type="checkbox" checked={on} disabled={busy || !status} onChange={(e) => toggle(e.target.checked)} />
          <span>Review this session's turns <span className="dim small">A checkpoint before and after each turn, and a card to keep or revert its changes.{review === null ? " Following Settings." : ""}</span></span>
        </label>
      )}
      {note && (
        <div className="banner warn small">
          {note.text}
          {note.retry && <button className="small-button" disabled={busy} onClick={note.retry}>Restore those too</button>}
        </div>
      )}
      {error && <div className="banner bad small">{error}</div>}
      {marks.length === 0 ? (
        <p className="dim small">No checkpoints in this session yet.</p>
      ) : (
        <ol className="timeline" aria-label="Checkpoint timeline">
          {marks.map((m) => (
            <li key={`${m.kind}-${m.checkpoint}`} className={`timeline-mark ${m.kind} ${m.undone ? "undone" : ""}`}>
              <span className="timeline-dot" aria-hidden="true" />
              <span className="timeline-label">{m.label}</span>
              <span className="dim small">{m.kind === "attempt" ? "Playtest attempt" : m.kind === "restore" ? (m.undone ? "Restore, undone" : "Restore") : "Turn"} {when(m.at)}</span>
              <span className="spacer" />
              {m.kind === "restore" ? (
                !m.undone && m.undo && <button className="ghost small-button" disabled={busy} onClick={() => undo(m)}>Undo</button>
              ) : confirming === m.checkpoint ? (
                <>
                  <button className="primary small-button" disabled={busy} onClick={() => restore(m)}>Restore every file</button>
                  <button className="ghost small-button" onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <button className="small-button" disabled={busy} onClick={() => setConfirming(m.checkpoint)}>Restore to here</button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
