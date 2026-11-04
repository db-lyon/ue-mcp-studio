/**
 * The web client's chat/Composer.tsx as native views: the message box with its
 * resize handle, the files and mentions it carries, the slash and @-mention
 * menus over it, and the bar with the model, Attach, and Send, Queue or Stop.
 * styles.css: .composer, .composer-divider, .composer-grip, .attach-*,
 * .composer-bar, at a phone's width and coarse pointer.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Image, PanResponder, Platform, Text, TextInput, View, useWindowDimensions, type HostInstance, type LayoutChangeEvent, type TextInputInstance, type TextInputKeyPressEvent, type TextStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, clampHeight, extOf, fitHeight, formatBytes } from "@ue-mcp-studio/client-core";
import type { ActionListing, FlowListing, SlashCommand } from "@ue-mcp-studio/shared";
import { Button, font, RemoveButton, Sheet, useStyles, useTheme, type Theme } from "../../../ui";
import { useKeyboardOpen } from "./keyboard";
import { haptic } from "../../../native/haptics";
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
 * Where the user writes: the text, the files added to it, and the bar with the
 * model picker and Send or Stop. Return sends; while a turn runs it queues the
 * message behind it, and Ctrl+Enter on a hardware keyboard stops the turn and
 * sends the message now.
 *
 * The text box sizes itself to what is written. The handle above it drags the
 * box taller or shorter against `stage`, the transcript that gives up the room;
 * the dragged height is a minimum the content can still grow past. A double tap
 * on the handle forgets it. `height` is the saved one, `onHeight` saves.
 */
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onSendNow, onStop, files, onAddFiles, onRemoveFile, picker, extras, stage, height, onHeight, commands, flows, actions, mentions, children }: {
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
  /** The transcript that gives up the room the box is dragged into. */
  stage?: RefObject<HostInstance | null>;
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
  const insets = useSafeAreaInsets();
  // The chat's KeyboardAvoidingView lifts the whole composer; with the keyboard up, the home indicator's inset is under it.
  const keyboard = useKeyboardOpen();
  const bottomInset = keyboard ? 0 : insets.bottom;
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
  /** The transcript's height, read when the box is dragged and when it grows. */
  const stageHeight = useRef<number | null>(null);
  const readStage = () => stage?.current?.measure?.((_x: number, _y: number, _w: number, h: number) => {
    if (h > 0) stageHeight.current = h;
  });
  useEffect(() => {
    readStage();
  }, [stage, draft.length > 0]);
  const room = () => (stageHeight.current === null ? Infinity : current() + stageHeight.current - MIN_TRANSCRIPT);
  const fit = fitHeight({ content: content ?? MIN_HEIGHT, line: LINE, chrome: CHROME, floor, room: room() });
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
        readStage();
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

  /** Return's modifiers, from the key press that comes before the submit. */
  const enter = useRef({ shift: false, ctrl: false });
  const key = (k: MenuKey): boolean => {
    if (slash.keyDown(k)) return true;
    if (!slash.open && mention.keyDown(k)) return true;
    return false;
  };
  const submit = () => {
    const mods = enter.current;
    enter.current = { shift: false, ctrl: false };
    if (key({ key: "Enter", shiftKey: mods.shift, ctrlKey: mods.ctrl, metaKey: false })) return;
    if (!canSend) return;
    if (!busy) send();
    else if (mods.ctrl) sendNow?.();
    else queue?.();
  };
  const onKeyPress = (e: TextInputKeyPressEvent) => {
    const n = e.nativeEvent as typeof e.nativeEvent & { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    if (n.key === "Enter") {
      enter.current = { shift: !!n.shiftKey, ctrl: !!(n.ctrlKey || n.metaKey) };
      // react-native-web submits a multiline box only by blurring it: there Enter sends here, and Shift+Enter is a new line.
      if (Platform.OS === "web" && !n.shiftKey) {
        e.preventDefault?.();
        submit();
      }
      return;
    }
    if (key({ key: n.key, shiftKey: !!n.shiftKey, ctrlKey: !!n.ctrlKey, metaKey: !!n.metaKey })) e.preventDefault?.();
  };

  const closed = busy && !onQueue;
  const active = dragging || handleFocus;
  const menu = slash.menu ?? mention.menu;
  const mirrorText = (draft || placeholder) + (/\n$/.test(draft) ? "​" : "");
  const textFont: TextStyle = { ...font(t, "sans", 400, 16), lineHeight: LINE };

  return (
    <>
      <View style={[s.composer, { paddingBottom: Math.max(10, bottomInset), paddingLeft: Math.max(10, insets.left), paddingRight: Math.max(10, insets.right) }]}>
        <View
          style={s.divider}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Resize the message box"
          accessibilityHint="Drag to resize, double-tap to reset"
          accessibilityValue={{ min: MIN_HEIGHT, max: Number.isFinite(room()) ? Math.round(room()) : undefined, now: floor ?? undefined }}
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
        <View pointerEvents="none" style={[s.mirror, { left: Math.max(10, insets.left), right: Math.max(10, insets.right) }]} aria-hidden importantForAccessibility="no-hide-descendants">
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
          submitBehavior="submit"
          returnKeyType={busy ? "default" : "send"}
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
          onSubmitEditing={submit}
          {...(slash.open ? slash.a11y : mention.a11y)}
          style={[s.box, textFont, { height: fit.height }, focused && s.boxFocus, closed && { color: t.c.dim }]}
        />
        {/* Send or Stop is last and never shrinks; the rest gives way by tier (barTier.ts). */}
        <View style={s.bar} onLayout={onBar}>
          <BarTierContext.Provider value={tier}>
            {picker}
            <BarButton label="Attach" title="Attach files" icon={<AttachGlyph />} disabled={closed} onClick={openAttach} />
            {extras}
          </BarTierContext.Provider>
          <View style={s.spacer} />
          {/* A phone has no keyboard shortcuts to hint at: the hint is for a tablet's width, with a hardware keyboard. */}
          {onQueue && tier === "full" && window.width > 760 && <Text style={s.hint} numberOfLines={1}>{busy ? "Enter to queue, Ctrl+Enter to stop and send now" : "Enter to send, Shift+Enter for a new line"}</Text>}
          {busy && onQueue && <Button title="Queue" label="Queue" disabled={!canSend} onPress={queue} />}
          {busy ? <Button title="Stop" onPress={stop} /> : <Button title="Send" variant="primary" disabled={!canSend} onPress={send} />}
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

function AttachGlyph() {
  const color = useGlyphColor();
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.8-5.8a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.1 1.1 0 0 1-1.6-1.6L10 4.5" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
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
  mirrorText: { paddingVertical: 8, paddingHorizontal: 11 },
  box: { width: "100%" as const, backgroundColor: t.c.panel2, color: t.c.text, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, textAlignVertical: "top" as const, outlineStyle: "none" as never },
  boxFocus: { borderColor: t.c.accentLine, boxShadow: `0 0 0 3px ${t.c.accentWash}` },
  bar: { flexDirection: "row" as const, flexWrap: "nowrap" as const, alignItems: "center" as const, gap: 6, minWidth: 0, position: "relative" as const },
  spacer: { flex: 1, minWidth: 0 },
  hint: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim, flexShrink: 1000, minWidth: 0, textAlign: "right" as const },
  attachError: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.badText },
});
