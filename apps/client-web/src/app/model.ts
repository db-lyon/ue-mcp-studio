/**
 * What the UE-MCP app shows, worked out from ue-mcp's machine report and the
 * host's live daemon reads. Pure: the screens only draw it.
 */
import type { Live } from "./native";

/** ue-mcp's MachineReport, version 1 (`ue-mcp projects --json`, exported by ue-mcp/daemon). */
export interface MachineReport {
  version: 1;
  ueMcp: string;
  daemonDir: string;
  projects: MachineProject[];
  daemons: MachineDaemon[];
}

export interface MachineDaemon {
  key: string;
  projectRoot: string;
  uproject: string | null;
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  discovery: string;
  log: string;
}

export interface MachineProject {
  name: string;
  uproject: string;
  dir: string;
  key: string;
  source: "recent" | "added";
  lastOpened: string | null;
  engine: { association: string | null; version: string | null };
  editor: { running: boolean; pids: number[] };
  ueMcp: { setUp: boolean; bridge: { version: string; kind: "source" | "binary" | null } | null; config: boolean };
  extensions: Record<string, string>;
  plugins: Array<{ name: string; version: string | null }>;
  daemon: { discovery: string; log: string; running: MachineDaemon | null };
}

export const STUDIO_PLUGIN = "UE_MCP_Studio";

/** Studio in a project: the version it records, and the editor plugin's. */
export function studioOf(p: MachineProject): { installed: boolean; version: string | null; plugin: string | null } {
  const plugin = p.plugins.find((x) => x.name === STUDIO_PLUGIN);
  const version = p.extensions.studio ?? null;
  return { installed: !!version || !!plugin, version, plugin: plugin ? plugin.version ?? "?" : null };
}

/** Whether the project's daemon runs: the host's live read wins over the report's snapshot. */
export function running(p: MachineProject, live: Record<string, Live> | null): Live | null {
  if (live) return live[p.key] ?? null;
  const d = p.daemon.running;
  return d ? { pid: d.pid, port: d.port, version: d.version } : null;
}

export interface Chip {
  label: string;
  tone: "ok" | "warn" | "dim" | "accent";
  title?: string;
}

/** The project row's chips: ue-mcp, Studio, the daemon, the editor. */
export function chipsOf(p: MachineProject, live: Record<string, Live> | null): Chip[] {
  const s = studioOf(p);
  const d = running(p, live);
  const chips: Chip[] = [
    p.ueMcp.setUp
      ? { label: `ue-mcp ${p.ueMcp.bridge?.version ?? ""}`.trim(), tone: "ok", title: p.ueMcp.bridge?.kind === "source" ? "Bridge built from source" : "Bridge installed as prebuilt binaries" }
      : { label: "ue-mcp not set up", tone: "dim" },
    s.installed ? { label: `Studio ${s.version ?? s.plugin ?? ""}`.trim(), tone: "ok" } : { label: "No Studio", tone: "dim" },
  ];
  if (d) chips.push({ label: "Running", tone: "accent", title: `ue-mcp ${d.version}, pid ${d.pid}, port ${d.port}` });
  if (p.editor.running) chips.push({ label: "Editor open", tone: "warn" });
  return chips;
}

/** What a row offers, and why an action waits. */
/** `installing`: this project's install runs; `busy`: another project's does, and installs run one at a time. */
export function actionsOf(p: MachineProject, installing: boolean, busy: boolean): { openStudio: boolean; addStudio: boolean; addBlocked: string | null; launchBlocked: string | null } {
  const s = studioOf(p);
  return {
    openStudio: s.installed,
    addStudio: !s.installed,
    addBlocked: installing ? "Adding Studio." : busy ? "Another install is running." : p.editor.running ? `Close ${p.name} in Unreal first.` : null,
    launchBlocked: installing ? "Wait for the install to finish." : p.editor.running ? `${p.name} is open in Unreal.` : null,
  };
}

/** Projects that match a filter by name, folder or engine. */
export function filterProjects(projects: MachineProject[], query: string): MachineProject[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q) || (p.engine.version ?? "").includes(q));
}

/**
 * Daemons as the Daemons screen lists them: the report's live ones, each named
 * by its project, plus a listed project's daemon that started after the report
 * was read, from the host's live read.
 */
export function daemonRows(report: MachineReport, live: Record<string, Live> | null): Array<MachineDaemon & { name: string; listed: boolean }> {
  const byKey = new Map(report.projects.map((p) => [p.key, p]));
  const rows = report.daemons
    .filter((d) => !live || live[d.key])
    .map((d) => {
      const fromPath = d.uproject ? d.uproject.split(/[\\/]/).pop()!.replace(/\.uproject$/i, "") : d.projectRoot.split("/").pop() ?? d.projectRoot;
      const p = byKey.get(d.key);
      return { ...d, ...(live?.[d.key] ?? {}), name: p?.name ?? fromPath, listed: !!p };
    });
  for (const p of report.projects) {
    const l = live?.[p.key];
    if (!l || rows.some((r) => r.key === p.key)) continue;
    rows.push({ key: p.key, projectRoot: p.dir, uproject: p.uproject, pid: l.pid, port: l.port, version: l.version, startedAt: "", discovery: p.daemon.discovery, log: p.daemon.log, name: p.name, listed: true });
  }
  return rows;
}

/** "4m", "2h 05m", "3d 4h". */
export function uptime(startedAt: string, now = Date.now()): string {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The report's text parsed, or null when it is not one this app reads. */
export function parseReport(text: string | undefined): MachineReport | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text) as MachineReport;
    return r && r.version === 1 && Array.isArray(r.projects) && Array.isArray(r.daemons) ? r : null;
  } catch {
    return null;
  }
}

/** "Read at 14:05" for a cached report's time. */
export function readAt(iso: string | undefined): string {
  const t = iso ? new Date(iso) : null;
  return t && Number.isFinite(t.getTime()) ? t.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "earlier";
}
