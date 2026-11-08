/**
 * chat/Transcript.tsx: the conversation as the web client draws it at phone
 * width. The main thread (messages, tool calls, the progress fold, subagents,
 * notes, the streaming reply, the waiting and error lines) follows its newest
 * line while the reader is at the bottom, with a New messages pill under it
 * when they have scrolled up; a subagent's own thread is drawn the same way.
 */
import { Component, createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Image, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type TextStyle } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { lineDiff, type Attachment, type PlaytestRequest, type PlaytestStage, type TranscriptEntry, type TurnStatus } from "@ue-mcp-studio/shared";
import {
  OUTCOME_LABEL,
  RESULT_PREVIEW_LINES,
  TOOL_TAG,
  STATE_LABEL,
  agentStatus,
  callPath,
  callsIn,
  describe,
  formatDuration,
  foldSteps,
  formatResult,
  isActive,
  liveStep,
  mainTimeline,
  stepsSummary,
  summarize,
  toolLabel,
  toolTitle,
  type AgentState,
  type Call,
} from "@ue-mcp-studio/client-core";
import { Banner, baseFont, ContentButton, buttonFont, font, labelFont, lineBox, Markdown, MarkdownPiece, markdownPieces, Output, PIECE_CHARS, Pulse, stopOf, useTheme, type AssetMark, type Theme } from "../ui";
import { useProjectNav } from "../nav";
import { copyText } from "../native/clipboard";
import { MentionText } from "./MentionMenu";
import { DiffView } from "./Diff";
import { useAsked } from "./asked";
import { breakable } from "./breakable";
import { DialogLine } from "../screens/chat/items";
import { QaCard } from "./Qa";
import { TurnReviewCard } from "../screens/chat/items";
import { FlowCard } from "./FlowCommand";
import { CompactionMarker } from "../screens/chat/items";
import { SessionIdContext, attachmentUrl, formatBytes, isImage, useDaemonImage } from "./attachments";
import { useFollow, useNow } from "./hooks";
import { AssetAnchorContext, AssetTranscriptContext } from "./asset-links";
import { AssetToken, ExactAssetLink, LinkedText } from "./AssetLink";
import { noteError, noteRow, setDiag, useDiag } from "./diag";

/** Each entry's position in its transcript, built once per transcript rather than searched per entry. */
const positions = new WeakMap<readonly unknown[], Map<unknown, number>>();
function positionIn(transcript: readonly unknown[] | null | undefined, entry: TranscriptEntry): number {
  if (!transcript) return -1;
  let map = positions.get(transcript);
  if (!map) {
    map = new Map(transcript.map((e, i) => [e, i] as const));
    positions.set(transcript, map);
  }
  return map.get(entry) ?? -1;
}

/** The index in the session's transcript of the first entry held, when only the newest are (a page read with `tail`). */
export const TranscriptFromContext = createContext(0);

/** The transcript's inner width, for the user bubble's min(92%, 100% - 52px). */
const WidthContext = createContext<number>(366);

const small = (t: Theme, color?: string): TextStyle => ({ ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size), ...(color ? { color } : null) });

/**
 * Sends an edit of one of the user's messages, by its transcript index: "rewind" cuts this
 * session back to it, "fork" continues from it in a copy. Null where messages cannot be edited.
 */
export type EditMode = "rewind" | "fork";
export const EditMessageContext = createContext<((index: number, text: string, mode: EditMode) => void) | null>(null);

/** One line of a conversation that is not a subagent: a message, a note or a tool call. Renders again only when the entry changes. */
export const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  const transcript = useContext(AssetTranscriptContext);
  const from = useContext(TranscriptFromContext);
  if (entry.kind === "user") {
    const at = positionIn(transcript, entry);
    return <UserMessage entry={entry} at={at < 0 || entry.parent ? undefined : from + at} />;
  }
  if (entry.kind === "assistant") {
    const at = positionIn(transcript, entry);
    return <Reply text={entry.text} at={at < 0 ? undefined : from + at} />;
  }
  if (entry.kind === "note") return <Note text={entry.text} />;
  if (entry.kind === "dialog") return <DialogLine dialog={entry.dialog} />;
  // A deleted script's cards leave the conversation with it.
  if (entry.kind === "qa") return entry.run.deleted ? null : <QaCard run={entry.run} />;
  if (entry.kind === "review") return <TurnReviewCard review={entry.review} />;
  if (entry.kind === "playtest") {
    return entry.state === "failed"
      ? <PlaytestFailed errors={entry.errors?.length ? entry.errors : ["The playtest flow made no playtest."]} request={entry.request} />
      : <PlaytestProgress entry={entry} />;
  }
  if (entry.kind === "playtest-failed") return <PlaytestFailed errors={[entry.reason]} request={entry.request} />;
  if (entry.kind === "flow") return <FlowCard entry={entry} />;
  // An extension's card: the app has no extension slots, so it is left out as the web leaves an unregistered one.
  if (entry.kind === "card") return null;
  if (entry.kind === "compaction") return <CompactionMarker entry={entry} />;
  // A kind this client no longer draws, such as an older session's per-turn usage line.
  if (entry.kind !== "tool") return null;
  return <ToolCall call={entry.call} />;
});

/** .banner.warn.note: a note in the conversation, its line breaks kept. */
function Note({ text }: { text: string }) {
  const t = useTheme();
  return (
    <Banner kind="warn">
      <Text style={{ ...baseFont(t), color: t.c.warnText }}>{text}</Text>
    </Banner>
  );
}

/**
 * Runs a /playtest from a button: Retry on a failed one. `busy` while a turn
 * runs, when it cannot start. Null where nothing can be sent.
 */
export const PlaytestCommandContext = createContext<{ busy: boolean; run: (req: PlaytestRequest) => void } | null>(null);

/** The playtest flow's stages, in order, as the card names them. */
const PLAYTEST_STAGES: Array<[PlaytestStage, string]> = [
  ["gathering", "Gathering"],
  ["drafting", "Drafting"],
  ["checking", "Checking"],
  ["created", "Created"],
];

