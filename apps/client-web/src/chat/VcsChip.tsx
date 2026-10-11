import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { VcsChange, VcsStatus } from "@ue-mcp-studio/shared";
import { api } from "../api";

/** "main, 3 changed, 2 ahead": where the project stands in its source control. */
export function vcsLine(v: VcsStatus): string {
  const changed = v.changes === null ? "" : v.changes === 0 ? "clean" : `${v.changes} ${v.kind === "perforce" ? "opened" : "changed"}`;
  const sync = [v.ahead ? `${v.ahead} ahead` : "", v.behind ? `${v.behind} behind` : ""];
  return [v.branch ?? "no branch", changed, ...sync].filter(Boolean).join(", ");
}

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
const dirName = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

const LETTER: Record<VcsChange["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" };

/**
 * The project's source control in the top bar: the branch (or stream) and its
 * changes. Read when the panel opens, every half minute, and whenever a
 * session changes, since a turn may have changed files. Clicking it lists
 * the changes and shows a file's diff.
 */
export function VcsChip({ events }: { events: unknown[] }) {
  const [vcs, setVcs] = useState<VcsStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api.vcs().then((r) => setVcs(r.vcs), () => setVcs(null));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (events.length) void load();
  }, [events.length]);
  if (!vcs) return null;
  const dirty = (vcs.changes ?? 0) > 0;
  return (
    <>
      <button className={`chip vcs ${dirty ? "dirty" : ""}`} title={`${vcs.name} at ${vcs.root}${vcs.detail ? `, ${vcs.detail}` : ""}. Click to see the changes.`} onClick={() => setOpen(true)}>
        <span className="vcs-kind">{vcs.name}</span> {vcsLine(vcs)}
      </button>
      {/* Into the page body: the top bar's styles would otherwise make it the panel's frame. */}
      {open && createPortal(<ChangesPanel vcs={vcs} onClose={() => { setOpen(false); void load(); }} />, document.body)}
    </>
  );
}

/** The changed files, and the diff of the one picked. */
export function ChangesPanel({ vcs, onClose }: { vcs: VcsStatus; onClose: () => void }) {
  const [changes, setChanges] = useState<VcsChange[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ diff: string | null; reason?: string } | null>(null);

  useEffect(() => {
    api.vcsChanges().then((r) => {
      setChanges(r.changes);
      setTruncated(r.truncated);
      if (r.changes[0]) setPicked(r.changes[0].path);
    }, () => setChanges([]));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    if (!picked) return setDiff(null);
    setDiff(null);
    api.vcsDiff(picked).then(setDiff, (e: Error) => setDiff({ diff: null, reason: e.message }));
  }, [picked]);

  return (
    <div className="changes-backdrop" onClick={onClose}>
      <div className="changes-panel card" role="dialog" aria-label="Changes" onClick={(e) => e.stopPropagation()}>
        <div className="row changes-head">
          <h2>Changes</h2>
          <span className="dim small">{vcs.name}, {vcsLine(vcs)}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        {changes === null && <p className="muted">Loading</p>}
        {changes?.length === 0 && <p className="muted">No changes.</p>}
        {changes && changes.length > 0 && (
          <div className="changes-body">
            <ul className="changes-list">
              {changes.map((c) => (
                <li key={c.path}>
                  <button className={`change-row ${c.path === picked ? "current" : ""}`} onClick={() => setPicked(c.path)} title={c.path}>
                    <span className={`change-status s-${c.status}`} title={c.status}>{LETTER[c.status]}</span>
                    <span className="change-name">{baseName(c.path)}</span>
                    <span className="change-dir dim">{dirName(c.path)}</span>
                  </button>
                </li>
              ))}
              {truncated && <li className="dim small">More files changed than are listed.</li>}
            </ul>
            <div className="changes-diff">
              {picked && <div className="dim small change-file">{picked}</div>}
              {picked && !diff && <p className="muted">Loading</p>}
              {diff?.reason && <p className="muted">{diff.reason}</p>}
              {diff?.diff && (
                <pre className="diff">
                  {diff.diff.split("\n").map((l, i) => (
                    <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>
                  ))}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
