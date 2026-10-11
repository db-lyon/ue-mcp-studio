import { useEffect, useState } from "react";
import type { VcsStatus } from "@ue-mcp-studio/shared";
import { api } from "../api";

/** "main, 3 changed, 2 ahead": where the project stands in its source control. */
export function vcsLine(v: VcsStatus): string {
  const changed = v.changes === null ? "" : v.changes === 0 ? "clean" : `${v.changes} ${v.kind === "perforce" ? "opened" : "changed"}`;
  const sync = [v.ahead ? `${v.ahead} ahead` : "", v.behind ? `${v.behind} behind` : ""];
  return [v.branch ?? "no branch", changed, ...sync].filter(Boolean).join(", ");
}

/**
 * The project's source control in the top bar: the branch (or stream) and its
 * changes. Read when the panel opens, every half minute, and whenever a
 * session changes, since a turn may have changed files.
 */
export function VcsChip({ events }: { events: unknown[] }) {
  const [vcs, setVcs] = useState<VcsStatus | null>(null);
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
    <span className={`chip vcs ${dirty ? "dirty" : ""}`} title={`${vcs.name} at ${vcs.root}${vcs.detail ? `, ${vcs.detail}` : ""}`}>
      <span className="vcs-kind">{vcs.name}</span> {vcsLine(vcs)}
    </span>
  );
}
