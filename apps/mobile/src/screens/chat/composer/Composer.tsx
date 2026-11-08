/**
 * The web client's chat/Composer.tsx as native views: the message box with its
 * resize handle, the files and mentions it carries, the slash and @-mention
 * menus over it, and the bar with the model, Attach, and Send, Queue or Stop.
 * styles.css: .composer, .composer-divider, .composer-grip, .attach-*,
 * .composer-bar, at a phone's width and coarse pointer.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, PanResponder, Platform, Pressable, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent, type TextInputInstance, type TextInputKeyPressEvent, type TextStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, clampHeight, extOf, fitHeight, formatBytes } from "@ue-mcp-studio/client-core";
import type { ActionListing, FlowListing, SlashCommand } from "@ue-mcp-studio/shared";
import { Button, font, RemoveButton, Sheet, useAvoidedInsets, useStyles, useTheme, type Theme } from "../../../ui";
import { haptic } from "../../../native/haptics";
import { useKeyboardHeight } from "../../../native/keyboard";
import { clipboardHasImage, pastedImage, pickFiles, type PendingFile, type PickSource, type PickedFile } from "./attachments";
import { useSlashMenu, type MenuKey } from "./SlashMenu";
import { MentionChips, useMentionMenu, type MentionSearchFn } from "./MentionMenu";
import { BarTierContext, atMost, barTier, useBarTier, type BarTier } from "./barTier";

export { MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, clampHeight, fitHeight };

/** Two taps on the handle this close together forget the dragged height, as a double click does on the web. */
const DOUBLE_TAP_MS = 300;
/** The box's line: 16px text at 1.5. */
const LINE = 24;
/** The box's padding (8 top and bottom) and border (1 each side). */
const CHROME = 18;
const BORDER = 2;
/**
 * The composer's height less the box's with nothing attached: its border and
 * padding (1 + 12 + 10), the shell's (2 + 12), the gap and the 44 dp bar. The
 * safe-area bottom comes on top. Used until the composer has been laid out.
 */
export const COMPOSER_CHROME = 1 + 12 + 10 + 2 + 12 + 4 + 44;

/**
 * The tallest the box may get: the height the transcript and the composer
 * share (`space`), less the transcript's least height and everything of the
 * composer that is not the box. Never below MIN_HEIGHT.
 */
export function composerRoom({ space, chrome }: { space: number | null | undefined; chrome: number }): number {
  return space == null ? Infinity : Math.max(MIN_HEIGHT, Math.floor(space - MIN_TRANSCRIPT - chrome));
}

