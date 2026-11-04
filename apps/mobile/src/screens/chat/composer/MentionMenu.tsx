/**
 * The web client's chat/MentionMenu.tsx for the app: the @-mention menu over
 * the message box, the mentions a message carries as chips, and a sent
 * message's text with its mentions drawn as chips. The rules are the shared
 * package's mentions.ts and client-core's composer-menus.ts.
 * styles.css: .mention-menu, .mention-kind, .mention-list, .mention-chip.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Platform, Pressable, ScrollView, Text, View, type ScrollViewInstance, type TextInputInstance } from "react-native";
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
import { MENTION_KIND_LABEL as KIND_LABEL, mentionKey as keyOf, mentionNotes, mentionStatus } from "@ue-mcp-studio/client-core";
import { font, RemoveButton, useStyles, useTheme, type Theme } from "../../../ui";
import { ExactAssetLink } from "../../../chat/AssetLink";
import { keepFocus, menuBox, pickOn, type MenuKey } from "./SlashMenu";

export const MENTION_MENU_ID = "mention-menu";
/** A search starts once typing pauses this long. */
export const MENTION_DEBOUNCE_MS = 120;

/** Looks names up for a mention; aborted through `signal` when the mention changes first. */
export type MentionSearchFn = (request: MentionSearchRequest, signal: AbortSignal) => Promise<MentionSearchResponse>;

/**
 * The @-mention menu: open while the caret is in an @name. Each pause in
 * typing searches the project's assets, the open level's actors and the
 * project's files by name; a newer mention aborts the older search. A tap
 * inserts a match as a token (mentions.ts in the shared package); on a
 * hardware keyboard Up and Down move, Enter or Tab inserts and Escape closes
 * the menu until the message changes. `keyDown` returns true when the menu
 * took the key.
 */
export function useMentionMenu(draft: string, onDraft: (text: string) => void, box: RefObject<TextInputInstance | null>, search?: MentionSearchFn) {
  const s = useStyles(styles);
  const t = useTheme();
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
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const pendingCaret = useRef<{ text: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    if (!p || draft !== p.text) {
      if (selection) setSelection(undefined);
      return;
    }
    pendingCaret.current = null;
    box.current?.focus();
    setSelection({ start: p.at, end: p.at });
    setCaret(p.at);
  }, [draft]);

  const pick = (m: MentionMatch) => {
    if (!q) return;
    const next = insertMention(draft, q, m);
    pendingCaret.current = { text: next.text, at: next.caret };
    onDraft(next.text);
  };

  // The option in focus stays in view as the arrows move through a list that scrolls.
  const list = useRef<ScrollViewInstance>(null);
  const rowY = useRef<number[]>([]);
  useEffect(() => {
    const y = rowY.current[index];
    if (y !== undefined) list.current?.scrollTo({ y: Math.max(0, y - 4), animated: false });
  }, [index, open]);

  const keyDown = (e: MenuKey): boolean => {
    if (!open) return false;
    if (e.key === "Escape") {
      setClosedAt(draft);
      return true;
    }
    if (items.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) || (e.key === "Tab" && !e.shiftKey)) {
      pick(items[index]);
      return true;
    }
    return false;
  };

  /** The text box reports where its caret is on every change and selection. */
  const track = (sel: { start: number; end: number }) => setCaret(sel.start === sel.end ? sel.start : null);
  const sources = fresh ? answer!.response.sources : {};
  const notes = mentionNotes(sources);
  const status = mentionStatus({ q, items: items.length, searching, failed: failed === key, fresh, sources });

  return {
    open,
    keyDown,
    track,
    /** Where the caret goes after an insert, for the box's selection; undefined otherwise. */
    selection,
    /** The text box lost focus: the menu closes until the caret is back in a mention. */
    blur: () => setCaret(null),
    /** For the text box: that a list completes it. */
    a11y: open ? { accessibilityHint: "Mentions menu open" } : {},
    menu: open ? (
      <View style={s.menu} accessibilityLabel="Mentions" aria-busy={searching} nativeID={MENTION_MENU_ID} {...keepFocus}>
        {items.length > 0 && (
          <ScrollView ref={list} style={s.list} keyboardShouldPersistTaps="always" accessibilityRole="list">
            {items.map((m, i) => (
              <Pressable
                key={m.target}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: i === index }}
                accessibilityLabel={`${KIND_LABEL[m.kind]} ${m.name}`}
                accessibilityHint={m.path}
                {...pickOn(() => pick(m))}
                onHoverIn={() => setActive(i)}
                onLayout={(e) => {
                  rowY.current[i] = e.nativeEvent.layout.y;
                }}
                style={[s.row, i === index && { backgroundColor: t.c.panel3 }]}
              >
                <View style={s.line}>
                  <KindBadge kind={m.kind} />
                  <Text style={s.name} numberOfLines={1}>{m.name}</Text>
                  <Text style={s.type} numberOfLines={1}>{m.type}</Text>
                </View>
                {/* One line, cut at the start: the end of a path is what tells two matches apart. */}
                <PathLine path={m.path} />
              </Pressable>
            ))}
          </ScrollView>
        )}
        {status ? <Text style={s.status} accessibilityRole="text" accessibilityLiveRegion="polite">{status}</Text> : null}
        {notes.length > 0 ? <Text style={[s.status, (items.length > 0 || status) && s.noteLine]}>{notes.join(" ")}</Text> : null}
      </View>
    ) : null,
  };
}

