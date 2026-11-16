/**
 * What's new: the release notes of each part Studio keeps current (Studio,
 * the editor plugin, the bridge plugin and ue-mcp) for the releases newer
 * than the installed one on the user's channel: what Update would bring.
 *
 * Each part's notes are its GitHub releases, the same repositories the
 * updater reads its manifests from. They are cached in the project's data
 * folder for an hour, and a cached copy answers when GitHub cannot.
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
/** A cached list missing a version the caller needs is read again once it is this old. */
export const MISSING_RETRY_MS = 60_000;
/** GitHub's page size, and how many pages one read may take (other release tags share the list). */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
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
    // A cache that cannot be kept only means GitHub is asked again.
  }
}

/** A release body without the YAML front matter some release tooling leaves at its top. */
export function noteBody(body: string | null | undefined): string {
  return (body ?? "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

/**
 * The releases to show for one part, newest first: only those newer than the
 * installed one. Stable leaves out prereleases.
 */
export function selectNotes(releases: Release[], o: { installed: string; channel: "stable" | "beta"; max?: number }): { entries: WhatsNewEntry[]; more: number } {
  const max = o.max ?? MAX_ENTRIES;
  const seen = new Set<string>();
  const picked: WhatsNewEntry[] = [];
  for (const r of releases) {
    if (!VERSION.test(r.version) || seen.has(r.version)) continue;
    if (o.channel === "stable" && (r.prerelease || r.version.includes("-"))) continue;
    if (!isNewer(r.version, o.installed)) continue;
    seen.add(r.version);
    picked.push({ version: r.version, body: noteBody(r.body), url: r.url, publishedAt: r.publishedAt, available: true });
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

  /**
   * `need`: versions the caller looks for (the installed one, the previous one).
   * A cached list that lacks one was read before that release existed, so it is
   * read again once it is a minute old, whatever the hour says.
   */
  releases(repo: string, refresh = false, need: string[] = []): Promise<{ releases: Release[]; error?: string }> {
    const cached = (readJson<Cache>(this.cacheFile) ?? {})[repo];
    const age = cached ? this.now() - cached.at : Infinity;
    const complete = !!cached && need.every((v) => cached.releases.some((r) => r.version === v));
    if (!refresh && cached && age < this.ttl && (complete || age < MISSING_RETRY_MS)) return Promise.resolve({ releases: cached.releases });
    let p = this.inflight.get(repo);
    if (!p) {
      p = this.fetchRepo(repo, need).then(
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

  /** Up to MAX_PAGES pages, stopping once every needed version is in or GitHub has no more. */
  private async fetchRepo(repo: string, need: string[]): Promise<Release[]> {
    const out: Release[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { releases, full } = await this.fetchPage(repo, page);
      out.push(...releases);
      if (!full || need.every((v) => out.some((r) => r.version === v))) break;
    }
    return out;
  }

  private async fetchPage(repo: string, page: number): Promise<{ releases: Release[]; full: boolean }> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub is limiting requests right now" : `GitHub answered ${res.status}`);
    const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; body?: string | null; html_url?: string; published_at?: string | null }>;
    if (!Array.isArray(list)) throw new Error("GitHub's answer was not a list of releases");
    const releases = list
      .filter((r) => !r.draft && typeof r.tag_name === "string")
      .map((r) => ({
        version: r.tag_name!.replace(/^v/, ""),
        prerelease: !!r.prerelease,
        body: r.body ?? "",
        url: r.html_url ?? `https://github.com/${repo}/releases/tag/${r.tag_name}`,
        publishedAt: r.published_at ?? null,
      }));
    return { releases, full: list.length >= PAGE_SIZE };
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
  const channel = deps.channel();
  const components: WhatsNewComponent[] = [];
  // What each repository's list must hold: every installed version there (the bridge and ue-mcp share one).
  // A list without it was read before that release existed, so it cannot say what is newer.
  const need = new Map<string, Set<string>>();
  for (const part of WHATS_NEW_PARTS) {
    const set = need.get(WHATS_NEW_REPOS[part]) ?? new Set<string>();
    const v = installed[part];
    if (v && VERSION.test(v)) set.add(v);
    need.set(WHATS_NEW_REPOS[part], set);
  }
  await Promise.all(
    WHATS_NEW_PARTS.map(async (part) => {
      const version = installed[part];
      if (!version || !VERSION.test(version)) return;
      const repo = WHATS_NEW_REPOS[part];
      const r = await notes.releases(repo, refresh, [...(need.get(repo) ?? [])]);
      const base: WhatsNewComponent = { part, name: WHATS_NEW_NAMES[part], installed: version, entries: [], more: 0, releasesUrl: `https://github.com/${repo}/releases` };
      components.push(r.error ? { ...base, error: r.error } : { ...base, ...selectNotes(r.releases, { installed: version, channel }) });
    }),
  );
  components.sort((a, b) => WHATS_NEW_PARTS.indexOf(a.part) - WHATS_NEW_PARTS.indexOf(b.part));
  return { channel, components };
}

/** GET /whats-new, ?refresh=1 to ask GitHub again. */
export function registerWhatsNew(api: Pick<DaemonExtensionApi, "route">, deps: WhatsNewDeps): void {
  const notes = deps.notes ?? new ReleaseNotes(path.join(deps.dataDir, NOTES_CACHE_FILE));
  api.route("GET", "/whats-new", async (req) => ({ body: await whatsNew({ ...deps, notes }, req.query.refresh === "1" || req.query.refresh === "true") }));
}
