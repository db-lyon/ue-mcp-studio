/**
 * GET /v1/ext/studio/whats-new: the release notes for what changed in each
 * part Studio keeps current, read from each part's GitHub releases by the
 * agent and cached there.
 */

/** The parts, in the order the What's new dialog lists them. */
export const WHATS_NEW_PARTS = ["studio", "plugin", "bridge", "ueMcp"] as const;
export type WhatsNewPart = (typeof WHATS_NEW_PARTS)[number];

/** One release of a part, with its notes as markdown. */
export interface WhatsNewEntry {
  version: string;
  /** The release's notes, markdown. Rendered without raw HTML. */
  body: string;
  /** The release's page on GitHub. */
  url: string;
  /** ISO time it was published, when GitHub said. */
  publishedAt: string | null;
  /** Newer than what is installed: Update would bring it. Always true from this agent; an older agent also sent the installed release. */
  available: boolean;
}

export interface WhatsNewComponent {
  part: WhatsNewPart;
  /** "Studio", "Editor plugin (UE_MCP_Studio)", ... */
  name: string;
  installed: string | null;
  /** Newest first: the releases newer than installed on the channel. */
  entries: WhatsNewEntry[];
  /** Releases in the range left out to keep the list short. */
  more: number;
  /** Why the notes could not be read; entries is empty then. */
  error?: string;
  /** The part's releases page, for reading there. */
  releasesUrl: string;
}

export interface WhatsNew {
  channel: "stable" | "beta";
  components: WhatsNewComponent[];
}
