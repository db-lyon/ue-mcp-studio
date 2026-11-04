import { useEffect, useMemo, useState } from "react";
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

/** How the changed files are shown: one flat list, or a tree of folders. */
export type ChangesView = "list" | "tree";
const VIEW_KEY = "studio.changes.view";

/** The viewer's last choice, kept in this browser; a list when storage is unavailable. */
export function readView(): ChangesView {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

function writeView(v: ChangesView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // Private windows and blocked storage: the choice lasts until the panel closes.
  }
}

/** A folder of the tree: its path from the root, its folders and files, and how many changes sit under it. */
export interface ChangeFolder {
  name: string;
  path: string;
  folders: ChangeFolder[];
  files: VcsChange[];
  count: number;
}

/**
 * The changes as a tree, folders first and each level sorted by name. A folder
 * whose only content is one folder is shown as one row ("Content/Props/Door"),
 * so a deep path does not cost a row per level.
 */
export function buildTree(changes: VcsChange[]): ChangeFolder {
  const root: ChangeFolder = { name: "", path: "", folders: [], files: [], count: 0 };
  for (const c of changes) {
    const parts = c.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let at = root;
    at.count++;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: at.path ? `${at.path}/${part}` : part, folders: [], files: [], count: 0 };
        at.folders.push(next);
      }
      next.count++;
      at = next;
    }
    at.files.push(c);
  }
  const tidy = (f: ChangeFolder): ChangeFolder => {
    let folder = f;
    while (folder !== root && folder.files.length === 0 && folder.folders.length === 1) {
      const only = folder.folders[0];
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    const folders = folder.folders.map(tidy).sort((a, b) => a.name.localeCompare(b.name));
    const files = [...folder.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    return { ...folder, folders, files };
  };
  return tidy(root);
}

/** Every folder's path, for Collapse all. */
export function folderPaths(f: ChangeFolder): string[] {
  return f.folders.flatMap((c) => [c.path, ...folderPaths(c)]);
}

type TreeRow = { kind: "folder"; name: string; path: string; count: number; depth: number } | { kind: "file"; change: VcsChange; depth: number };

/** The rows a tree shows: a collapsed folder hides what is under it. */
export function treeRows(f: ChangeFolder, collapsed: Set<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const c of f.folders) {
    rows.push({ kind: "folder", name: c.name, path: c.path, count: c.count, depth });
    if (!collapsed.has(c.path)) rows.push(...treeRows(c, collapsed, depth + 1));
  }
  for (const file of f.files) rows.push({ kind: "file", change: file, depth });
  return rows;
}

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
  const [view, setView] = useState<ChangesView>(readView);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildTree(changes ?? []), [changes]);
  const folders = useMemo(() => folderPaths(tree), [tree]);
  const pickView = (v: ChangesView) => {
    setView(v);
    writeView(v);
  };
  const toggle = (p: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

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
        {changes?.length !== 0 && (
          <div className="changes-toolbar row">
            <div className="seg changes-view" role="group" aria-label="Show changes as">
              <button className={view === "list" ? "on" : ""} aria-pressed={view === "list"} onClick={() => pickView("list")}>List</button>
              <button className={view === "tree" ? "on" : ""} aria-pressed={view === "tree"} onClick={() => pickView("tree")}>Tree</button>
            </div>
            {view === "tree" && folders.length > 0 && (
              <>
                <button className="ghost small-button" onClick={() => setCollapsed(new Set())}>Expand all</button>
                <button className="ghost small-button" onClick={() => setCollapsed(new Set(folders))}>Collapse all</button>
              </>
            )}
          </div>
        )}
        {changes && changes.length > 0 && (
          <div className="changes-body">
            <ul className={`changes-list ${view === "tree" ? "tree" : ""}`}>
              {view === "list"
                ? changes.map((c) => (
                    <li key={c.path}>
                      <button className={`change-row ${c.path === picked ? "current" : ""}`} onClick={() => setPicked(c.path)} title={c.path}>
                        <span className={`change-status s-${c.status}`} title={c.status}>{LETTER[c.status]}</span>
                        <span className="change-name">{baseName(c.path)}</span>
                        <span className="change-dir dim">{dirName(c.path)}</span>
                      </button>
                    </li>
                  ))
                : treeRows(tree, collapsed).map((r) =>
                    r.kind === "folder" ? (
                      <li key={`d:${r.path}`}>
                        <button className="change-row change-folder" style={{ paddingLeft: 8 + r.depth * 14 }} aria-expanded={!collapsed.has(r.path)} onClick={() => toggle(r.path)} title={r.path}>
                          <span className="change-chevron" aria-hidden="true">{collapsed.has(r.path) ? "▸" : "▾"}</span>
                          <span className="change-name">{r.name}</span>
                          <span className="change-count dim">{r.count}</span>
                        </button>
                      </li>
                    ) : (
                      <li key={r.change.path}>
                        <button className={`change-row ${r.change.path === picked ? "current" : ""}`} style={{ paddingLeft: 8 + r.depth * 14 }} onClick={() => setPicked(r.change.path)} title={r.change.path}>
                          <span className={`change-status s-${r.change.status}`} title={r.change.status}>{LETTER[r.change.status]}</span>
                          <span className="change-name">{baseName(r.change.path)}</span>
                        </button>
                      </li>
                    ),
                  )}
              {truncated && <li className="dim small">More files changed than are listed.</li>}
            </ul>
            <div className="changes-diff">
              {picked && <div className="dim small change-file">{picked}</div>}
              {picked && !diff && <p className="muted">Loading</p>}
              {diff?.reason && <p className="muted">{diff.reason}</p>}
              {diff?.diff && (
                <pre className="diff">
                  {diff.diff.split("\n").map((l, i) => <GitDiffLine key={i} line={l} />)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The file header lines of a git diff, cut to one line: their paths repeat what the panel already names. */
const GIT_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) )/;

/**
 * One line of a git diff. A header or hunk line stays one line, cut with an ellipsis; a change
 * or context line is its sign in a gutter and its text beside it, so a wrapped line continues
 * under its text.
 */
export function GitDiffLine({ line }: { line: string }) {
  if (GIT_HEADER.test(line)) return <span className="meta" title={line}>{line}{"\n"}</span>;
  if (line.startsWith("@@")) return <span className="hunk" title={line}>{line}{"\n"}</span>;
  const op = line[0] === "+" || line[0] === "-" || line[0] === " " ? line[0] : "";
  return (
    <span className={`diff-line ${op === "+" ? "add" : op === "-" ? "del" : ""}`}>
      <span className="diff-op">{op}</span>
      <span className="diff-text">{(op ? line.slice(1) : line) + "\n"}</span>
    </span>
  );
}