/**
 * Where the user writes: the text, the files added to it, and the bar with the
 * model picker and Send or Stop. Return sends; while a turn runs it queues the
 * message behind it, and Ctrl+Enter on a hardware keyboard stops the turn and
 * sends the message now.
 *
 * The text box sizes itself to what is written, up to the room `space` leaves
 * once the transcript keeps MIN_TRANSCRIPT and the bar keeps its row, then
 * scrolls inside that height. The handle above it drags the box taller or
 * shorter within the same room; the dragged height is a minimum the content
 * can still grow past. A double tap on the handle forgets it. `height` is the
 * saved one, `onHeight` saves.
 */
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onSendNow, onStop, files, onAddFiles, onRemoveFile, picker, extras, space, height, onHeight, commands, flows, actions, mentions, children }: {
  draft: string;
  onDraft: (text: string) => void;
  onBlur: () => void;
  placeholder: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  /** While a turn runs: Return. Without it, the box is closed while a turn runs. */
  onQueue?: () => void;
  /** While a turn runs: Ctrl+Enter, stop it and send now. */
  onSendNow?: () => void;
  onStop: () => void;
  files: PendingFile[];
  /** Files picked with Attach, or handed in from outside (a share to the app). */
  onAddFiles: (files: PickedFile[]) => void;
  onRemoveFile: (key: string) => void;
  picker: ReactNode;
  /** More bar controls, after Attach: the composer.action slot. */
  extras?: ReactNode;
  /**
   * The height the transcript and the composer share: below the header, above
   * the keyboard, less the cards between them. Until it is measured, only
   * MAX_LINES caps the box.
   */
  space?: number | null;
  height?: number | null;
  onHeight?: (h: number | null) => void;
  /** The slash commands the menu offers; the registry's when not given. */
  commands?: readonly SlashCommand[];
  /** The project's flows, for the names /flow completes. Fetched when the menu offers them; stable across renders. */
  flows?: () => Promise<FlowListing[]>;
  /** ue-mcp's actions, for the names /action completes. Fetched when the menu offers them; stable across renders. */
  actions?: () => Promise<ActionListing[]>;
  /** Looks names up for an @-mention; without it, @ is plain text. */
  mentions?: MentionSearchFn;
  children?: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  // A tap is felt on send, queue and send now; a warning on stop.
  const send = () => {
    haptic.tap();
    onSend();
  };
  const queue = onQueue && (() => {
    haptic.tap();
    onQueue();
  });
  const sendNow = onSendNow && (() => {
    haptic.tap();
    onSendNow();
  });
  const stop = () => {
    haptic.warning();
    onStop();
  };
  // Above the navigation bar; with the keyboard up, the chat's KeyboardAvoidingView has lifted it onto the keys instead.
  const insets = useAvoidedInsets();
  // With the keyboard up the box starts at its least and grows with the text: the dragged height waits until it is down.
  const keyboardUp = useKeyboardHeight() > 0;
  const box = useRef<TextInputInstance>(null);
  const slash = useSlashMenu(draft, onDraft, commands, flows, actions);
  const mention = useMentionMenu(draft, onDraft, box, mentions);
  const [floor, setFloor] = useState<number | null>(height ?? null);
  const [dragging, setDragging] = useState(false);
  const [handleFocus, setHandleFocus] = useState(false);
  const [focused, setFocused] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [canPaste, setCanPaste] = useState(false);
  const window = useWindowDimensions();
  const openAttach = () => {
    setAttachError(null);
    setAttachOpen(true);
    void clipboardHasImage().then(setCanPaste);
  };
  const take = (from: PickSource | "paste") => {
    setAttachOpen(false);
    const got = from === "paste" ? pastedImage() : pickFiles(from);
    void got.then((picked) => picked.length && onAddFiles(picked), (e: Error) => {
      setAttachError(e.message);
      setAttachOpen(true);
    });
  };
  useEffect(() => setFloor(height ?? null), [height]);

  /** The text's height as the hidden mirror lays it out: the RN form of the web client's mirror textarea. */
  const [content, setContent] = useState<number | null>(null);
  const [boxHeight, setBoxHeight] = useState<number>(MIN_HEIGHT);
  const current = () => boxHeight || MIN_HEIGHT;
  /** The composer's laid-out height and the box's, for the part of the composer that is not the box. */
  const [outer, setOuter] = useState(0);
  const [laidBox, setLaidBox] = useState(0);
  const chrome = Math.max(COMPOSER_CHROME + insets.bottom, outer > 0 && laidBox > 0 ? Math.round(outer - laidBox) : 0);
  const cap = composerRoom({ space, chrome });
  const room = () => cap;
  const fit = fitHeight({ content: content ?? MIN_HEIGHT, line: LINE, chrome: CHROME, floor: keyboardUp ? null : floor, room: room() });
  useEffect(() => {
    if (fit.height !== boxHeight) setBoxHeight(fit.height);
  }, [fit.height]);

  /** The bar's tier, from its own width, in ems of its font. */
  const [tier, setTier] = useState<BarTier>("full");
  const onBar = (e: LayoutChangeEvent) => setTier(barTier(e.nativeEvent.layout.width, t.base.size));

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);
  const save = (h: number | null, later = false) => {
    setFloor(h);
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    if (later) pending.current = setTimeout(() => {
      pending.current = null;
      onHeight?.(h);
    }, NUDGE_SAVE_MS);
    else onHeight?.(h);
  };

  // The drag: a finger, a pen or a mouse; the responder keeps it while it moves off the handle.
  const live = useRef({ floor, current, room, save });
  live.current = { floor, current, room, save };
  const lastTap = useRef(0);
  const pan = useMemo(() => {
    let startH = 0;
    let r = Infinity;
    let last: number | null = null;
    let moved = false;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        startH = live.current.current();
        r = live.current.room();
        last = live.current.floor;
        moved = false;
        setDragging(true);
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dy) < 2 && !moved) return;
        moved = true;
        last = clampHeight(startH - g.dy, r);
        setFloor(last);
      },
      onPanResponderRelease: () => {
        setDragging(false);
        if (!moved) {
          const now = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            live.current.save(null);
          } else lastTap.current = now;
          return;
        }
        if (last !== live.current.floor) live.current.save(last);
      },
      onPanResponderTerminate: () => setDragging(false),
    });
  }, []);
  const nudge = (step: number) => save(clampHeight((floor ?? current()) + step, room()), true);
  const nudgeKey = (key: string): boolean => {
    // Home forgets the dragged height, as a double tap does.
    if (key === "Home") {
      save(null);
      return true;
    }
    const step = key === "ArrowUp" ? NUDGE : key === "ArrowDown" ? -NUDGE : 0;
    if (!step) return false;
    nudge(step);
    return true;
  };

  const key = (k: MenuKey): boolean => {
    if (slash.keyDown(k)) return true;
    if (!slash.open && mention.keyDown(k)) return true;
    return false;
  };
  // On a phone the keyboard's Enter is a new line and the send button sends. On the web Enter sends, Shift+Enter is a new line.
  const onKeyPress = (e: TextInputKeyPressEvent) => {
    const n = e.nativeEvent as typeof e.nativeEvent & { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    const ev = { key: n.key, shiftKey: !!n.shiftKey, ctrlKey: !!n.ctrlKey, metaKey: !!n.metaKey };
    if (ev.key === "Enter" && (Platform.OS !== "web" || ev.shiftKey)) return;
    if (key(ev)) return e.preventDefault?.();
    if (ev.key !== "Enter") return;
    e.preventDefault?.();
    if (!canSend) return;
    if (!busy) send();
    else if (ev.ctrlKey || ev.metaKey) sendNow?.();
    else queue?.();
  };

  const closed = busy && !onQueue;
  const active = dragging || handleFocus;
  const menu = slash.menu ?? mention.menu;
  const mirrorText = (draft || placeholder) + (/\n$/.test(draft) ? "​" : "");
  const textFont: TextStyle = { ...font(t, "sans", 400, 16), lineHeight: LINE };

  return (
    <>
      <View testID="composer" onLayout={(e) => setOuter(e.nativeEvent.layout.height)} style={[s.composer, { paddingBottom: 10 + insets.bottom, paddingLeft: 10 + insets.left, paddingRight: 10 + insets.right }]}>
        <View
          style={s.divider}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Resize the message box"
          accessibilityHint="Drag to resize, double-tap to reset"
          accessibilityValue={{ min: MIN_HEIGHT, max: Number.isFinite(cap) ? cap : undefined, now: floor ?? undefined }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "activate" }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "increment") nudge(NUDGE);
            else if (e.nativeEvent.actionName === "decrement") nudge(-NUDGE);
            else if (e.nativeEvent.actionName === "activate") save(null);
          }}
          focusable
          onFocus={() => setHandleFocus(true)}
          onBlur={() => setHandleFocus(false)}
          {...({ onKeyDown: (e: { key: string; preventDefault: () => void }) => nudgeKey(e.key) && e.preventDefault() } as object)}
          {...pan.panHandlers}
        >
          <View style={[s.dividerLine, active && { backgroundColor: t.c.accent }]} />
          <View style={[s.grip, active && { backgroundColor: t.c.accent }]} />
        </View>
        <View testID="composer-shell" style={[s.shell, focused && s.shellFocus]}>
        {files.length > 0 && (
          <View style={s.attachList} accessibilityLabel="Attached files">
            {files.map((f) => (
              <View key={f.key} style={[s.attachChip, f.state === "uploading" && { opacity: 0.7 }, f.state === "error" && { borderColor: t.c.bad }]} accessibilityHint={f.error ?? f.name}>
                {f.preview ? <Image source={{ uri: f.preview }} style={s.attachImg} /> : <View style={s.attachExt}><Text style={s.attachExtText}>{extOf(f.name)}</Text></View>}
                <Text style={s.attachName} numberOfLines={1}>{f.name}</Text>
                <Text style={[s.attachSize, f.state === "error" && { color: t.c.bad }]} numberOfLines={1}>{f.state === "uploading" ? "adding" : f.state === "error" ? f.error : formatBytes(f.size)}</Text>
                <RemoveButton label={`Remove ${f.name}`} onPress={() => onRemoveFile(f.key)} />
              </View>
            ))}
          </View>
        )}
        {mentions && <MentionChips draft={draft} onDraft={onDraft} />}
        {/* The mirror: the text laid out at the box's width, measured instead of the box. */}
        <View pointerEvents="none" style={[s.mirror, { left: 10 + insets.left + SHELL_INSET, right: 10 + insets.right + SHELL_INSET }]} aria-hidden importantForAccessibility="no-hide-descendants">
          <Text style={[textFont, s.mirrorText]} onLayout={(e) => setContent(Math.round(e.nativeEvent.layout.height) + BORDER)}>{mirrorText}</Text>
        </View>
        {menu}
        <TextInput
          ref={box}
          multiline
          value={draft}
          placeholder={placeholder}
          placeholderTextColor={t.c.dim}
          selectionColor={t.c.selection}
          cursorColor={t.c.accent}
          editable={!closed}
          scrollEnabled={fit.scroll}
          selection={mention.selection}
          onChangeText={onDraft}
          onSelectionChange={(e) => mention.track(e.nativeEvent.selection)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            mention.blur();
            onBlur();
          }}
          onKeyPress={onKeyPress}
          {...(slash.open ? slash.a11y : mention.a11y)}
          onLayout={(e) => setLaidBox(e.nativeEvent.layout.height)}
          style={[s.box, textFont, { height: fit.height }, closed && { color: t.c.dim }]}
        />
        {/* One row: attach, the model and effort, the context ring; Send or Stop last, never shrinking. */}
        <View style={s.bar} onLayout={onBar}>
          <RoundButton label="Attach" hint="Attach files" disabled={closed} onPress={openAttach}>
            <PlusGlyph color={closed ? t.c.dim : t.c.text} />
          </RoundButton>
          <BarTierContext.Provider value={tier}>
            {picker}
            {extras}
          </BarTierContext.Provider>
          <View style={s.spacer} />
          {/* A phone has no keyboard shortcuts to hint at: the hint is for a tablet's width, with a hardware keyboard. */}
          {onQueue && tier === "full" && window.width > 760 && <Text style={s.hint} numberOfLines={1}>{busy ? "Enter to queue, Ctrl+Enter to stop and send now" : "Enter to send, Shift+Enter for a new line"}</Text>}
          {busy && onQueue && <Button title="Queue" label="Queue" hint="Send after the running turn completes. A stopped or failed turn holds the queue." disabled={!canSend} onPress={queue} style={{ borderRadius: 22 }} />}
          {busy ? (
            <RoundButton label="Stop" kind="stop" onPress={stop}>
              <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: t.c.bad }} />
            </RoundButton>
          ) : (
            <RoundButton label="Send" kind="send" disabled={!canSend} onPress={send}>
              <ArrowUpGlyph color={canSend ? t.c.onAccent : t.c.dim} />
            </RoundButton>
          )}
        </View>
        </View>
        {children}
      </View>
      <Sheet open={attachOpen} title="Attach" onClose={() => setAttachOpen(false)}>
        <View style={{ gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
          {attachError ? <Text role="alert" style={s.attachError}>{attachError}</Text> : null}
          <Button title="Photos" label="Attach photos" onPress={() => take("images")} />
          <Button title="Camera" label="Take a photo" onPress={() => take("camera")} />
          <Button title="Files" label="Attach files" onPress={() => take("files")} />
          {canPaste ? <Button title="Paste image" label="Paste the copied image" onPress={() => take("paste")} /> : null}
        </View>
      </Sheet>
    </>
  );
}