/** A path on one line, cut at its start. */
function PathLine({ path }: { path: string }) {
  const s = useStyles(styles);
  if (Platform.OS === "web") {
    // The browser has no head ellipsis: right to left with the path kept left to right, as the web client draws it.
    return (
      <Text style={[s.path, { direction: "rtl", textAlign: "left" } as never]} numberOfLines={1}>
        <Text {...({ dir: "ltr" } as object)}>{path}</Text>
      </Text>
    );
  }
  return <Text style={s.path} numberOfLines={1} ellipsizeMode="head">{path}</Text>;
}

/** .mention-kind: the kind's word on its wash, the asset's in the accent. */
export function KindBadge({ kind }: { kind: MentionKind }) {
  const t = useTheme();
  const asset = kind === "asset";
  return (
    <View style={{ flexShrink: 0, paddingHorizontal: 5, borderRadius: 4, backgroundColor: asset ? t.c.accentWash : t.c.panel3 }}>
      <Text style={{ ...font(t, "sans", 600, 10), lineHeight: 16, textTransform: "uppercase", letterSpacing: 0.4, color: asset ? t.c.accentHi : t.c.muted }}>{KIND_LABEL[kind]}</Text>
    </View>
  );
}

/** The mentions a message being written carries, as chips; removing one takes its token out of the message. */
export function MentionChips({ draft, onDraft }: { draft: string; onDraft: (text: string) => void }) {
  const s = useStyles(styles);
  const spans = parseMentions(draft);
  if (spans.length === 0) return null;
  const remove = (sp: MentionSpan) => onDraft(draft.slice(0, sp.start) + draft.slice(sp.end).replace(/^ /, ""));
  return (
    <View style={s.chips} accessibilityLabel="Mentioned">
      {spans.map((sp) => (
        <View key={`${sp.start}-${sp.target}`} style={s.chip} accessibilityHint={`${KIND_LABEL[sp.kind]}: ${sp.path}`}>
          <KindBadge kind={sp.kind} />
          <Text style={s.chipName} numberOfLines={1}>{sp.name}</Text>
          <RemoveButton label={`Remove the mention of ${sp.name}`} onPress={() => remove(sp)} />
        </View>
      ))}
    </View>
  );
}

/** A sent message's text with its mention tokens drawn as chips: an asset's opens it in the editor. Goes inside a Text. */
export function MentionText({ text }: { text: string }) {
  const s = useStyles(styles);
  const spans = parseMentions(text);
  if (spans.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((sp, i) => {
    if (sp.start > at) out.push(text.slice(at, sp.start));
    out.push(
      <View key={i} style={s.sent} accessibilityHint={`${KIND_LABEL[sp.kind]}: ${sp.path}`}>
        <KindBadge kind={sp.kind} />
        {sp.kind === "asset" ? <ExactAssetLink path={sp.path} label={sp.name} /> : <Text style={s.chipName} numberOfLines={1}>{sp.name}</Text>}
      </View>,
    );
    at = sp.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

const styles = (t: Theme) => {
  const lh = t.editor ? 1.5 : 1.55;
  return {
    menu: { ...menuBox(t), flexDirection: "column" as const, maxHeight: 340 },
    list: { flexGrow: 0, minHeight: 0 },
    row: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, rowGap: 2 },
    line: { flexDirection: "row" as const, alignItems: "baseline" as const, columnGap: 8 },
    name: { ...font(t, "mono", 400, t.base.size, lh), color: t.c.text, flex: 1, minWidth: 0 },
    type: { ...font(t, "sans", 400, 12, lh), color: t.c.dim, flexShrink: 0, maxWidth: t.editor ? 108 : 141 },
    path: { ...font(t, "mono", 400, 11, lh), color: t.c.dim },
    status: { ...font(t, "sans", 400, 12, lh), color: t.c.dim, paddingVertical: 6, paddingHorizontal: 10 },
    noteLine: { borderTopWidth: 1, borderTopColor: t.c.line },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, maxWidth: "100%" as const, paddingTop: 2, paddingRight: 2, paddingBottom: 2, paddingLeft: 4, borderWidth: 1, borderColor: t.c.line, borderRadius: 6, backgroundColor: t.c.panel2 },
    chipName: { ...font(t, "mono", 400, 12, lh), color: t.c.text, flexShrink: 1, minWidth: 0 },
    sent: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingRight: 6, paddingLeft: 3, borderWidth: 1, borderColor: t.c.line, borderRadius: 6, backgroundColor: t.c.panel2 },
  };
};
