import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  insertMention,
  mentionQuery,
  parseMentions,
  rankMentions,
  type MentionKind,
  type MentionMatch,
  type MentionSearchRequest,
  type MentionSearchResponse,
  type MentionSpan,
} from "@ue-mcp-studio/shared";
import { ExactAssetLink } from "./AssetLink";

export const MENTION_MENU_ID = "mention-menu";
/** A search starts once typing pauses this long. */
export const MENTION_DEBOUNCE_MS = 120;

/** Looks names up for a mention; aborted through `signal` when the mention changes first. */
export type MentionSearchFn = (request: MentionSearchRequest, signal: AbortSignal) => Promise<MentionSearchResponse>;

const KIND_LABEL: Record<MentionKind, string> = { asset: "Asset", actor: "Actor", file: "File" };
const kindWords = (kinds?: MentionKind[]): string => {
  if (!kinds || kinds.length !== 1) return "assets, actors or files";
  return `${kinds[0]}s`;
};
const keyOf = (query: string, kinds?: MentionKind[]): string => `${kinds?.join(",") ?? "*"}|${query.toLowerCase()}`;

/**
 * The @-mention menu: open while the caret is in an @name. Each pause in
 * typing searches the project's assets, the open level's actors and the
 * project's files by name; a newer mention aborts the older search. Up and
 * Down move through the matches, Enter or Tab inserts the one in focus as a
 * token (mentions.ts in the shared package), Escape closes the menu until the
 * message changes. `keyDown` returns true when the menu took the key.
 */
export function useMentionMenu(draft: string, onDraft: (text: string) => void, box: RefObject<HTMLTextAreaElement>, search?: MentionSearchFn) {
  const [caret, setCaret] = useState<number | null>(null);
  const q = search && caret !== null ? mentionQuery(draft, caret) : null;
  const key = q ? keyOf(q.query, q.kinds) : null;
  const [answer, setAnswer] = useState<{ key: string; response: MentionSearchResponse } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!q || !search || !q.query.trim() || answer?.key === key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search({ query: q.query, ...(q.kinds ? { kinds: q.kinds } : {}) }, controller.signal).then(
        (response) => {
          if (controller.signal.aborted) return;
          setAnswer({ key: key!, response });
          setFailed(null);
        },
        () => {
          if (!controller.signal.aborted) setFailed(key);
        },
      );
    }, MENTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  useEffect(() => setActive(0), [key]);

  // The last answer, narrowed to what is typed now, stands in until the new one comes.
  const fresh = answer !== null && answer.key === key;
  const items: MentionMatch[] = useMemo(() => {
    if (!q || !answer || !q.query.trim()) return [];
    if (fresh) return answer.response.results;
    const kinds = q.kinds;
    return rankMentions(q.query, answer.response.results.filter((m) => !kinds || kinds.includes(m.kind)));
  }, [answer, key]);
  const searching = !!q && !!q.query.trim() && !fresh && failed !== key;

  const open = !!q && closedAt !== draft;
  const index = Math.min(active, Math.max(0, items.length - 1));

  // After an insert, the caret goes after the token once the box holds the new text.
  const pendingCaret = useRef<{ text: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    const el = box.current;
    if (!p || !el || el.value !== p.text) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(p.at, p.at);
    setCaret(p.at);
  }, [draft]);

  const pick = (m: MentionMatch) => {
    if (!q) return;
    const next = insertMention(draft, q, m);
    pendingCaret.current = { text: next.text, at: next.caret };
    onDraft(next.text);
  };

  // The option in focus stays in view as the arrows move through a list that scrolls.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`#${MENTION_MENU_ID}-${index}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [index, open]);

  const keyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setClosedAt(draft);
      return true;
    }
    if (items.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      pick(items[index]);
      return true;
    }
    return false;
  };

  /** The text box reports where its caret is on every change and selection. */
  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  const optionId = (i: number) => `${MENTION_MENU_ID}-${i}`;
  const sources = fresh ? answer!.response.sources : {};
  const notes = [
    sources.actor === "unavailable" ? "Actors need a running editor." : null,
    sources.asset === "disk" ? "Assets are read from disk while the editor is not answering." : null,
  ].filter((n): n is string => !!n);

  let status: string | null = null;
  if (q && !q.query.trim()) status = `Type a name to find ${kindWords(q.kinds)}.`;
  else if (items.length === 0 && searching) status = "Searching";
  else if (items.length === 0 && failed === key) status = "Search failed. Keep typing to try again.";
  // Nothing asked could be looked up: the note says why, not that nothing matched.
  else if (items.length === 0 && q && !(fresh && Object.values(sources).length > 0 && Object.values(sources).every((v) => v === "unavailable"))) status = `No ${kindWords(q.kinds)} match ${q.query}.`;

  return {
    open,
    keyDown,
    track,
    /** The text box lost focus: the menu closes until the caret is back in a mention. */
    blur: () => setCaret(null),
    /** For the text box: the menu it controls and the option in focus. */
    aria: open && items.length > 0
      ? { "aria-controls": MENTION_MENU_ID, "aria-activedescendant": optionId(index), "aria-autocomplete": "list" as const, "aria-expanded": true }
      : open ? { "aria-controls": MENTION_MENU_ID, "aria-autocomplete": "list" as const, "aria-expanded": true } : {},
    menu: open ? (
      <div className="mention-menu" aria-busy={searching}>
        <ul ref={list} id={MENTION_MENU_ID} role="listbox" aria-label="Mentions">
          {items.map((m, i) => (
            <li
              key={m.target}
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              className={i === index ? "active" : undefined}
              title={m.path}
              // Before the text box blurs, so the token lands in it.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`mention-kind kind-${m.kind}`}>{KIND_LABEL[m.kind]}</span>
              <span className="mention-name">{m.name}</span>
              <span className="mention-type dim small">{m.type}</span>
              {/* One line, cut at the start: the end of a path is what tells two matches apart. */}
              <span className="mention-path dim small"><bdo dir="ltr">{m.path}</bdo></span>
            </li>
          ))}
        </ul>
        {status && <div className="mention-status dim small" role="status">{status}</div>}
        {notes.length > 0 && <div className="mention-note dim small">{notes.join(" ")}</div>}
      </div>
    ) : null,
  };
}