/** The shell's border and padding: how far in from the composer's edge the box's text starts, for the mirror that measures it. */
const SHELL_INSET = 1 + 6;

/** A round 44 dp button of the composer row: attach, Send in the accent, Stop. */
function RoundButton({ label, hint, kind = "plain", disabled, onPress, children }: { label: string; hint?: string; kind?: "plain" | "send" | "stop"; disabled?: boolean; onPress: () => void; children: ReactNode }) {
  const t = useTheme();
  const bg = kind === "send" && !disabled ? t.c.accent : t.c.panel3;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: bg, borderWidth: 1, borderColor: kind === "stop" ? t.c.bad : pressed ? t.c.lineStrong : "transparent", opacity: pressed ? 0.85 : 1 })}
    >
      {children}
    </Pressable>
  );
}

function PlusGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <Path d="M9 3v12M3 9h12" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

function ArrowUpGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <Path d="M9 15V3M4 8l5-5 5 5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/**
 * A bar button that keeps its words while there is room and becomes an icon
 * when the bar narrows, still named by `label` for a screen reader.
 */
export function BarButton({ label, title, icon, disabled, onClick }: {
  label: string;
  title: string;
  icon: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const t = useTheme();
  const iconOnly = atMost("icons", useBarTier());
  return (
    <Button variant="ghost" label={label} disabled={disabled} onPress={onClick} style={[{ borderColor: "transparent", backgroundColor: "transparent" }, iconOnly && { width: 44, paddingHorizontal: 0, paddingVertical: 0 }]}>
      {iconOnly ? <GlyphColor color={disabled ? t.c.dim : t.c.muted}>{icon}</GlyphColor> : <Text accessibilityHint={title} style={[t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 }, { color: disabled ? t.c.dim : t.c.muted }]}>{label}</Text>}
    </Button>
  );
}

