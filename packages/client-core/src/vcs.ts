/**
 * A project's source control as a client shows it: the one-line status, and
 * the changed files as a flat list or a tree of folders.
 */
import type { VcsChange, VcsStatus } from "@ue-mcp-studio/shared";

/** "main, 3 changed, 2 ahead": where the project stands in its source control. */
export function vcsLine(v: VcsStatus): string {
  const changed = v.changes === null ? "" : v.changes === 0 ? "clean" : `${v.changes} ${v.kind === "perforce" ? "opened" : "changed"}`;
  const sync = [v.ahead ? `${v.ahead} ahead` : "", v.behind ? `${v.behind} behind` : ""];
  return [v.branch ?? "no branch", changed, ...sync].filter(Boolean).join(", ");
}

export const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
export const dirName = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

export const VCS_LETTER: Record<VcsChange["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" };

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

export type TreeRow = { kind: "folder"; name: string; path: string; count: number; depth: number } | { kind: "file"; change: VcsChange; depth: number };

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
