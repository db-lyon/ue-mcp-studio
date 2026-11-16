/**
 * What's new: the release notes of each part Studio keeps current (Studio,
 * the editor plugin, the bridge plugin and ue-mcp), for the versions the last
 * update brought and any update waiting, on the user's channel.
 *
 * Each part's notes are its GitHub releases, the same repositories the
 * updater reads its manifests from. They are cached in the project's data
 * folder for an hour, and a cached copy answers when GitHub cannot.
 *
 * "The last update" is seen rather than told: every read compares each
 * installed version with the one recorded, and a change moves the recorded
 * one to `previous`. So the notes cover previous (exclusive) to installed
 * (inclusive), whichever way the part was updated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { WHATS_NEW_PARTS, isNewer, type WhatsNew, type WhatsNewComponent, type WhatsNewEntry, type WhatsNewPart } from "@ue-mcp-studio/shared";

export const WHATS_NEW_REPOS: Record<WhatsNewPart, string> = {
  studio: "db-lyon/ue-mcp-studio",
  plugin: "db-lyon/ue-mcp-studio-plugin",
  // The bridge plugin is released with ue-mcp, under the same version.
  bridge: "db-lyon/ue-mcp",
  ueMcp: "db-lyon/ue-mcp",
};

export const WHATS_NEW_NAMES: Record<WhatsNewPart, string> = {
  studio: "Studio",
  plugin: "Editor plugin (UE_MCP_Studio)",
  bridge: "Bridge plugin (UE_MCP_Bridge)",
  ueMcp: "ue-mcp",
};

/** How long a repository's releases are kept before GitHub is asked again. */
export const NOTES_TTL_MS = 3600_000;
/** The most releases one part lists; the rest are counted in `more`. */
export const MAX_ENTRIES = 20;

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export interface Release {
  version: string;
  prerelease: boolean;
  body: string;
  url: string;
  publishedAt: string | null;
}

export interface VersionRecord {
  current: string | null;
  previous: string | null;
}

export const VERSIONS_FILE = "whats-new-versions.json";
export const NOTES_CACHE_FILE = "release-notes.json";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    // A record that cannot be kept only makes the next read show less.
  }
}

/**
 * Compare each installed version with the one recorded; a part whose version
 * changed keeps the recorded one as `previous`. Returns the record after it.
 */
export function recordVersions(file: string, installed: Record<WhatsNewPart, string | null>): Record<WhatsNewPart, VersionRecord> {
  const old = readJson<Partial<Record<WhatsNewPart, VersionRecord>>>(file) ?? {};
  const next = {} as Record<WhatsNewPart, VersionRecord>;
  let changed = false;
  for (const part of WHATS_NEW_PARTS) {
    const was = old[part] ?? { current: null, previous: null };
    const now = installed[part];
    if (!now || now === was.current) {
      next[part] = { current: was.current ?? null, previous: was.previous ?? null };
      continue;
    }
    next[part] = { current: now, previous: was.current ?? null };
    changed = true;
  }
  if (changed) writeJson(file, next);
  return next;
}