/** A /playtest while its flow runs: the stages, the one in progress marked, and the draft's attempt after a retry. */
function PlaytestProgress({ entry }: { entry: Extract<TranscriptEntry, { kind: "playtest" }> }) {
  const t = useTheme();
  const at = PLAYTEST_STAGES.findIndex(([s]) => s === entry.state);
  return (
    <Banner role="status" style={{ borderColor: t.c.line, backgroundColor: t.c.panel2 }}>
      <View accessibilityLabel="Playtest progress" accessibilityRole="list" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 10, marginVertical: 6 }}>
        {PLAYTEST_STAGES.map(([stage, label], i) => {
          const state = i < at || entry.state === "created" ? "done" : i === at ? "active" : "dim";
          return (
            <Text key={stage} accessibilityState={{ selected: i === at }} style={[small(t, state === "done" ? t.c.ok : t.c.text), state === "active" && font(t, "sans", 600, 12), state === "dim" && { opacity: 0.55 }]}>
              {state === "done" ? "✓  " : state === "active" ? "●  " : ""}
              {label}
              {stage === "drafting" && entry.attempt > 1 ? ` (attempt ${entry.attempt})` : ""}
            </Text>
          );
        })}
      </View>
    </Banner>
  );
}

/** A /playtest that saved no script: that it failed, the flow's errors, and Retry. */
function PlaytestFailed({ errors, request }: { errors: string[]; request: PlaytestRequest }) {
  const t = useTheme();
  const playtest = useContext(PlaytestCommandContext);
  const color = t.c.badText;
  return (
    <Banner kind="bad" role="status" style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
        <Text style={{ ...baseFont(t), ...font(t, "sans", 700, t.base.size), lineHeight: t.base.lineHeight, color }}>No playtest was made.</Text>
        <View style={{ flex: 1 }} />
        {playtest ? <ContentButton title="Retry" small fontSize={t.base.size} disabled={playtest.busy} onPress={() => playtest.run(request)} /> : null}
      </View>
      {errors.length === 1 ? (
        <Text style={small(t, color)}>{errors[0]}</Text>
      ) : (
        <View style={{ paddingLeft: 18 }}>
          {errors.map((e, i) => (
            <View key={i}>
              <Text style={[small(t, color), { position: "absolute", left: -18, width: 18, paddingRight: 5, textAlign: "right" }]}>{"•"}</Text>
              <Text style={small(t, color)}>{e}</Text>
            </View>
          ))}
        </View>
      )}
    </Banner>
  );
}

/** The pencil of Edit this message: the web's own 16px path drawn at 14px, stroked in the button's colour. */
function PencilGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 14, height: 14 }} importantForAccessibility="no-hide-descendants">
      <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M10.5 2.5l3 3L6 13H3v-3z" />
      </Svg>
    </View>
  );
}

/**
 * A message the user sent. Edit opens it in place. With anything after it,
 * saving asks where the edit goes: rewind this session to it (everything after
 * is removed, for the model too) or fork a new session from it and keep this one.
 */
