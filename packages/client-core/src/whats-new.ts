/**
 * The What's new dialog's model, shared by client-web's Updates card and the
 * mobile app's: GET /v1/ext/studio/whats-new read and normalized, which parts
 * show, and the dialog's words.
 */
import { WHATS_NEW_PARTS, type WhatsNew, type WhatsNewComponent, type WhatsNewEntry, type WhatsNewPart } from "@ue-mcp-studio/shared";
import { obj } from "./normalize.js";

export const WHATS_NEW_TITLE = "What's new";
export const NOTHING_NEW = "Nothing new.";
export const WHATS_NEW_UNAVAILABLE = "This Studio cannot read release notes yet. Update Studio, or read them on GitHub.";
export const WHATS_NEW_AVAILABLE = "Available";
export const WHATS_NEW_PAGE = "Release page";
export const WHATS_NEW_NO_NOTES = "No notes for this release.";

export const whatsNewPath = (refresh = false): string => `/v1/ext/studio/whats-new${refresh ? "?refresh=1" : ""}`;

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function entryOf(raw: unknown): WhatsNewEntry | null {
  const e = obj(raw);
  const version = text(e.version);
  if (!version) return null;
  return { version, body: text(e.body) ?? "", url: text(e.url) ?? "", publishedAt: text(e.publishedAt), available: e.available === true };
}

function componentOf(raw: unknown): WhatsNewComponent | null {
  const c = obj(raw);
  const part = c.part as WhatsNewPart;
  if (!WHATS_NEW_PARTS.includes(part)) return null;
  const entries = Array.isArray(c.entries) ? c.entries.map(entryOf).filter((e): e is WhatsNewEntry => !!e) : [];
  return {
    part,
    name: text(c.name) ?? part,
    installed: text(c.installed),
    previous: text(c.previous),
    entries,
    more: typeof c.more === "number" && c.more > 0 ? c.more : 0,
    ...(text(c.error) ? { error: text(c.error)! } : {}),
    releasesUrl: text(c.releasesUrl) ?? "",
  };
}

/** The agent's answer, or null when there is none (an agent from before the route). */
export function whatsNewOf(raw: unknown): WhatsNew | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { components?: unknown }).components)) return null;
  const w = obj(raw);
  return {
    channel: w.channel === "beta" ? "beta" : "stable",
    components: (w.components as unknown[]).map(componentOf).filter((c): c is WhatsNewComponent => !!c),
  };
}

/** Given a GET that answers a route's JSON or null. refresh asks GitHub again rather than the agent's cache. */
export async function readWhatsNewWith(get: (path: string) => Promise<unknown>, refresh = false): Promise<WhatsNew | null> {
  return whatsNewOf(await get(whatsNewPath(refresh)));
}

/** The accordions to show: a part with notes, or one whose notes could not be read. */
export const shownComponents = (w: WhatsNew | null): WhatsNewComponent[] => (w ? w.components.filter((c) => c.entries.length > 0 || !!c.error) : []);

/** The accordion's summary beside its name: "0.1.30 to 0.1.35", the installed version alone, and what is available. */
export function componentRange(c: WhatsNewComponent): string {
  const available = c.entries.find((e) => e.available)?.version;
  const base = c.previous && c.installed && c.previous !== c.installed ? `${c.previous} to ${c.installed}` : (c.installed ?? "");
  return available ? `${base}, ${available} available` : base;
}

/** "Could not load the release notes: GitHub answered 500." */
export const whatsNewError = (c: WhatsNewComponent): string => `Could not load the release notes: ${(c.error ?? "no answer").replace(/\.$/, "")}.`;

/** "More releases are on the release page": the older ones left out of a long list. */
export const moreLine = (n: number): string => `${n} older release${n === 1 ? "" : "s"} on the release page.`;

/** A release's date as YYYY-MM-DD, or "" when unknown. */
export const entryDate = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");