/** currentColor for a glyph: the colour the button's text would take. */
const GlyphColorContext = createContext<string | null>(null);
function GlyphColor({ color, children }: { color: string; children: ReactNode }) {
  return <GlyphColorContext.Provider value={color}>{children}</GlyphColorContext.Provider>;
}
function useGlyphColor(): string {
  const t = useTheme();
  return useContext(GlyphColorContext) ?? t.c.muted;
}

/** Checkpoints: a flag on a pole. */
export function CheckpointsGlyph() {
  const color = useGlyphColor();
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3 2 3H3.5" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = (t: Theme) => ({
  composer: { position: "relative" as const, flexDirection: "column" as const, alignItems: "stretch" as const, gap: 8, borderTopWidth: 1, borderTopColor: t.c.line, paddingTop: 12, backgroundColor: t.c.composerBg },
  divider: { position: "absolute" as const, left: 0, right: 0, top: -32, height: 44, zIndex: 2, outlineStyle: "none" as never },
  dividerLine: { position: "absolute" as const, left: 0, right: 0, top: 31, height: 2, backgroundColor: "transparent" },
  grip: { position: "absolute" as const, left: "50%" as const, top: 36.5, width: 36, height: 3, marginLeft: -18, borderRadius: 2, backgroundColor: t.c.dim },
  attachList: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
  attachChip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, maxWidth: 280, padding: 4, borderWidth: 1, borderColor: t.c.line, borderRadius: 8, backgroundColor: t.c.panel2 },
  attachImg: { width: 36, height: 36, borderRadius: 5 },
  attachExt: { width: 36, height: 36, borderRadius: 5, backgroundColor: t.c.panel3, alignItems: "center" as const, justifyContent: "center" as const },
  attachExtText: { ...font(t, "mono", 600, 10), color: t.c.muted },
  attachName: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.text, flexShrink: 1, minWidth: 0 },
  attachSize: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim, flexShrink: 0 },
  mirror: { position: "absolute" as const, top: 0, opacity: 0 },
  // A browser's textarea wraps its text a caret's width before its edge, and the web client's mirror is a textarea: the same 2 px here.
  mirrorText: { paddingVertical: 8, paddingLeft: 10, paddingRight: 10 + (Platform.OS === "web" ? 2 : 0) },
  shell: { gap: 4, padding: 6, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 22, backgroundColor: t.c.panel2 },
  shellFocus: { borderColor: t.c.accentLine },
  box: { width: "100%" as const, backgroundColor: "transparent", color: t.c.text, paddingVertical: 8, paddingHorizontal: 10, textAlignVertical: "top" as const, outlineStyle: "none" as never },
  bar: { flexDirection: "row" as const, flexWrap: "nowrap" as const, alignItems: "center" as const, gap: 6, minWidth: 0, position: "relative" as const },
  spacer: { flex: 1, minWidth: 0 },
  hint: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim, flexShrink: 1000, minWidth: 0, textAlign: "right" as const },
  attachError: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.badText },
});
