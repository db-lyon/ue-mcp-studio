/**
 * Studio's update check as a client reads it: Studio, the editor plugin, the
 * bridge plugin and ue-mcp, what is newer, and an update run's steps. Shared
 * by client-web's Updates card and the mobile app's; an update run's steps
 * are in update-run.ts.
 */
import { FAB_LIBRARY_URL, isNewer, type StudioPluginUpdate } from "@ue-mcp-studio/shared";
import { obj } from "./normalize.js";

/** GET /v1/ext/studio/updates. */
export interface StudioUpdates {
  /** stable follows each latest release; beta also takes prereleases. */
  channel?: "stable" | "beta";
  studio: { installed: string; latest: string | null; available: boolean };
  plugin: StudioPluginUpdate;
  /** The oldest ue-mcp the latest Studio runs on. */
  ueMcpMin?: string;
  /** The step the agent is running now (the plugin swap). */
  running?: string;
  /** The last background step (the Studio update, the restart) that failed, kept across the daemon it stopped. */
  failure?: { step: "studio" | "restart"; error: string; at: string } | null;
  error?: string;
}

/**
 * GET /v1/update on the daemon. target is the release the project's bridge
 * plugin moves to, compared against installed.version, not against server.
 */
export interface UeMcpUpdate {
  installed: { version: string | null };
  /** The ue-mcp package the daemon runs. */
  server: string;
  latest: string | null;
  target: string | null;
  binaries: { available: boolean; file: string } | null;
  error?: string;
}

export interface Updates {
  studio: StudioUpdates | null;
  ueMcp: UeMcpUpdate | null;
}

/** What the card says about a background step that failed, or null when the last one did not. */
export function updateFailureLine(s: StudioUpdates | null | undefined): string | null {
  const f = s?.failure;
  if (!f?.error) return null;
  return `${f.step === "studio" ? "The last Studio update failed" : "The last ue-mcp restart failed"}: ${f.error}`;
}

/** Update installs the plugin itself: never for a Fab install, which the Fab Library updates. */
export const pluginStep = (s: StudioUpdates | null | undefined): boolean => !!s?.plugin.available && s.plugin.source !== "fab";

/** A Fab install with a newer plugin out: where to send the user. */
export function fabUpdate(s: StudioUpdates | null | undefined): { version: string | null; url: string } | null {
  if (s?.plugin.source !== "fab" || !(s.plugin.newer || s.plugin.required)) return null;
  return { version: s.plugin.newer ? s.plugin.latest : null, url: s.plugin.fabUrl || FAB_LIBRARY_URL };
}

/**
 * The ue-mcp check with its target raised to the latest Studio's floor while
 * the daemon runs below it, whatever the channel: Studio never installs ahead
 * of the ue-mcp it needs.
 */
export function withFloor(u: UeMcpUpdate | null, min: string | undefined): UeMcpUpdate | null {
  if (!u || !min || !isNewer(min, u.server)) return u;
  return { ...u, target: u.target && !isNewer(min, u.target) ? u.target : min };
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Studio's update check from any agent, each part it does not report as nothing installed and nothing newer. */
export function studioUpdatesOf(raw: unknown): StudioUpdates | null {
  if (!raw || typeof raw !== "object") return null;
  const u = obj(raw);
  const studio = obj(u.studio);
  const plugin = obj(u.plugin);
  return {
    ...u,
    channel: u.channel === "beta" ? "beta" : "stable",
    studio: { installed: text(studio.installed) ?? "?", latest: text(studio.latest), available: studio.available === true },
    plugin: {
      ...plugin,
      installed: text(plugin.installed),
      latest: text(plugin.latest),
      available: plugin.available === true,
      location: plugin.location === "project" || plugin.location === "engine" ? plugin.location : "none",
      engine: text(plugin.engine),
    } as StudioPluginUpdate,
    ueMcpMin: text(u.ueMcpMin) ?? undefined,
  } as StudioUpdates;
}

/** The daemon's update check from any ue-mcp. */
export function ueMcpUpdateOf(raw: unknown): UeMcpUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const u = obj(raw);
  const binaries = obj(u.binaries);
  return {
    ...u,
    installed: { version: text(obj(u.installed).version) },
    server: text(u.server) ?? "?",
    latest: text(u.latest),
    target: text(u.target),
    binaries: typeof binaries.file === "string" ? { available: binaries.available === true, file: binaries.file } : null,
  } as UeMcpUpdate;
}

/** Both checks, given a GET that answers a route's JSON or null. The bridge check follows Studio's channel. */
export async function readUpdatesWith(get: (path: string) => Promise<unknown>): Promise<Updates> {
  const studio = studioUpdatesOf(await get("/v1/ext/studio/updates"));
  const ueMcp = withFloor(ueMcpUpdateOf(await get(`/v1/update?channel=${studio?.channel === "beta" ? "beta" : "latest"}`)), studio?.ueMcpMin);
  return { studio, ueMcp };
}

/** How many parts have an update waiting. */
export function waiting(u: Updates): number {
  return (u.studio?.studio.available ? 1 : 0) + (pluginStep(u.studio) ? 1 : 0) + (u.ueMcp?.target ? 1 : 0);
}

/** The bridge update restarts the daemon onto the target only when it runs another version. */
export const daemonMoves = (u: UeMcpUpdate | null | undefined): boolean => !!u?.target && u.server !== u.target;

/** The steps one Update runs, in order: the bridge plugin, then the editor plugin, then Studio, which restarts ue-mcp. */
export function updateSteps(u: Updates): Array<"ueMcp" | "plugin" | "studio"> {
  const steps: Array<"ueMcp" | "plugin" | "studio"> = [];
  if (u.ueMcp?.target) steps.push("ueMcp");
  if (pluginStep(u.studio)) steps.push("plugin");
  if (u.studio?.studio.available) steps.push("studio");
  return steps;
}

/** "Ready to install: the bridge plugin 1.4.3 and the editor plugin 0.1.0-beta.9." */
export function readyLine(u: Updates): string {
  const parts: string[] = [];
  if (u.ueMcp?.target) parts.push(`the bridge plugin ${u.ueMcp.target}`);
  if (pluginStep(u.studio)) parts.push(`the editor plugin ${u.studio?.plugin.latest}`);
  if (u.studio?.studio.available) parts.push(`Studio ${u.studio.studio.latest}`);
  if (!parts.length) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Ready to install: ${list}.`;
}

/** The Details rows: each part, what is installed, and what it moves to. */
export function updateRows(u: Updates): Array<[string, string | null, string | null, boolean]> {
  return [
    ["Studio", u.studio?.studio.installed ?? null, u.studio?.studio.latest ?? null, !!u.studio?.studio.available],
    ["Editor plugin", u.studio?.plugin.installed ?? null, u.studio?.plugin.latest ?? null, !!(u.studio?.plugin.available || u.studio?.plugin.newer)],
    ["Bridge plugin", u.ueMcp?.installed.version ?? null, u.ueMcp?.target ?? null, !!u.ueMcp?.target],
    ["ue-mcp", u.ueMcp?.server ?? null, u.ueMcp?.target ?? null, daemonMoves(u.ueMcp)],
  ];
}