/** The mentions a message being written carries, as chips; removing one takes its token out of the message. */
export function MentionChips({ draft, onDraft }: { draft: string; onDraft: (text: string) => void }) {
  const spans = parseMentions(draft);
  if (spans.length === 0) return null;
  const remove = (s: MentionSpan) => onDraft(draft.slice(0, s.start) + draft.slice(s.end).replace(/^ /, ""));
  return (
    <div className="mention-list" aria-label="Mentioned">
      {spans.map((s) => (
        <span key={`${s.start}-${s.target}`} className={`mention-chip kind-${s.kind}`} title={`${KIND_LABEL[s.kind]}: ${s.path}`}>
          <span className="mention-kind">{KIND_LABEL[s.kind]}</span>
          <span className="mention-chip-name">{s.name}</span>
          <button className="attach-remove" aria-label={`Remove the mention of ${s.name}`} onClick={() => remove(s)}>{"×"}</button>
        </span>
      ))}
    </div>
  );
}

/** A sent message's text with its mention tokens drawn as chips: an asset's opens it in the editor. */
export function MentionText({ text }: { text: string }) {
  const spans = parseMentions(text);
  if (spans.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(s.kind === "asset"
      ? <span key={i} className="mention-sent mention-chip kind-asset" title={`${KIND_LABEL.asset}: ${s.path}`}><span className="mention-kind">{KIND_LABEL.asset}</span><ExactAssetLink path={s.path} label={s.name} /></span>
      : <span key={i} className={`mention-sent mention-chip kind-${s.kind}`} title={`${KIND_LABEL[s.kind]}: ${s.path}`}><span className="mention-kind">{KIND_LABEL[s.kind]}</span><span className="mention-chip-name">{s.name}</span></span>);
    at = s.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