function UserMessage({ entry, at }: { entry: Extract<TranscriptEntry, { kind: "user" }>; at?: number }) {
  const t = useTheme();
  const width = useContext(WidthContext);
  const onEdit = useContext(EditMessageContext);
  const [text, setText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const transcript = useContext(AssetTranscriptContext);
  const from = useContext(TranscriptFromContext);
  const last = at !== undefined && transcript ? from + transcript.length - 1 === at : false;
  const close = () => {
    setText(null);
    setConfirming(false);
  };
  const bubble = { alignSelf: "flex-end" as const, backgroundColor: t.c.accentWash, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 13 };
  if (text !== null && onEdit && at !== undefined) {
    const save = () => {
      if (!text.trim()) return;
      // Nothing after it to lose: no need to ask.
      if (last) {
        onEdit(at, text, "rewind");
        close();
      } else setConfirming(true);
    };
    const rows = Math.min(12, Math.max(2, text.split("\n").length));
    return (
      <View style={[bubble, { width: Math.min(640, width), maxWidth: width * 0.92, gap: 6 }]}>
        {entry.attachments && entry.attachments.length > 0 ? <SentFiles files={entry.attachments} /> : null}
        <TextInput
          accessibilityLabel="Edit your message"
          value={text}
          autoFocus
          multiline
          onChangeText={(v) => {
            setText(v);
            setConfirming(false);
          }}
          placeholderTextColor={t.c.dim}
          selectionColor={t.c.selection}
          style={{ ...font(t, "sans", 400, 16), lineHeight: 24, minHeight: rows * 24 + 14, color: t.c.text, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, textAlignVertical: "top" }}
        />
        {confirming ? (
          <View accessibilityRole="alert" style={{ gap: 6, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.warn, borderRadius: 6, backgroundColor: t.c.panel2 }}>
            <Text style={{ ...baseFont(t), fontSize: 12.5, lineHeight: 12.5 * (t.base.lineHeight / t.base.size) }}>
              <Text style={font(t, "sans", 700, 12.5)}>Rewind here</Text> removes everything after this message from this session, for the agent too.{" "}
              <Text style={font(t, "sans", 700, 12.5)}>Fork</Text> keeps this session as it is and continues from your edit in a new one. Either way, changes the agent already made to the project are not undone.
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginVertical: 6 }}>
              <ContentButton kind="ghost" small fontSize={12.5} title="Keep editing" onPress={() => setConfirming(false)} />
              <View style={{ flex: 1 }} />
              <ContentButton kind="danger" small fontSize={12.5} title="Rewind here" onPress={() => (onEdit(at, text, "rewind"), close())} />
              <ContentButton kind="primary" small fontSize={12.5} title="Fork a new session" onPress={() => (onEdit(at, text, "fork"), close())} />
            </View>
          </View>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginVertical: 6 }}>
            <View style={{ flex: 1 }} />
            <ContentButton kind="ghost" small fontSize={t.base.size} title="Cancel" onPress={close} />
            <ContentButton kind="primary" small fontSize={t.base.size} title="Save and send" disabled={!text.trim()} onPress={save} />
          </View>
        )}
      </View>
    );
  }
  const editable = !!onEdit && at !== undefined && entry.source === undefined;
  return (
    <View style={[bubble, { maxWidth: Math.min(width * 0.92, width - 52) }]}>
      {entry.attachments && entry.attachments.length > 0 ? <SentFiles files={entry.attachments} /> : null}
      <Text style={baseFont(t)} selectable>
        <MentionText text={entry.text} />
        {entry.source !== undefined ? <Text style={small(t, t.c.dim)}> from the agent's message above</Text> : null}
      </Text>
      {editable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit this message"
          accessibilityHint="Edit and send again from here"
          onPress={() => setText(entry.text)}
          style={({ pressed }) => ({ position: "absolute", top: 0, left: -50, width: 44, height: 44, alignItems: "center", justifyContent: "center", backgroundColor: t.c.panel2, borderWidth: 1, borderColor: pressed ? t.c.lineStrong : t.c.line, borderRadius: t.radius })}
        >
          <PencilGlyph color={t.c.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A session file as a picture, loaded through the relay. */
function DaemonImage({ path, type, alt, maxWidth, maxHeight }: { path: string; type: string; alt: string; maxWidth: number; maxHeight: number }) {
  const uri = useDaemonImage(path, type);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!uri) return;
    Image.getSize(uri, (w, h) => setSize({ w, h }), () => setSize(null));
  }, [uri]);
  if (!uri || !size) return <View accessibilityLabel={alt} style={{ width: 48, height: 48 }} />;
  const k = Math.min(1, maxWidth / size.w, maxHeight / size.h);
  return <Image accessibilityLabel={alt} source={{ uri }} style={{ width: size.w * k, height: size.h * k }} />;
}

/** The files a message carried: images as thumbnails, the rest by name. */
function SentFiles({ files }: { files: Attachment[] }) {
  const t = useTheme();
  const sessionId = useContext(SessionIdContext);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
      {files.map((f) => {
        const url = sessionId ? attachmentUrl(sessionId, f.id) : undefined;
        const image = isImage(f.type) && url;
        return (
          <View key={f.id} accessibilityLabel={`${f.name}, ${formatBytes(f.size)}`} style={{ maxWidth: "100%", paddingVertical: image ? 0 : 3, paddingHorizontal: image ? 0 : 8, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: 6, overflow: "hidden" }}>
            {image ? (
              <DaemonImage path={url} type={f.type} alt={f.name} maxWidth={220} maxHeight={160} />
            ) : (
              <Text style={{ ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size) }}>
                {f.name} <Text style={{ color: t.c.dim }}>{formatBytes(f.size)}</Text>
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** A reply's asset names: exact links, and tokens linked once resolved. */
const renderAsset = (mark: AssetMark, key: number): ReactNode =>
  mark.kind === "exact" ? <ExactAssetLink key={key} path={mark.path} label={mark.label} /> : <AssetToken key={key} token={mark.token} code={mark.code} />;

/**
 * A model reply, rendered as markdown without raw HTML; a single line break
 * stays a line break. at: its transcript index, for tracing the names in it.
 */
export const Reply = memo(function Reply({ text, at }: { text: string; at?: number }) {
  return (
    <AssetAnchorContext.Provider value={at}>
      <View style={{ alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 10, paddingRight: 13, paddingLeft: 2 }}>
        <Markdown text={text} assets renderAsset={renderAsset} renderCode={breakable} />
      </View>
    </AssetAnchorContext.Provider>
  );
});

/** Piece `piece` of a long reply on a row of its own: the reply's padding only at its two ends. */
export const ReplyPiece = memo(function ReplyPiece({ text, at, piece, count }: { text: string; at?: number; piece: number; count: number }) {
  return (
    <AssetAnchorContext.Provider value={at}>
      <View testID="reply-piece" style={{ alignSelf: "stretch", paddingTop: piece === 0 ? 10 : 0, paddingBottom: piece === count - 1 ? 10 : 0, paddingRight: 13, paddingLeft: 2 }}>
        <MarkdownPiece text={text} piece={piece} assets renderAsset={renderAsset} renderCode={breakable} />
      </View>
    </AssetAnchorContext.Provider>
  );
});

/** A reply's rows when it is long enough to be cut into pieces, or undefined when it fits one. */
function replyPieces(key: string, text: string, at: number | undefined): ThreadRow[] | undefined {
  const n = markdownPieces(text, true, true);
  if (n < 2) return undefined;
  return Array.from({ length: n }, (_, i) => ({ key: `${key}.${i}`, render: () => <ReplyPiece text={text} at={at} piece={i} count={n} /> }));
}

/** An entry's row, cut into pieces when it is a long reply. */
function entryRow(key: string, entry: TranscriptEntry, at: number | undefined): ThreadRow {
  return { key, render: () => <Entry entry={entry} />, pieces: entry.kind === "assistant" ? replyPieces(key, entry.text, at) : undefined };
}

/**
 * The reply as it streams, cut where a blank line falls within PIECE_CHARS (or
 * the first one after), so it never grows into one tall row. A run after a
 * cut starts on the cut's second line break, so the runs stack as the whole.
 * Earlier cuts stay where they are as more text arrives.
 */
export function streamPieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PIECE_CHARS) {
    let k = rest.lastIndexOf("\n\n", PIECE_CHARS);
    if (k <= 0) k = rest.indexOf("\n\n", PIECE_CHARS);
    if (k <= 0) break;
    out.push(rest.slice(0, k));
    rest = rest.slice(k + 1);
  }
  out.push(rest);
  return out;
}

function StreamPiece({ text, first, last }: { text: string; first: boolean; last: boolean }) {
  const t = useTheme();
  return (
    <View testID="stream-piece" style={{ alignSelf: "flex-start", maxWidth: "100%", paddingTop: first ? 10 : 0, paddingBottom: last ? 10 : 0, paddingRight: 13, paddingLeft: 2 }}>
      <Text style={baseFont(t)}>{text}</Text>
    </View>
  );
}

function streamRow(text: string): ThreadRow {
  const runs = streamPieces(text);
  return {
    key: "stream",
    render: () => <StreamPiece text={text} first last />,
    pieces: runs.length > 1 ? runs.map((r, i) => ({ key: `stream.${i}`, render: () => <StreamPiece text={r} first={i === 0} last={i === runs.length - 1} /> })) : undefined,
  };
}

/** .jump-latest: its own row under the conversation, so it never covers a line. */
function JumpLatest({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: "center", marginTop: 4, marginBottom: 6, minHeight: 44, minWidth: 44, justifyContent: "center", paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: pressed ? t.c.accentLine : t.c.lineStrong, backgroundColor: t.c.panel3, boxShadow: "0 4px 14px rgba(0, 0, 0, 0.3)" })}
    >
      <Text style={[buttonFont(t), t.editor ? null : { fontFamily: font(t, "sans", 500, 11.5).fontFamily, letterSpacing: 0 }, { color: t.c.text }]}>{"New messages ↓"}</Text>
    </Pressable>
  );
}

/** One line that fails to draw says so in its place, and the rest of the thread still shows. */
export class EntryBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { failed: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown) {
    noteError(e);
  }
  render() {
    if (this.state.failed === null) return this.props.children;
    return <Banner kind="bad">{`This item could not be shown: ${this.state.failed}`}</Banner>;
  }
}

/** One line of a thread as the list draws it: a stable key and what to draw. */
export interface ThreadRow {
  key: string;
  render: () => ReactNode;
  /** A long reply cut into pieces, each its own row of the list, drawn instead of `render`. */
  pieces?: ThreadRow[];
}

/** How many of the newest lines the list draws before it has measured any; the rest are drawn as they near the screen. */
export const FIRST_ROWS = 12;
/** A thread with lines that has shown none of them this long after opening says so. */
export const UNDRAWN_MS = 4000;
/** How many of the newest lines a thread opens with, and how many more each time the reader reaches the oldest drawn. */
export const PAGE_ROWS = 10;
/**
 * The tallest a line draws before it folds behind Show more, in dp. On
 * Android a scroller whose content runs to tens of thousands of pixels draws
 * nothing at all, so the lines in it stay short until the reader opens one.
 */
export const FOLD_MAX = 400;
/**
 * The newest line is never folded: a long reply is drawn as pieces on rows of
 * their own. A row that cannot be cut (a user's long message, a long table)
 * still folds past this, in dp, so no row grows to where Android stops drawing.
 */
export const UNFOLDED_MAX = 2000;
/** The fade over the bottom of a folded line, in dp. */
export const FOLD_FADE = 48;

/** A row as the list draws it: a line, or one piece of a long reply. */
interface Cell {
  key: string;
  render: () => ReactNode;
  /** The line a piece belongs to: pieces of one line are drawn with no gap between them. */
  group?: string;
  /** The row folds past this height; `open` and `toggle` are its own fold. */
  limit: number;
  open: boolean;
  toggle: () => void;
  /** The first piece of a folded long reply: Show more under it draws the rest. */
  more?: () => void;
  /** The last piece of a long reply the reader opened: Show less under it folds the line. */
  less?: () => void;
}

/**
 * The rows the list draws, newest first. A line is one row; a long reply is
 * always its pieces, all of them while it is the newest line or the reader
 * opened it, else only the first. The first piece is keyed as the line, so
 * opening or folding a reply adds or removes the rows after it and never
 * swaps the row being read for another.
 */
function cellsOf(rows: ThreadRow[], start: number, open: ReadonlySet<string>, toggle: (key: string) => void): Cell[] {
  const out: Cell[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const newest = i === rows.length - 1;
    const own = (key: string, limit: number) => ({ limit, open: open.has(key), toggle: () => toggle(key) });
    if (!r.pieces) {
      out.push({ key: r.key, render: r.render, ...own(r.key, newest ? UNFOLDED_MAX : FOLD_MAX) });
      continue;
    }
    const line = `${r.key}:whole`;
    const whole = newest || open.has(line);
    const shown = whole ? r.pieces : r.pieces.slice(0, 1);
    shown.forEach((p, j) =>
      out.push({
        key: j === 0 ? r.key : p.key,
        render: p.render,
        group: r.key,
        ...own(p.key, whole ? UNFOLDED_MAX : FOLD_MAX),
        more: whole ? undefined : () => toggle(line),
        less: whole && !newest && j === shown.length - 1 ? () => toggle(line) : undefined,
      }),
    );
  }
  return out.reverse();
}

/** 12 dp between lines, none between the pieces of one; `data` newest first, so the line below is the one before. */
const gapBelow = (data: Cell[], i: number) => (i > 0 && !(data[i].group && data[i].group === data[i - 1].group) ? 12 : 0);

function CellView({ data, index, onHeight }: { data: Cell[]; index: number; onHeight?: (h: number) => void }) {
  const c = data[index];
  const gap = gapBelow(data, index);
  return (
    <View style={gap ? { paddingBottom: gap } : null}>
      <Fold limit={c.limit} open={c.open} onToggle={c.toggle} more={c.more} less={c.less} onHeight={onHeight}>
        <EntryBoundary>{c.render()}</EntryBoundary>
      </Fold>
    </View>
  );
}

const VIEWABLE = { itemVisiblePercentThreshold: 1 };

/** The list as it last reported itself, for saying why a thread did not draw. */
interface Measured {
  height: number;
  content: number;
  offset: number;
  seen: number;
}

/**
 * .transcript: the scrolling column, 12px between lines, 14px 12px 10px inside.
 * An inverted FlatList: the newest line sits at offset 0 at the bottom, so a
 * thread opens on it without scrolling to the end, and only the lines near
 * the screen are drawn however long the session grows. It paints the panel
 * it sits on: a scroller Chrome scrolls on the GPU keeps subpixel text only
 * over an opaque background, and react-native-web's ScrollViews scroll there.
 */
function Column({ follow, hidden, rows, head, foot, more }: { follow: ReturnType<typeof useFollow>; hidden?: boolean; rows: ThreadRow[]; head?: ReactNode; foot?: ReactNode; more?: () => void }) {
  const t = useTheme();
  const [width, setWidth] = useState<number | null>(null);
  const window = useWindowDimensions().width;
  // The newest lines first, a page at a time: older pages join as the reader reaches the top.
  const [shown, setShown] = useState(PAGE_ROWS);
  // The lines the reader opened, by key; kept as newer lines arrive.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const data = useMemo(() => {
    const toggle = (key: string) =>
      setOpen((cur) => {
        const next = new Set(cur);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    return cellsOf(rows, Math.max(0, rows.length - shown), open, toggle);
  }, [rows, shown, open]);
  // Every held line drawn: ask for the entries before them.
  const older = () => {
    if (shown < rows.length) setShown(shown + PAGE_ROWS);
    else more?.();
  };
  const measured = useRef<Measured>({ height: 0, content: 0, offset: 0, seen: 0 });
  useUndrawn(data.length, measured);
  useEffect(() => setDiag({ rows: rows.length }), [rows.length]);
  const mode = useDiag().mode;
  const onLayout = (e: LayoutChangeEvent) => {
    measured.current.height = e.nativeEvent.layout.height;
    setDiag({ listH: e.nativeEvent.layout.height });
    setWidth(e.nativeEvent.layout.width - 24);
  };
  const followScroll = follow.props.onScroll;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    measured.current.offset = e.nativeEvent.contentOffset.y;
    setDiag({ offset: e.nativeEvent.contentOffset.y });
    followScroll(e);
  };
  const onViewable = useRef(({ viewableItems }: { viewableItems: unknown[] }) => {
    measured.current.seen = Math.max(measured.current.seen, viewableItems.length);
    setDiag({ seen: viewableItems.length });
  }).current;
  return (
    <WidthContext.Provider value={width ?? window - 24}>
      {mode === "plain" ? (
        <View testID="diag-plain" style={{ flex: 1, justifyContent: "flex-end", paddingHorizontal: 12, paddingBottom: 14, overflow: "hidden" }} onLayout={onLayout}>
          {data.slice(0, 12).map((item, i) => <CellView key={item.key} data={data} index={i} />).reverse()}
          {foot ? <View style={{ gap: 12, marginTop: data.length ? 12 : 0 }}>{foot}</View> : null}
        </View>
      ) : (
      <FlatList
        nativeID="transcript"
        ref={follow.ref as never}
        data={data}
        inverted
        keyExtractor={(c: Cell) => c.key}
        renderItem={({ index }: { index: number }) => <CellView data={data} index={index} onHeight={(h) => noteRow(index, h)} />}
        // An inverted list draws its header upright at the bottom of the thread and its footer at the top.
        ListHeaderComponent={foot ? <View style={{ gap: 12, marginTop: data.length ? 12 : 0 }}>{foot}</View> : undefined}
        ListFooterComponent={head ? <View style={{ marginBottom: data.length ? 12 : 0 }}>{head}</View> : undefined}
        onEndReached={older}
        onEndReachedThreshold={0.5}
        initialNumToRender={FIRST_ROWS}
        maxToRenderPerBatch={8}
        windowSize={9}
        // Clipped subviews leave blank rows in an inverted list on Android.
        removeClippedSubviews={false}
        // Up the thread, lines arriving below keep the one being read where it is.
        maintainVisibleContentPosition={follow.up ? { minIndexForVisible: 0 } : undefined}
        onScroll={onScroll}
        scrollEventThrottle={follow.props.scrollEventThrottle}
        onLayout={onLayout}
        onContentSizeChange={(_w: number, h: number) => {
          measured.current.content = h;
          setDiag({ contentH: h });
        }}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={VIEWABLE}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        style={{ flex: 1, backgroundColor: t.c.panel }}
        // Inverted: the container's top padding is the bottom of the thread, and its end the top,
        // where a short thread starts as on the web.
        contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", paddingTop: 10, paddingHorizontal: 12, paddingBottom: 14 }}
      />
      )}
    </WidthContext.Provider>
  );
}

