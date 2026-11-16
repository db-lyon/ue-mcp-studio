/**
 * The What's new dialog's model, shared by client-web's Updates card and the
 * mobile app's: GET /v1/ext/studio/whats-new read and normalized, which parts
 * show, when the card offers it, and the dialog's words. It shows only what
 * is newer than each installed part on the channel: what Update would bring.
 */
import { WHATS_NEW_PARTS, type WhatsNew, type WhatsNewComponent, type WhatsNewEntry, type WhatsNewPart } from "@ue-mcp-studio/shared";
import { obj } from "./normalize.js";
import { releaseNoteText } from "./release-notes.js";
import { updateRows, type Updates } from "./updates.js";

export const WHATS_NEW_TITLE = "What's new";
export const NOTHING_NEW = "Nothing new.";
export const WHATS_NEW_UNAVAILABLE = "This Studio cannot read release notes yet. Update Studio, or read them on GitHub.";
export const WHATS_NEW_PAGE = "Release page";
export const WHATS_NEW_NO_NOTES = "No notes for this release.";

export const whatsNewPath = (refresh = false): string => `/v1/ext/studio/whats-new${refresh ? "?refresh=1" : ""}`;

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function entryOf(raw: unknown): WhatsNewEntry | null {
  const e = obj(raw);
  const version = text(e.version);
  if (!version) return null;
  return { version, body: releaseNoteText(version, text(e.body) ?? ""), url: text(e.url) ?? "", publishedAt: text(e.publishedAt), available: e.available === true };
}

function componentOf(raw: unknown): WhatsNewComponent | null {
  const c = obj(raw);
  const part = c.part as WhatsNewPart;
  if (!WHATS_NEW_PARTS.includes(part)) return null;
  // Only what is newer: an agent from before this rule also sent the installed release.
  const entries = Array.isArray(c.entries) ? c.entries.map(entryOf).filter((e): e is WhatsNewEntry => !!e && e.available) : [];
  return {
    part,
    name: text(c.name) ?? part,
    installed: text(c.installed),
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

/** The accordions to show: a part with something newer, or one whose notes could not be read. */
export const shownComponents = (w: WhatsNew | null): WhatsNewComponent[] => (w ? w.components.filter((c) => c.entries.length > 0 || !!c.error) : []);

/** The card offers What's new only when its check found something newer for some part. */
export const offersWhatsNew = (u: Updates | null): boolean => !!u && updateRows(u).some(([, , latest, available]) => available && !!latest);

/** The accordion's summary beside its name: "0.1.3 to 0.1.5", installed to the newest. */
export function componentRange(c: WhatsNewComponent): string {
  const newest = c.entries[0]?.version;
  return newest && c.installed ? `${c.installed} to ${newest}` : (newest ?? c.installed ?? "");
}

/** "Could not load the release notes: GitHub answered 500." */
export const whatsNewError = (c: WhatsNewComponent): string => `Could not load the release notes: ${(c.error ?? "no answer").replace(/\.$/, "")}.`;

/** The newer releases left out of a long list. */
export const moreLine = (n: number): string => `${n} more release${n === 1 ? "" : "s"} on the release page.`;

/** A release's date as YYYY-MM-DD, or "" when unknown. */
export const entryDate = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");
