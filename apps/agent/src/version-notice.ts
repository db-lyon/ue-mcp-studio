/**
 * Studio versions install side by side and each project loads its own
 * (ue-mcp#1619). When another project installed a newer Studio than this one
 * uses, the panel says so and offers to move this project to it or keep the
 * version it has. Nothing moves on its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { isNewer } from "@ue-mcp-studio/shared";

/** What the daemon reports when it has feature "extension.versions". */
export interface ExtensionVersions {
  loaded: string;
  recorded: string | null;
  installed: string[];
}

export interface VersionNotice {
  /** The newest Studio installed on this machine. */
  installed: string;
  /** The Studio this project uses. */
  current: string;
}

/** The notice to show, or null: nothing newer is installed, or the user kept this version past it. */
export function versionNotice(v: ExtensionVersions | null, kept: string | null): VersionNotice | null {
  if (!v) return null;
  const newest = v.installed.reduce<string | null>((a, b) => (!a || isNewer(b, a) ? b : a), null);
  if (!newest || !isNewer(newest, v.loaded)) return null;
  if (kept && !isNewer(newest, kept)) return null;
  return { installed: newest, current: v.loaded };
}

/** The versions call, on a daemon that has it. */
export function readVersions(api: DaemonExtensionApi): ExtensionVersions | null {
  const fn = (api as { versions?: () => ExtensionVersions }).versions;
  return typeof fn === "function" ? fn() : null;
}

const keptFile = (dataDir: string) => path.join(dataDir, "version-notice.json");

export function readKept(dataDir: string): string | null {
  try {
    const k = (JSON.parse(fs.readFileSync(keptFile(dataDir), "utf-8")) as { kept?: unknown }).kept;
    return typeof k === "string" ? k : null;
  } catch {
    return null;
  }
}

/** Keep this version until something newer than `version` is installed. */
export function writeKept(dataDir: string, version: string): void {
  fs.writeFileSync(keptFile(dataDir), JSON.stringify({ kept: version }));
}

/**
 * GET /version-notice, POST /version-notice/keep { version }, and
 * POST /version-notice/update { version }, which runs the Studio update step
 * on that installed version.
 */
export function registerVersionNotice(api: DaemonExtensionApi, update: (version: string) => Promise<{ status: number; body: unknown }>): void {
  api.route("GET", "/version-notice", () => ({ body: { notice: versionNotice(readVersions(api), readKept(api.dataDir)) } }));
  const versionOf = (body: unknown): string | null => {
    const v = (body as { version?: unknown } | undefined)?.version;
    return typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v) ? v : null;
  };
  api.route("POST", "/version-notice/keep", (req) => {
    const v = versionOf(req.body);
    if (!v) return { status: 400, body: { error: "body must be { version }" } };
    writeKept(api.dataDir, v);
    return { body: { notice: versionNotice(readVersions(api), v) } };
  });
  api.route("POST", "/version-notice/update", async (req) => {
    const v = versionOf(req.body);
    if (!v) return { status: 400, body: { error: "body must be { version }" } };
    if (!readVersions(api)?.installed.includes(v)) return { status: 404, body: { error: `Studio ${v} is not installed on this machine` } };
    return update(v);
  });
}