/**
 * One row of a thread, folded to `limit` when it draws taller, so no row
 * makes the scroller's content tall enough to blank: the bottom of the fold
 * fades into the panel and a Show more pill sits centred under it. Open, the
 * pill reads Show less. `more` and `less` put the line's own pill under
 * the first piece of a folded reply and the last piece of an opened one.
 */
export function Fold({ children, onHeight, limit = FOLD_MAX, open = false, onToggle, more, less }: {
  children: ReactNode;
  onHeight?: (h: number) => void;
  limit?: number;
  open?: boolean;
  onToggle?: () => void;
  more?: () => void;
  less?: () => void;
}) {
  const [height, setHeight] = useState(0);
  const long = height > limit;
  const folded = long && !open;
  return (
    <View>
      {/* Always clipping: a view whose style drops overflow is flattened into its parent by Fabric, and moving the
          body between native parents as a line opens left its rows drawn at stale offsets on Android. */}
      <View testID="fold" collapsable={false} style={{ overflow: "hidden", maxHeight: folded ? limit : undefined }}>
        <View
          testID="fold-body"
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setHeight(h);
            onHeight?.(h);
          }}
        >
          {children}
        </View>
        {folded ? <FoldFade /> : null}
      </View>
      {more ? <FoldPill open={false} onPress={more} /> : long && onToggle ? <FoldPill open={open} onPress={onToggle} /> : less ? <FoldPill open onPress={less} /> : null}
    </View>
  );
}