/** A release body without the YAML front matter some release tooling leaves at its top. */
export function noteBody(body: string | null | undefined): string {
  return (body ?? "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

/**
 * The releases to show for one part, newest first: every release newer than
 * installed (marked available), then those after `previous` up to and
 * including installed, or installed alone when previous is unknown. Stable
 * leaves out prereleases other than the installed one.
 */
export function selectNotes(releases: Release[], o: { installed: string; previous: string | null; channel: "stable" | "beta"; max?: number }): { entries: WhatsNewEntry[]; more: number } {
  const max = o.max ?? MAX_ENTRIES;
  const since = o.previous && VERSION.test(o.previous) && isNewer(o.installed, o.previous) ? o.previous : null;
  const seen = new Set<string>();
  const picked: WhatsNewEntry[] = [];
  for (const r of releases) {
    if (!VERSION.test(r.version) || seen.has(r.version)) continue;
    if (o.channel === "stable" && (r.prerelease || r.version.includes("-")) && r.version !== o.installed) continue;
    const available = isNewer(r.version, o.installed);
    const brought = r.version === o.installed || (!!since && isNewer(r.version, since) && !isNewer(r.version, o.installed));
    if (!available && !brought) continue;
    seen.add(r.version);
    picked.push({ version: r.version, body: noteBody(r.body), url: r.url, publishedAt: r.publishedAt, available });
  }
  picked.sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
  return { entries: picked.slice(0, max), more: Math.max(0, picked.length - max) };
}

type Cache = Record<string, { at: number; releases: Release[] }>;

/** A repository's releases from GitHub, cached on disk; a stale copy answers when GitHub does not. */
export class ReleaseNotes {
  private inflight = new Map<string, Promise<{ releases: Release[]; error?: string }>>();

  constructor(
    private readonly cacheFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttl = NOTES_TTL_MS,
  ) {}

  releases(repo: string, refresh = false): Promise<{ releases: Release[]; error?: string }> {
    const cached = (readJson<Cache>(this.cacheFile) ?? {})[repo];
    if (!refresh && cached && this.now() - cached.at < this.ttl) return Promise.resolve({ releases: cached.releases });
    let p = this.inflight.get(repo);
    if (!p) {
      p = this.fetchRepo(repo).then(
        (releases) => {
          const cache = readJson<Cache>(this.cacheFile) ?? {};
          cache[repo] = { at: this.now(), releases };
          writeJson(this.cacheFile, cache);
          return { releases };
        },
        (e: unknown) => {
          const error = e instanceof Error ? e.message : String(e);
          return cached ? { releases: cached.releases } : { releases: [], error };
        },
      ).finally(() => this.inflight.delete(repo));
      this.inflight.set(repo, p);
    }
    return p;
  }

  private async fetchRepo(repo: string): Promise<Release[]> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub is limiting requests right now" : `GitHub answered ${res.status}`);
    const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; body?: string | null; html_url?: string; published_at?: string | null }>;
    if (!Array.isArray(list)) throw new Error("GitHub's answer was not a list of releases");
    return list
      .filter((r) => !r.draft && typeof r.tag_name === "string")
      .map((r) => ({
        version: r.tag_name!.replace(/^v/, ""),
        prerelease: !!r.prerelease,
        body: r.body ?? "",
        url: r.html_url ?? `https://github.com/${repo}/releases/tag/${r.tag_name}`,
        publishedAt: r.published_at ?? null,
      }));
  }
}

export interface WhatsNewDeps {
  dataDir: string;
  installed(): Record<WhatsNewPart, string | null>;
  channel(): "stable" | "beta";
  notes?: ReleaseNotes;
}

/** Every part's notes; a part with nothing installed is left out. */
export async function whatsNew(deps: WhatsNewDeps, refresh = false): Promise<WhatsNew> {
  const notes = deps.notes ?? new ReleaseNotes(path.join(deps.dataDir, NOTES_CACHE_FILE));
  const installed = deps.installed();
  const record = recordVersions(path.join(deps.dataDir, VERSIONS_FILE), installed);
  const channel = deps.channel();
  const components: WhatsNewComponent[] = [];
  await Promise.all(
    WHATS_NEW_PARTS.map(async (part) => {
      const version = installed[part];
      if (!version || !VERSION.test(version)) return;
      const repo = WHATS_NEW_REPOS[part];
      const r = await notes.releases(repo, refresh);
      const base: WhatsNewComponent = { part, name: WHATS_NEW_NAMES[part], installed: version, previous: record[part].previous, entries: [], more: 0, releasesUrl: `https://github.com/${repo}/releases` };
      components.push(r.error ? { ...base, error: r.error } : { ...base, ...selectNotes(r.releases, { installed: version, previous: record[part].previous, channel }) });
    }),
  );
  components.sort((a, b) => WHATS_NEW_PARTS.indexOf(a.part) - WHATS_NEW_PARTS.indexOf(b.part));
  return { channel, components };
}

/** GET /whats-new, ?refresh=1 to ask GitHub again. Also records the installed versions now, so an update is seen even if the dialog is never opened. */
export function registerWhatsNew(api: Pick<DaemonExtensionApi, "route">, deps: WhatsNewDeps): () => void {
  const notes = deps.notes ?? new ReleaseNotes(path.join(deps.dataDir, NOTES_CACHE_FILE));
  const record = () => {
    try {
      recordVersions(path.join(deps.dataDir, VERSIONS_FILE), deps.installed());
    } catch {
      // Recorded on the next read.
    }
  };
  record();
  api.route("GET", "/whats-new", async (req) => ({ body: await whatsNew({ ...deps, notes }, req.query.refresh === "1" || req.query.refresh === "true") }));
  return record;
}
