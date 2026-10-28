/**
 * @-mentions in the composer: what a typed @name asks for, the matches the
 * agent finds for it (POST /v1/ext/studio/mentions/search), and the token a
 * picked match leaves in the message. The token is plain text, so it survives
 * edits, drafts and reloads, and it carries the full target, so the agent can
 * act on it without searching again:
 *
 *   [@BP_Player](/Game/Blueprints/BP_Player.BP_Player "Blueprint")
 *   [@Cube](actor:/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2 "StaticMeshActor")
 *   [@MyActor.cpp](file:Source/MyGame/MyActor.cpp "C++ source")
 */

export type MentionKind = "asset" | "actor" | "file";
export const MENTION_KINDS: readonly MentionKind[] = ["asset", "actor", "file"];

/** One match: what the picker shows (name, type, path) and what the token carries (target). */
export interface MentionMatch {
  kind: MentionKind;
  name: string;
  /** The asset's class, the actor's class, or the file's type. */
  type: string;
  /** Shown under the name: the object path, the actor's level path, or the file's path from the project folder. */
  path: string;
  /** What the token points at: an object path, actor:<object path>, or file:<path from the project folder>. */
  target: string;
}

/** POST /v1/ext/studio/mentions/search. */
export interface MentionSearchRequest {
  query: string;
  /** Only these kinds; every kind when omitted. */
  kinds?: MentionKind[];
}

/**
 * Where each kind was looked up: the editor, the files on disk (with no editor,
 * assets come from the package files), or nowhere (actors need an editor).
 */
export type MentionSource = "editor" | "disk" | "unavailable";

export interface MentionSearchResponse {
  query: string;
  results: MentionMatch[];
  sources: Partial<Record<MentionKind, MentionSource>>;
}

/** The most matches one search returns. */
export const MENTION_ROWS = 12;
/** The longest query a search takes. */
export const MAX_MENTION_QUERY = 128;

/** A typed @name: where it starts in the message, the text after @, and the kinds a prefix narrows it to. */
export interface MentionQuery {
  start: number;
  end: number;
  /** The words to match, without the @ or a kind prefix. */
  query: string;
  kinds?: MentionKind[];
}

/** Prefixes that narrow a mention to one kind: @actor:Cube, @file:Config, @asset:Rock. */
const KIND_PREFIX = /^(asset|actor|file):/i;

/**
 * The @name being typed at the caret, or null. The @ starts the message or
 * follows a space or an opening bracket, and the name runs to the caret with
 * no space in it, so an e-mail address or a written token is left alone.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  let at = caret - 1;
  while (at >= 0 && !/[\s@[\]()]/.test(text[at])) at--;
  if (at < 0 || text[at] !== "@") return null;
  if (at > 0 && !/[\s(]/.test(text[at - 1])) return null;
  // The caret is inside a name: the mention runs to the end of it.
  let end = caret;
  while (end < text.length && !/[\s@[\]()]/.test(text[end])) end++;
  let query = text.slice(at + 1, caret);
  if (query.length > MAX_MENTION_QUERY) return null;
  const prefix = KIND_PREFIX.exec(query);
  if (prefix) {
    query = query.slice(prefix[0].length);
    return { start: at, end, query, kinds: [prefix[1].toLowerCase() as MentionKind] };
  }
  return { start: at, end, query };
}

const escapeName = (name: string): string => name.replace(/[[\]\n\r]/g, " ").trim();
const escapeType = (type: string): string => type.replace(/["\n\r]/g, "").trim();

/** The token a picked match leaves in the message. A target with a space or a bracket is written in angle brackets. */
export function mentionToken(m: Pick<MentionMatch, "name" | "type" | "target">): string {
  const target = /[\s()<>]/.test(m.target) ? `<${m.target.replace(/[<>\n\r]/g, "")}>` : m.target;
  const type = escapeType(m.type);
  return `[@${escapeName(m.name)}](${target}${type ? ` "${type}"` : ""})`;
}

/** Mention tokens in running text. */
export const MENTION_IN_TEXT = /\[@([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s()<>"]+))(?: "([^"\n]*)")?\)/g;

/** A mention token found in a message. */
export interface MentionSpan {
  start: number;
  end: number;
  kind: MentionKind;
  name: string;
  type: string;
  /** The target as written in the token. */
  target: string;
  /** The target without its kind prefix: the object path, or the file's path. */
  path: string;
}

/** What a token's target names. */
export function mentionTarget(target: string): { kind: MentionKind; path: string } {
  if (target.startsWith("actor:")) return { kind: "actor", path: target.slice(6) };
  if (target.startsWith("file:")) return { kind: "file", path: target.slice(5) };
  return { kind: "asset", path: target };
}

/** Every mention token in a message, in order. */
export function parseMentions(text: string): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const m of text.matchAll(new RegExp(MENTION_IN_TEXT.source, "g"))) {
    const target = m[2] ?? m[3];
    const t = mentionTarget(target);
    out.push({ start: m.index!, end: m.index! + m[0].length, kind: t.kind, name: m[1], type: m[4] ?? "", target, path: t.path });
  }
  return out;
}

/** The message with the typed @name replaced by a match's token and a space; the caret goes after the space. */
export function insertMention(text: string, q: Pick<MentionQuery, "start" | "end">, m: Pick<MentionMatch, "name" | "type" | "target">): { text: string; caret: number } {
  const token = mentionToken(m);
  const after = text.slice(q.end);
  const glue = after.startsWith(" ") ? "" : " ";
  const before = text.slice(0, q.start) + token + glue;
  return { text: before + after, caret: before.length + (glue ? 0 : 1) };
}

/** How well a name answers a query: 0 exact, 1 its start, 2 a word's start in it, 3 anywhere in it, 4 only in the path, -1 not at all. */
export function mentionRank(query: string, m: Pick<MentionMatch, "name" | "path">): number {
  const q = query.toLowerCase();
  if (!q) return 1;
  const name = m.name.toLowerCase();
  if (name === q || name.replace(/\.[^.]*$/, "") === q) return 0;
  if (name.startsWith(q)) return 1;
  const at = name.indexOf(q);
  if (at > 0) return /[^a-z0-9]/.test(name[at - 1]) || /[A-Z]/.test(m.name[at]) ? 2 : 3;
  return m.path.toLowerCase().includes(q) ? 4 : -1;
}

const KIND_ORDER: Record<MentionKind, number> = { asset: 0, actor: 1, file: 2 };

/** Matches ranked by name, then the shorter name, then assets, actors and files; one row per target, at most `rows`. */
export function rankMentions(query: string, matches: MentionMatch[], rows = MENTION_ROWS): MentionMatch[] {
  const seen = new Set<string>();
  return matches
    .map((m) => ({ m, r: mentionRank(query, m) }))
    .filter(({ m, r }) => {
      if (r < 0 || seen.has(m.target)) return false;
      seen.add(m.target);
      return true;
    })
    .sort((a, b) => a.r - b.r || a.m.name.length - b.m.name.length || KIND_ORDER[a.m.kind] - KIND_ORDER[b.m.kind] || a.m.name.localeCompare(b.m.name) || a.m.path.localeCompare(b.m.path))
    .slice(0, rows)
    .map(({ m }) => m);
}

/** A file's type, from its extension. */
export function fileType(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "h":
    case "hpp":
    case "inl":
      return "C++ header";
    case "cpp":
    case "cc":
      return "C++ source";
    case "cs":
      return "C# source";
    case "ini":
      return "Config";
    case "":
      return "File";
    default:
      return `${ext.toUpperCase()} file`;
  }
}