/** Transparent to the panel over the fold's bottom FOLD_FADE dp, so the cut reads as a fold. */
function FoldFade() {
  const t = useTheme();
  const id = `foldFade${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const stop = stopOf(t.c.panel);
  return (
    <View testID="fold-fade" pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: FOLD_FADE }}>
      <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 1 1">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={stop.color} stopOpacity={0} />
            <Stop offset="1" stopColor={stop.color} stopOpacity={stop.opacity} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="1" height="1" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/** Show more or Show less: a centred pill, 44 dp tall, its border and text in the accent, the chevron pointing where the line goes. */
function FoldPill({ open, onPress }: { open: boolean; onPress: () => void }) {
  const t = useTheme();
  const label = open ? "Show less" : "Show more";
  const text: TextStyle = t.editor ? font(t, "sans", 600, 14, 1.2) : { ...font(t, "mono", 600, 13, 1.2), letterSpacing: 0.26 };
  return (
    <View style={{ alignItems: "center", paddingTop: 8 }}>
      <Pressable
        testID="fold-pill"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onPress}
        style={({ pressed }) => ({ minHeight: 44, minWidth: 140, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, borderColor: t.c.accent, backgroundColor: pressed ? t.c.accentWash : t.c.panel })}
      >
        <Text style={[text, { color: t.c.accent }]}>{label}</Text>
        <Svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke={t.c.accent} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <Path d={open ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"} />
        </Svg>
      </Pressable>
    </View>
  );
}

/**
 * On a phone, a thread with lines that has shown none of them a while after
 * opening says so, with what the list measured, instead of staying blank.
 */
function useUndrawn(count: number, measured: { current: Measured }): void {
  const setText = (text: string | null) => setDiag({ undrawn: text });
  const some = count > 0;
  useEffect(() => {
    setText(null);
    if (Platform.OS === "web" || !some) return;
    const id = setTimeout(() => {
      const m = measured.current;
      if (m.seen > 0 && m.height > 0) return;
      setText(`This conversation did not draw: ${count} lines, the list ${Math.round(m.height)} px tall, its content ${Math.round(m.content)} px, scrolled ${Math.round(m.offset)} px.`);
    }, UNDRAWN_MS);
    return () => clearTimeout(id);
  }, [some]);
}

/**
 * The main thread, following its newest line while the reader is at the
 * bottom, with a way back down when they have scrolled up. Memoized: typing in
 * the composer does not render it again.
 */
export const MainTranscript = memo(function MainTranscript({ transcript, status, streaming, waitingCause, error, onOpen, hidden, sent, more }: {
  transcript: TranscriptEntry[];
  status: TurnStatus;
  streaming: string;
  waitingCause: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  hidden: boolean;
  /** Counts the reader's sends; each one snaps the thread to its newest line. */
  sent?: number;
  /** Reads the entries before the ones held; absent when the session is held whole. */
  more?: () => void;
}) {
  const t = useTheme();
  // The app has no extension cards, so an extension's card entry is left out of the timeline.
  const askedIds = useAsked();
  const items = useMemo(() => mainTimeline(transcript, status, (e) => e.kind !== "card", askedIds), [transcript, status, askedIds]);
  const from = useContext(TranscriptFromContext);
  // A page read in front of the held entries is not a new line below.
  const follow = useFollow(`${from + transcript.length}:${streaming.length}:${status}`, sent);
  const waiting = status === "waiting";
  const asked = askedIds.size;
  const rows = useMemo<ThreadRow[]>(
    () =>
      items.map((item, i) => {
        // Keyed by the entry's place in the transcript, so a page read in front keeps every row as it was.
        const place = (e: TranscriptEntry) => {
          const p = positionIn(transcript, e);
          return p < 0 ? `i${i}` : String(from + p);
        };
        if (item.kind === "entry") {
          const p = positionIn(transcript, item.entry);
          return entryRow(`e${place(item.entry)}`, item.entry, p < 0 ? undefined : from + p);
        }
        if (item.kind === "progress") return { key: `p${place(item.entries[0])}`, render: () => <ProgressFold entries={item.entries} /> };
        // Keyed by its first call, so a fold stays open while the turn streams more steps into it.
        if (item.kind === "steps") return { key: `s${item.calls[0].id}`, render: () => <StepsFold calls={item.calls} /> };
        return { key: `a${item.calls[0].id}`, render: () => <AgentGroup calls={item.calls} transcript={transcript} sessionWaiting={waiting} onOpen={onOpen} /> };
      }),
    [items, transcript, waiting, onOpen, from],
  );
  // The streaming reply is the newest line, cut into pieces as it grows.
  const drawn = useMemo(() => (streaming ? [...rows, streamRow(streaming)] : rows), [rows, streaming]);
  const foot =
    asked > 0 || waiting || (status === "error" && error) ? (
      <>
        {asked > 0 ? <Banner kind="warn" role="status">{`Waiting on you: ${asked === 1 ? "a call needs" : `${asked} calls need`} your approval below.`}</Banner> : null}
        {waiting ? <Banner kind="warn">{`Waiting for editor: ${waitingCause ?? "not connected"}. The turn continues when it is back.`}</Banner> : null}
        {status === "error" && error ? <Banner kind="bad">{error}</Banner> : null}
      </>
    ) : null;
  return (
    <>
      <Column follow={follow} hidden={hidden} rows={drawn} foot={foot} more={more} />
      {follow.behind ? <JumpLatest onPress={follow.jump} /> : null}
    </>
  );
});

/** A fold or group header: a bare button of dim 12px text (`.fold-toggle.dim.small`, `.agent-group-head`). */
function foldText(t: Theme): TextStyle {
  return t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 12, 1.2), letterSpacing: 0.24 };
}

/** The main agent's progress messages from a finished turn, folded behind its final answer. */
export function ProgressFold({ entries }: { entries: TranscriptEntry[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 44, minWidth: 44, paddingVertical: 3, paddingHorizontal: 8, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}
      >
        <Text style={[foldText(t), { color: t.c.dim, width: 10 }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[foldText(t), { color: t.c.dim }]}>{`${entries.length} progress ${entries.length === 1 ? "update" : "updates"}`}</Text>
      </Pressable>
      {open ? entries.map((e, i) => <Entry key={i} entry={e} />) : null}
    </View>
  );
}

/**
 * A run of working steps as one line: what they did ("Read 9 files, ran 2
 * commands"), and while one runs, that step under it. Tapped, every call in the run.
 */
export function StepsFold({ calls }: { calls: Call[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const live = liveStep(calls);
  const summary = stepsSummary(calls);
  // .steps-head: 12px/1.6 mono; the editor themes' button rule outranks it with 12px/1.2 sans.
  const mono = t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "mono", 400, 12, 1.6);
  const dot = <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.accent }} />;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={live ? `${summary}. Now: ${TOOL_TAG[live.name] ?? live.name} ${toolLabel(live)}` : summary}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({ alignSelf: "flex-start", maxWidth: "100%", minHeight: 44, minWidth: 44, justifyContent: "center", gap: 2, paddingVertical: 3, paddingRight: 8, paddingLeft: 2, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text style={[mono, { color: t.c.muted, width: 10 }]}>{open ? "▾" : "▸"}</Text>
          <Text style={[mono, { color: t.c.muted, flexShrink: 1 }]}>{summary}</Text>
        </View>
        {live ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 18, minWidth: 0 }}>
            <Pulse>{dot}</Pulse>
            <Text style={[mono, { color: t.c.accentHi, flexShrink: 0 }]}>{TOOL_TAG[live.name] ?? live.name}</Text>
            <Text style={[mono, { color: t.c.text, flexShrink: 1, minWidth: 0 }]} numberOfLines={1} ellipsizeMode="tail">{toolLabel(live)}</Text>
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ marginLeft: 6, paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: t.c.line }}>
          {calls.map((c) => <ToolCall key={c.id} call={c} />)}
        </View>
      ) : null}
    </View>
  );
}

/** Groups larger than this start collapsed once every subagent in them has finished. */
export const GROUP_OPEN_MAX = 3;

/** Subagents the main agent started together: one header, and a row per subagent. */
export function AgentGroup({ calls, transcript, sessionWaiting, onOpen }: {
  calls: Call[];
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  onOpen: (id: string) => void;
}) {
  const t = useTheme();
  const now = useNow(calls.some((c) => c.outcome === "pending"));
  const asked = useAsked();
  const rows = calls.map((c) => ({ call: c, ...agentStatus(c, transcript, sessionWaiting, now, asked) }));
  const running = rows.some((r) => isActive(r.state));
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (running || calls.length <= GROUP_OPEN_MAX);
  if (calls.length === 1) return <AgentLink row={rows[0]} transcript={transcript} onOpen={onOpen} />;
  // .agent-group-head: 12px/1.6 mono with the button's 0.02em; the editor themes' button rule outranks it with 12px/1.2 sans.
  const role = t.editor ? "sans" : "mono";
  const lh = t.editor ? 1.2 : 1.6;
  const head: TextStyle = { ...font(t, role, 400, 12, lh), letterSpacing: t.editor ? 0 : 0.24 };
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setToggled(!open)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, minWidth: 44, paddingVertical: 4, paddingHorizontal: 6, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}
      >
        <Text style={[head, { color: t.c.muted, width: 10 }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[head, font(t, role, 600, 12, lh), { color: t.c.text }]}>{`${calls.length} subagents`}</Text>
        <Text style={[head, { color: t.c.dim, flexShrink: 1 }]}>{summarize(rows.map((r) => r.state))}</Text>
      </Pressable>
      {open ? rows.map((r) => <View key={r.call.id} style={{ marginLeft: 16 }}><AgentLink row={r} transcript={transcript} onOpen={onOpen} /></View>) : null}
    </View>
  );
}

type Row = { call: Call } & ReturnType<typeof agentStatus>;

/** A subagent state's dot and label colours (.state-* .agents-dot and .agents-state). */
export function stateColors(t: Theme, state: AgentState): { dot: string; label: string } {
  switch (state) {
    case "working":
      return { dot: t.c.accent, label: t.c.accentHi };
    case "waiting":
    case "approval":
      return { dot: t.c.warn, label: t.c.warn };
    case "unknown":
      return { dot: t.c.warn, label: t.c.warn };
    case "done":
      return { dot: t.c.ok, label: t.c.ok };
    case "failed":
      return { dot: t.c.bad, label: t.c.bad };
    default:
      return { dot: t.c.muted, label: t.c.muted };
  }
}

/** A subagent state's dot: 6px, pulsing while it works or waits. */
export function StateDot({ state, size = 6 }: { state: AgentState; size?: number }) {
  const t = useTheme();
  const dot = <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: stateColors(t, state).dot }} />;
  const pulse = state === "working" ? 1200 : state === "waiting" || state === "approval" ? 2000 : 0;
  return pulse ? <Pulse period={pulse}>{dot}</Pulse> : dot;
}

/**
 * In the main thread, a subagent is one row that opens its thread: on a phone
 * its dot, name, state and Open thread on the first line, its title on its own
 * line under them, and its activity under that.
 */
function AgentLink({ row, transcript, onOpen }: { row: Row; transcript: TranscriptEntry[]; onOpen: (id: string) => void }) {
  const t = useTheme();
  const calls = callsIn(transcript, row.call.id);
  // .tool's 12px/1.6 mono with the button's 0.02em; the editor themes' button rule outranks it with 12px/1.2 sans.
  const lh = t.editor ? 1.2 : 1.6;
  const role = t.editor ? "sans" : "mono";
  const text: TextStyle = { ...font(t, role, 400, 12, lh), letterSpacing: t.editor ? 0 : 0.24 };
  const colors = stateColors(t, row.state);
  const meta = `${row.activity ? `${row.activity}, ` : ""}${calls} ${calls === 1 ? "call" : "calls"}, ${formatDuration(row.secs)}`;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onOpen(row.call.id)}
      style={({ pressed }) => ({ minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, gap: 4, borderWidth: 1, borderColor: pressed ? t.c.accentLine : t.c.line, borderRadius: 8 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StateDot state={row.state} />
        <Text style={[text, font(t, role, 600, 12, lh), { color: t.c.text }]}>subagent</Text>
        <Text style={[text, { fontSize: 11, lineHeight: lineBox(11, lh), color: colors.label }]}>{STATE_LABEL[row.state]}</Text>
        <View style={{ flex: 1 }} />
        <View style={{ paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: t.radius }}>
          <Text style={[text, { color: t.c.accentHi }]}>{"Open thread ›"}</Text>
        </View>
      </View>
      <Text style={[text, { color: t.c.text, marginLeft: 14 }]}>{describe(row.call)}</Text>
      <Text style={[text, { color: t.c.dim, marginLeft: 14 }]}>{meta}</Text>
    </Pressable>
  );
}

/**
 * A subagent's own thread: the task it was given, its steps, and what it
 * reported back. On a phone the header (back, name, state, Stop) is the
 * conversation's own, so the thread is the column alone.
 */
export function SubagentThread({ call, transcript, sessionWaiting: _sessionWaiting, onBack: _onBack, onStop: _onStop }: {
  call: Call;
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  onBack: () => void;
  onStop: (id: string) => void;
}) {
  const t = useTheme();
  const prompt = (call.input as { prompt?: string }).prompt;
  const steps = useMemo(() => transcript.filter((e) => e.parent === call.id), [transcript, call.id]);
  const asked = useAsked();
  const follow = useFollow(`${steps.length}:${call.outcome}`);
  const from = useContext(TranscriptFromContext);
  const rows = useMemo<ThreadRow[]>(
    () => foldSteps(steps, asked).map((item) => {
      if (item.kind === "steps") return { key: `f${item.calls[0].id}`, render: () => <StepsFold calls={item.calls} /> };
      const p = positionIn(transcript, item.entry);
      return entryRow(`s${steps.indexOf(item.entry)}`, item.entry, p < 0 ? undefined : from + p);
    }),
    [steps, asked, transcript, from],
  );
  const ended =
    call.outcome === "done" ? <Text style={small(t, t.c.dim)}>Reported back to the main agent.</Text>
      : call.outcome === "stopped" ? <Text style={small(t, t.c.dim)}>Stopped. The main agent was told.</Text>
      : (call.outcome === "error" || call.outcome === "unknown") && call.result ? <Banner kind="bad">{call.result}</Banner>
      : null;
  return (
    <>
      <Column key={call.id} follow={follow} rows={rows} head={prompt ? <TaskMessage prompt={prompt} /> : null} foot={ended} />
      {follow.behind ? <JumpLatest onPress={follow.jump} /> : null}
    </>
  );
}

/** The task a subagent was given, as the user's bubble with its eyebrow. */
function TaskMessage({ prompt }: { prompt: string }) {
  const t = useTheme();
  const width = useContext(WidthContext);
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: Math.min(width * 0.92, width - 52), backgroundColor: t.c.accentWash, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 13 }}>
      <Text style={labelFont(t)}>Task from the main agent</Text>
      <Text style={baseFont(t)} selectable>{prompt}</Text>
    </View>
  );
}

/** How many lines of a written file the transcript shows. */
const WRITE_PREVIEW_LINES = 40;

/** How a call's input reads when opened: the command, the change as a diff, or the input itself. */
function CallInput({ call, links, maxHeight }: { call: Call; links: boolean; maxHeight: number }) {
  const t = useTheme();
  const i = call.input as { command?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
  const path = callPath(call);
  const indent = { marginTop: 6, marginLeft: 14 };
  if (call.name === "shell") return <Output maxHeight={maxHeight} style={indent} color={t.c.text}>{`$ ${i.command ?? ""}`}</Output>;
  if (call.name === "edit_file") {
    return (
      <>
        {i.replace_all ? <Text style={[small(t, t.c.dim), font(t, "mono", 400, 12), { lineHeight: lineBox(12, 1.6) }, indent]}>every occurrence</Text> : null}
        <DiffView lines={lineDiff(i.old_string ?? "", i.new_string ?? "")} label={`Edit to ${path}`} maxHeight={maxHeight} style={indent} />
      </>
    );
  }
  if (call.name === "write_file") {
    const lines = (i.content ?? "").split("\n");
    const shown = lines.slice(0, WRITE_PREVIEW_LINES).map((text) => ({ op: "+" as const, text }));
    return <DiffView lines={lines.length > WRITE_PREVIEW_LINES ? [...shown, { op: "gap", count: lines.length - WRITE_PREVIEW_LINES }] : shown} label={`Content of ${path}`} maxHeight={maxHeight} style={indent} />;
  }
  if (call.name === "web_search" || call.name === "read_file" || call.name === "glob" || call.name === "grep" || call.name === "web_fetch") return null;
  const json = JSON.stringify(call.input, null, 2);
  return <Output maxHeight={maxHeight} style={indent}>{links ? <LinkedText text={json} /> : json}</Output>;
}

/** The images a call showed the model, as thumbnails. Shown with the call closed or open. */
function ShownImages({ files }: { files: Attachment[] }) {
  const t = useTheme();
  const sessionId = useContext(SessionIdContext);
  if (!sessionId) return null;
  return (
    <View accessibilityLabel="Images the model saw" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4, marginBottom: 2, marginLeft: 16 }}>
      {files.map((f) => (
        <View key={f.id} accessibilityLabel={`${f.name}, ${formatBytes(f.size)}, as the model saw it`} style={{ borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 6, overflow: "hidden", backgroundColor: t.c.panel2 }}>
          <DaemonImage path={attachmentUrl(sessionId, f.id)} type={f.type} alt={f.name} maxWidth={240} maxHeight={150} />
        </View>
      ))}
    </View>
  );
}

/** The full result of a call whose long result the session left out, once it is opened; null until then. */
function useLazyResult(call: Call, open: boolean): string | null {
  const sessionId = useContext(SessionIdContext);
  const { api } = useProjectNav();
  const [fetched, setFetched] = useState<{ id: string; text: string } | null>(null);
  const want = open && call.result === undefined && call.resultSize !== undefined && !!sessionId && fetched?.id !== call.id;
  useEffect(() => {
    if (!want || !sessionId) return;
    let alive = true;
    api.callResult(sessionId, call.id).then(
      (r) => alive && setFetched({ id: call.id, text: r.result }),
      (e: Error) => alive && setFetched({ id: call.id, text: `Could not load the result: ${e.message}` }),
    );
    return () => {
      alive = false;
    };
  }, [want, sessionId, call.id, api]);
  return fetched?.id === call.id ? fetched.text : null;
}

/** A tool call's dot colour by outcome (.tool.<outcome> summary::before). */
function outcomeDot(t: Theme, outcome: Call["outcome"]): string {
  return outcome === "done" ? t.c.ok : outcome === "error" ? t.c.bad : outcome === "unknown" ? t.c.warn : outcome === "declined" || outcome === "stopped" ? t.c.dim : t.c.accent;
}

/** A tool call: its label and outcome; open, its input and its result, long results shortened. */
export function ToolCall({ call }: { call: Call }) {
  const t = useTheme();
  const vh = useWindowDimensions().height;
  const label = useMemo(() => toolLabel(call), [call]);
  const title = useMemo(() => toolTitle(call), [call]);
  // Paths in the input and result become links only while the call is open.
  const [open, setOpen] = useState(false);
  // A long press shows the line with its paths in full, as hover does on the web.
  const [full, setFull] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  // A long result was left out of the session: fetched the first time the call is opened.
  const fetched = useLazyResult(call, open);
  const text = call.result ?? fetched ?? undefined;
  // A machine tool's result is text as it came; ue-mcp's is JSON, indented.
  const result = useMemo(() => (text ? (call.name === "ue_mcp" ? formatResult(text) : { text, lines: text.split("\n").length }) : null), [call.name, text]);
  const shown = result && !all && result.lines > RESULT_PREVIEW_LINES ? result.text.split("\n").slice(0, RESULT_PREVIEW_LINES).join("\n") : result?.text;
  const copy = () => {
    if (!result) return;
    void copyText(result.text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const mono = font(t, "mono", 400, 12, 1.6);
  const tag = TOOL_TAG[call.name] ?? call.name;
  const dot = <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: outcomeDot(t, call.outcome) }} />;
  const outputMax = vh * 0.6;
  const details = (
    <View style={{ paddingHorizontal: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityHint={title !== label ? title : undefined}
        onPress={() => setOpen(!open)}
        onLongPress={() => setFull(!full)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, minWidth: 0 }}
      >
        {call.outcome === "pending" ? <Pulse>{dot}</Pulse> : dot}
        <Text style={[mono, { color: t.c.accentHi, flexShrink: 0 }]}>{tag}</Text>
        <Text style={[mono, { color: t.c.text, flexShrink: 1, minWidth: 0 }]} numberOfLines={1} ellipsizeMode="tail">{label}</Text>
        <Text style={[mono, { color: t.c.dim, flexShrink: 0 }]}>{OUTCOME_LABEL[call.outcome]}</Text>
      </Pressable>
      {full && title !== label ? <Text selectable style={[mono, { color: t.c.muted, marginLeft: 14, marginBottom: 4 }]}>{title}</Text> : null}
      {open ? (
        <>
          <CallInput call={call} links={open} maxHeight={outputMax} />
          {!result && call.resultSize !== undefined ? <Text accessibilityLiveRegion="polite" style={[mono, { color: t.c.dim, marginTop: 6, marginLeft: 14 }]}>{`Loading the result, ${formatBytes(call.resultSize)}`}</Text> : null}
          {result ? (
            <View style={{ marginTop: 6, marginLeft: 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[mono, { color: t.c.dim }]}>{`${call.name === "shell" ? "Output" : "Result"}, ${result.lines} ${result.lines === 1 ? "line" : "lines"}`}</Text>
                <ContentButton kind="ghost" small fontSize={12} title={copied ? "Copied" : "Copy"} onPress={copy} />
              </View>
              <Output maxHeight={outputMax} style={{ marginTop: 2, marginBottom: 4 }}>{shown ? <LinkedText text={shown} /> : shown}</Output>
              {result.lines > RESULT_PREVIEW_LINES ? (
                <View style={{ alignItems: "flex-start" }}>
                  <ContentButton kind="ghost" small fontSize={12} title={all ? "Show less" : `Show all ${result.lines} lines`} onPress={() => setAll(!all)} />
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
  // A closed call hides what is inside it; the images it showed stay in view under it.
  if (!call.images?.length) return details;
  return (
    <View>
      {details}
      <ShownImages files={call.images} />
    </View>
  );
}
