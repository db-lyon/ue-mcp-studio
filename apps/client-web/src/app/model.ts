/**
 * What the UE-MCP app shows, worked out from ue-mcp's machine report and the
 * host's live daemon reads. Pure: the screens only draw it.
 */
import { isNewer } from "@ue-mcp-studio/shared";
import type { AppUpdate, Channel, Live, Newest } from "./native";

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

/**
 * What tells a project apart from others of the same name: the fewest parent
 * folders that differ, such as "Work" for C:\Work\ue_mcp beside
 * C:\Games\ue_mcp. Empty when the name is the only one.
 */
export function nameHint(p: MachineProject, all: MachineProject[]): string {
  const same = all.filter((x) => x.key !== p.key && x.name.toLowerCase() === p.name.toLowerCase());
  if (!same.length) return "";
  const parents = (dir: string) => dir.split(/[\\/]+/).filter(Boolean).slice(0, -1).reverse();
  const mine = parents(p.dir);
  for (let n = 1; n <= mine.length; n++) {
    const tail = mine.slice(0, n).join("/").toLowerCase();
    if (same.every((x) => parents(x.dir).slice(0, n).join("/").toLowerCase() !== tail)) return mine.slice(0, n).reverse().join("\\");
  }
  return mine.slice().reverse().join("\\");
}

/** The Studio editor plugin's version in the project, or null. */
export function pluginOf(p: MachineProject): string | null {
  return p.plugins.find((x) => x.name === STUDIO_PLUGIN)?.version ?? null;
}

/** A project's versions: ue-mcp (the daemon's, else the one the app runs for it), the bridge plugin, Studio and its editor plugin. */
export function versionsOf(p: MachineProject, live: Record<string, Live> | null, ueMcp: string | null): Array<{ label: string; version: string }> {
  const d = running(p, live);
  const s = studioOf(p);
  const out: Array<{ label: string; version: string }> = [];
  const runs = d?.version ?? (p.ueMcp.setUp ? ueMcp : null);
  if (runs) out.push({ label: "ue-mcp", version: runs });
  if (p.ueMcp.bridge) out.push({ label: "Bridge", version: p.ueMcp.bridge.version });
  if (s.version) out.push({ label: "Studio", version: s.version });
  const plugin = pluginOf(p);
  if (plugin) out.push({ label: "Editor plugin", version: plugin });
  return out;
}

/** One part of a project against the newest on the channel. */
export interface PartUpdate {
  part: "bridge" | "studio" | "plugin";
  name: string;
  installed: string | null;
  latest: string | null;
  available: boolean;
  /** What updating it installs, and where. */
  installs: string;
  /** Why the newest could not be read. */
  error?: string;
}

export interface ProjectUpdates {
  parts: PartUpdate[];
  /** The parts with a newer release. */
  waiting: PartUpdate[];
  /** How Update runs: in the project's Studio, by ue-mcp update --apply-only without it, or nothing to run. */
  via: "studio" | "ue-mcp" | null;
  /** Why a part could not be checked, or null when every part was. */
  unchecked: string | null;
  pill: string;
  tone: "ok" | "warn" | "dim";
  line: string;
}

const spaced = (s: string) => s.replace(/ {2,}/g, " ");

/**
 * A project's updates from what it has installed (ue-mcp projects --json)
 * against the newest on the channel (the host's newest), so no daemon has to
 * run. Null while the newest is still being read.
 */
export function updatesOf(p: MachineProject, newest: Newest | null): ProjectUpdates | null {
  if (!newest) return null;
  const s = studioOf(p);
  const parts: PartUpdate[] = [];
  const part = (o: Omit<PartUpdate, "available">): PartUpdate => ({ ...o, available: !!o.installed && !!o.latest && isNewer(o.latest, o.installed) });
  if (p.ueMcp.setUp) {
    const v = p.ueMcp.bridge?.version ?? null;
    parts.push(part({
      part: "bridge", name: "Bridge plugin", installed: v, latest: newest.ueMcp ?? null, error: newest.errors?.ueMcp,
      installs: spaced(`The bridge plugin from ue-mcp ${newest.ueMcp ?? ""}, into ${p.name}'s Plugins folder in place of ${v ?? "the one there"}.`),
    }));
  }
  if (s.installed) {
    parts.push(part({
      part: "studio", name: "Studio", installed: s.version, latest: newest.studio ?? null, error: newest.errors?.studio,
      installs: spaced(`Studio ${newest.studio ?? ""}, the panel and its agent. The project's ue-mcp restarts to load it.`),
    }));
    if (s.plugin) {
      parts.push(part({
        part: "plugin", name: "Editor plugin", installed: s.plugin === "?" ? null : s.plugin, latest: newest.plugin ?? null, error: newest.errors?.plugin,
        installs: spaced(`The UE_MCP_Studio editor plugin ${newest.plugin ?? ""} for UE ${p.engine.version ?? "?"}, swapped into the project's Plugins folder. Unreal restarts if it is open.`),
      }));
    }
  }
  const waiting = parts.filter((x) => x.available);
  const missing = parts.filter((x) => !x.latest);
  const unchecked = missing.length ? missing.map((x) => x.error).find(Boolean) ?? `the newest ${missing[0].name.toLowerCase()} is not known.` : null;
  const via = !waiting.length ? null : s.installed ? "studio" : "ue-mcp";
  const names = waiting.map((x) => `${x.part === "studio" ? "Studio" : `the ${x.name.toLowerCase()}`} ${x.latest}`);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  if (!parts.length) return { parts, waiting, via, unchecked: null, pill: "", tone: "dim", line: "Not set up for ue-mcp, so there is nothing to update." };
  if (waiting.length) return { parts, waiting, via, unchecked, pill: "Update available", tone: "warn", line: `Ready to install: ${joined}.` };
  if (unchecked) return { parts, waiting, via, unchecked, pill: "Not checked", tone: "warn", line: `Could not check: ${unchecked}` };
  return { parts, waiting, via, unchecked, pill: "Up to date", tone: "ok", line: `Up to date on ${channelLabel(newest.channel ?? "stable")}.` };
}

/** What Update does for this project, said before it runs. */
export function updateHow(u: ProjectUpdates, p: MachineProject): string {
  if (u.via === "studio") return `Opens ${p.name}'s Studio on its Updates card, which installs each part in turn.`;
  if (u.via === "ue-mcp") return p.editor.running ? `Close ${p.name} in Unreal first: the bridge plugin cannot be replaced while the editor has it loaded.` : `Runs ue-mcp update --apply-only for ${p.name}.`;
  return "";
}

/** "Stable" or "Beta", as Studio's Updates card names the channel. */
export function channelLabel(c: Channel): string {
  return c === "beta" ? "Beta" : "Stable";
}

/** The UE-MCP row's line: the version here, the channel and its newest release, or why it was not checked. */
export function appUpdateLine(version: string, u: AppUpdate | null, channel: Channel, installing: boolean): string {
  const on = channelLabel(u?.channel ?? channel);
  if (installing) return "Installing. UE-MCP restarts when it is done.";
  if (!u) return `UE-MCP ${version}, on ${on}.`;
  if (!u.ok) return `Could not check ${on}: ${u.error ?? "no answer"}`;
  if (u.newer) return `UE-MCP ${u.version} is ready to install from ${on}. You have ${version}.`;
  if (!u.version || u.version === version) return `UE-MCP ${version}, the newest on ${on}.`;
  return `UE-MCP ${version}. The newest on ${on} is ${u.version}.`;
}
