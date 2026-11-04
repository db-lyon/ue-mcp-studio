
/**
 * Per-turn review in the chat: the turn card listing what a turn changed,
 * grouped by type, each with a one-line summary and Keep or Revert, and Revert
 * all; each item's diff (text for config and source; for a package, Unreal's
 * own diff records with before and after values and a picture of each
 * version), a button that opens Unreal's own diff in the editor; and the
 * session's checkpoint timeline with Restore to here and Undo.
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Image, Pressable, View, type TextStyle, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { REVIEW_GROUPS, unifiedLines, type CheckpointChange, type RestoreOutcome, type ReviewItem, type ReviewStatus, type TimelineMark, type TurnReview } from "@ue-mcp-studio/shared";
import { REVIEW_STATUS, blueprintLines, fileName, markKind, markTime, nativeTitle, openedText, outcomeNote } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../../nav";
import { haptic } from "../../../native/haptics";
import { Banner, buttonFont, Check, font, labelFont, Pill, T, useTheme, type Theme } from "../../../ui";
import { AssetDiffView } from "./AssetDiff";
import { AssetTile } from "../../../chat/AssetTile";
import { DiffView } from "../../../chat/Diff";
import { SessionIdContext } from "../../../chat/attachments";
import { engineParts, engineText } from "../../../chat/breakable";
import { useDaemonImage } from "../../../chat/daemon-image";
import { buttonText, small } from "../../../chat/styles";

export { outcomeNote };

const lh = (t: Theme): number => (t.editor ? 1.5 : 1.55);

/** A small-button's text: the font size of where it sits (the body's, or .small's 12px inside a small banner), with the button's 0.02em; the editor themes keep 12px. */
const smallButtonText = (t: Theme, size = t.base.size) => [buttonFont(t, false, size)];

/**
 * A button inside the conversation at a finger's size, outlined as every
 * other button is (pointer: coarse makes the ghost ones look the same).
 * `kind` picks primary or danger; `small` the small-button text; `left` aligns
 * a long label to the start, wrapping.
 */
export function OutlineButton({ title, onPress, disabled, expanded, kind, small: isSmall = true, left, fill, label, children, faded, fontSize }: {
  /** The text size where it sits, when that is not the body's (a button inside .banner.small is 12px). */
  fontSize?: number;
  title?: string;
  onPress: () => void;
  disabled?: boolean;
  expanded?: boolean;
  kind?: "primary" | "danger";
  small?: boolean;
  left?: boolean;
  fill?: boolean;
  label?: string;
  children?: ReactNode;
  /** Disabled inside review actions: faded to 40% rather than drawn off. */
  faded?: boolean;
}) {
  const t = useTheme();
  const primary = kind === "primary";
  const danger = kind === "danger";
  const line = disabled && !faded ? t.c.disabledLine : danger ? t.c.bad : primary ? t.c.accent : t.c.lineStrong;
  const bg = primary ? (disabled && !faded ? "transparent" : t.c.accent) : t.c.panel2;
  const color = disabled && !faded ? t.c.dim : danger ? t.c.bad : primary ? t.c.onAccent : t.c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled, ...(expanded !== undefined ? { expanded } : {}) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: isSmall ? 10 : 12, paddingVertical: isSmall ? 0 : 6, justifyContent: "center", alignItems: left ? "flex-start" : "center", alignSelf: fill ? "stretch" : left ? "flex-start" : undefined, borderRadius: t.radius, borderWidth: 1, borderColor: pressed && !disabled ? t.c.accentLine : line, backgroundColor: pressed && !disabled ? (primary ? t.c.accentHi : t.c.panel3) : bg, opacity: disabled && faded ? 0.4 : 1 })}
    >
      {children ?? <T style={[...(isSmall ? smallButtonText(t, fontSize) : [buttonText(t, primary ? 600 : 500)]), { color, textAlign: left ? "left" : "center" }]}>{title}</T>}
    </Pressable>
  );
}

type Verb = "Reverting" | "Keeping" | "Undoing";

/** A path that breaks only between its folders. */
const folders = (path: string): string => path.split("/").join("/​");

/**
 * Keep, Revert, Undo revert and the conflict's buttons on a phone: drawn 32
 * pixels tall, taking taps over a 44 pixel line (`.review-actions > button.small-button`
 * and `.review-conflict > button.small-button` under a coarse pointer). A
 * disabled one is drawn as a disabled button at 40%.
 */
function SmallButton({ title, onPress, disabled, kind, fontSize }: { title: string; onPress: () => void; disabled?: boolean; kind?: "danger"; fontSize?: number }) {
  const t = useTheme();
  const danger = kind === "danger";
  const line = disabled ? t.c.disabledLine : danger ? t.c.bad : t.c.lineStrong;
  const color = disabled ? t.c.dim : danger ? t.c.bad : t.c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 7, bottom: 7, left: 5, right: 5 }}
      style={({ pressed }) => ({ height: 32, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed && !disabled ? t.c.accentLine : line, backgroundColor: pressed && !disabled ? t.c.panel3 : t.c.panel2, opacity: disabled ? 0.4 : 1 })}
    >
      <T style={[...smallButtonText(t, fontSize), { color }]}>{title}</T>
    </Pressable>
  );
}

/** Revert all and Open in Unreal diff: text actions in the accent, no outline, 44 pixels tall. */
function TextAction({ title, label, hint, onPress, disabled, text, style }: { title: string; label?: string; hint?: string; onPress: () => void; disabled?: boolean; text: TextStyle; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [{ minHeight: 44, paddingVertical: 4, paddingHorizontal: 8, justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: "transparent", backgroundColor: pressed && !disabled ? t.c.panel2 : "transparent" }, style]}
    >
      <T style={[text, { color: disabled ? t.c.dim : t.c.accentHi }]}>{title}</T>
    </Pressable>
  );
}

/** The chevron after an item's name: down while its diff is closed, up (in the accent) while it is open. */
function NameChevron({ open }: { open: boolean }) {
  const t = useTheme();
  const color = open ? t.c.accent : t.c.muted;
  // vertical-align: -1px puts its foot a pixel under the name's baseline.
  return (
    <View style={{ marginLeft: 6, top: 1, transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
      <Svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <Path d="M2 3.5l3 3 3-3" />
      </Svg>
    </View>
  );
}

/**
 * The item's name, a text button that opens its diff: a file name that wraps
 * only between its parts, its last two parts held together with the chevron,
 * so "uasset" is never alone on a line. Drawn 36 pixels tall, reached over 44.
 */
function ItemName({ path, open, reverted, onPress }: { path: string; open: boolean; reverted: boolean; onPress: () => void }) {
  const t = useTheme();
  const name = fileName(path);
  const parts = engineParts(name);
  // The editor themes' button rule (400 12px/1.2 sans) outranks the name's own font.
  const text: TextStyle = { ...(t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 600, 13, 1.4)), color: reverted ? t.c.muted : t.c.text, textDecorationLine: reverted ? "line-through" : "none" };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={path}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{ alignSelf: "flex-start", maxWidth: "100%", minHeight: 36, paddingVertical: 8, justifyContent: "center" }}
    >
      <T style={text}>
        {parts.slice(0, -2).join("​")}
        {parts.length > 2 ? "​" : ""}
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <T style={text}>{parts.slice(-2).join("")}</T>
          <NameChevron open={open} />
        </View>
      </T>
    </Pressable>
  );
}

/** A call in flight, said on its item in place of the controls: a pulsing accent dot and the verb. */
function Acting({ verb }: { verb: Verb }) {
  const t = useTheme();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if ((globalThis as { __studioFreezeAnimations?: boolean }).__studioFreezeAnimations) return;
    const half = { duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true };
    v.setValue(0.35);
    const loop = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 1, ...half }), Animated.timing(v, { toValue: 0.35, ...half })]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View role="status" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}>
      <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.accent, opacity: v }} />
      <T style={[small(t), { color: t.c.muted }]}>{verb}</T>
    </View>
  );
}

/**
 * A turn's changes, with Keep or Revert per item. Each item is one block: its
 * name (which opens its diff) on the first line, its status and its state
 * with Keep or Revert on the second, then its summary and path; Open in
 * Unreal diff shows under the path once the item is opened. A turn that
 * changed one file opens that file's diff at once.
 */
export function TurnReviewCard({ review: saved }: { review: TurnReview }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const sessionId = useContext(SessionIdContext);
  const [review, setReview] = useState(saved);
  useEffect(() => setReview(saved), [saved]);
  const [open, setOpen] = useState<string | null>(saved.items.length === 1 ? saved.items[0].path : null);
  /** The call in flight and the items it acts on, said on those items in place of their controls. */
  const [busy, setBusy] = useState<{ verb: Verb; paths: string[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** What a failed call said: under its item when it acted on one, else under the card. */
  const [error, setError] = useState<{ text: string; path?: string } | null>(null);
  /** What opening Unreal's view of an item did, shown under that item. */
  const [opened, setOpened] = useState<{ path: string; text: string; bad?: boolean } | null>(null);
  /** A conflict whose Revert anyway waits for its second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = (verb: Verb, paths: string[], call: () => Promise<{ review: TurnReview; outcome?: RestoreOutcome }>) => {
    if (!sessionId) return;
    setBusy({ verb, paths });
    setError(null);
    setNote(null);
    call()
      .then(
        (r) => {
          setReview(r.review);
          setNote(r.outcome ? outcomeNote(r.outcome) : null);
          haptic.success();
        },
        (e: Error) => {
          setError({ text: e.message, ...(paths.length === 1 ? { path: paths[0] } : {}) });
          haptic.error();
        },
      )
      .finally(() => {
        setBusy(null);
        setConfirming(null);
      });
  };
  const keep = (paths: string[]) => run("Keeping", paths, async () => api.reviewKeep(sessionId!, review.id, paths));
  const openNative = (path: string) => {
    if (!sessionId) return;
    setOpened(null);
    api.reviewNativeDiff(sessionId, review.id, path).then(
      (r) => setOpened({ path, text: openedText(r) }),
      (e: Error) => setOpened({ path, text: e.message, bad: true }),
    );
  };
  const revert = (paths: string[], force = false) => {
    haptic.warning();
    run("Reverting", paths, () => api.reviewRevert(sessionId!, review.id, paths, force));
  };
  const undo = (path: string) => run("Undoing", [path], () => api.reviewUndo(sessionId!, review.id, path));

  const open_ = review.items.filter((i) => i.state !== "reverted");
  const reverted = review.items.length - open_.length;
  const dimSmall = [small(t), { color: t.c.dim }];
  return (
    <View
      accessibilityRole="none"
      testID="review-card"
      accessibilityLabel="Changes in this turn"
      style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginVertical: 8, minWidth: 0, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.editor ? "transparent" : t.c.line, borderRadius: t.radiusLg }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2 }}>
          <T style={labelFont(t)}>Changes in this turn</T>
          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <T style={[...dimSmall, { marginRight: 8 }]}>{"·"}</T>
            <T style={dimSmall}>{`${review.items.length === 1 ? "1 file" : `${review.items.length} files`}${reverted ? `, ${reverted} reverted` : ""}`}</T>
          </View>
        </View>
        {open_.length > 0 ? (
          <TextAction title="Revert all" disabled={!!busy || !sessionId} onPress={() => revert(open_.map((i) => i.path))} text={t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "mono", 500, 11.5, 1.2)} style={{ marginVertical: -10, marginRight: -8 }} />
        ) : null}
      </View>
      {REVIEW_GROUPS.map(({ group, label }, gi) => {
        const items = review.items.filter((i) => i.group === group);
        if (items.length === 0) return null;
        const first = REVIEW_GROUPS.findIndex((g) => review.items.some((i) => i.group === g.group)) === gi;
        return (
          <View key={group} style={{ gap: 4, marginTop: first ? 0 : 6 }}>
            <T style={{ ...font(t, "sans", 400, 10, lh(t)), letterSpacing: 0.6, textTransform: "uppercase", color: t.c.dim }}>{label}</T>
            <View style={{ gap: 10 }}>
              {items.map((it) => (
                <Item
                  key={it.path}
                  it={it}
                  open={open === it.path}
                  busy={!!busy}
                  acting={busy?.paths.includes(it.path) ? busy.verb : null}
                  failed={error?.path === it.path ? error.text : null}
                  opened={opened?.path === it.path ? opened : null}
                  confirming={confirming === it.path}
                  onToggle={() => setOpen(open === it.path ? null : it.path)}
                  onNative={() => openNative(it.path)}
                  onKeep={() => keep([it.path])}
                  onRevert={(force) => revert([it.path], force)}
                  onUndo={() => undo(it.path)}
                  onConfirm={(on) => setConfirming(on ? it.path : null)}
                  diff={open === it.path && sessionId ? <ItemDiff sessionId={sessionId} reviewId={review.id} item={it} /> : null}
                />
              ))}
            </View>
          </View>
        );
      })}
      {review.dirty && review.dirty.length > 0 ? <T style={dimSmall}>{`Unsaved in the editor, so not recorded: ${review.dirty.join(", ")}`}</T> : null}
      {note ? <Banner kind="warn"><T style={[small(t), { color: t.c.warnText }]}>{note}</T></Banner> : null}
      {error && !error.path ? <Banner kind="bad" role="alert"><T style={[small(t), { color: t.c.badText }]}>{error.text}</T></Banner> : null}
    </View>
  );
}

function Item({ it, open, busy, acting, failed, opened, confirming, onToggle, onNative, onKeep, onRevert, onUndo, onConfirm, diff }: {
  it: ReviewItem;
  open: boolean;
  busy: boolean;
  acting: Verb | null;
  failed: string | null;
  opened: { text: string; bad?: boolean } | null;
  confirming: boolean;
  onToggle: () => void;
  onNative: () => void;
  onKeep: () => void;
  onRevert: (force?: boolean) => void;
  onUndo: () => void;
  onConfirm: (on: boolean) => void;
  diff: ReactNode;
}) {
  const t = useTheme();
  // .review-item.acting outranks .failed, which outranks the state's own rail.
  const border = acting ? t.c.accent : failed ? t.c.bad : it.state === "pending" ? t.c.accentLine : it.state === "kept" ? t.c.ok : it.state === "reverted" ? t.c.dim : t.c.lineStrong;
  const status = it.status === "added" ? "ok" : it.status === "deleted" ? "bad" : undefined;
  return (
    <View accessibilityLabel={it.path} style={{ borderLeftWidth: 2, borderLeftColor: border, paddingLeft: 10, paddingBottom: 4, minWidth: 0 }}>
      <ItemName path={it.path} open={open} reverted={it.state === "reverted"} onPress={onToggle} />
      <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, minWidth: 0 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 4 }}>
          <Pill kind={status}>{REVIEW_STATUS[it.status]}</Pill>
          {it.state === "kept" ? <Pill kind="ok">Kept</Pill> : null}
          {it.state === "reverted" ? <Pill>Reverted</Pill> : null}
          {it.untracked ? <Pill kind="warn">Outside the agent</Pill> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, minHeight: 32 }}>
          {acting ? (
            <Acting verb={acting} />
          ) : it.state === "reverted" ? (
            it.undo ? <SmallButton title="Undo revert" disabled={busy} onPress={onUndo} /> : null
          ) : (
            <>
              {it.state === "pending" ? <SmallButton title="Keep" disabled={busy} onPress={onKeep} /> : null}
              {!it.conflict ? <SmallButton title="Revert" disabled={busy} onPress={() => onRevert()} /> : null}
            </>
          )}
        </View>
      </View>
      {it.summary ? <T style={[font(t, "sans", 400, 12, 1.45), { marginTop: 6, color: it.diffError ? t.c.bad : t.c.text }]}>{engineText(it.summary)}</T> : null}
      {/* .small.mono on one element: .mono's 0.92em is of the body's size, not of .small's 12px. */}
      <T style={[font(t, "mono", 400, Math.round(t.base.size * 0.92 * 100) / 100, lh(t)), { marginTop: 2, color: t.c.dim }]}>{folders(it.path)}</T>
      {failed ? (
        <Banner kind="bad" role="alert" style={{ marginTop: 6 }}>
          <T style={[small(t), { color: t.c.badText }]}>{failed}</T>
        </Banner>
      ) : null}
      {it.conflict && it.state !== "reverted" ? (
        <Banner kind="warn" role="alert" style={{ marginTop: 6 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 14 }}>
            <T style={[small(t), { color: t.c.warnText }]}>This file was changed outside the agent, so Revert left it alone.</T>
            {confirming ? (
              <>
                <SmallButton title="Revert and lose those changes" kind="danger" fontSize={12} disabled={busy} onPress={() => onRevert(true)} />
                <SmallButton title="Keep those changes" fontSize={12} onPress={() => onConfirm(false)} />
              </>
            ) : (
              <SmallButton title="Revert anyway" fontSize={12} disabled={busy} onPress={() => onConfirm(true)} />
            )}
          </View>
        </Banner>
      ) : null}
      {/* A phone has no tooltip to say why Unreal cannot open it; the opened diff says so instead. */}
      {open && it.native?.available ? (
        <TextAction title="Open in Unreal diff" hint={nativeTitle(it)} onPress={onNative} text={{ ...font(t, "sans", 500, 12, 1.3), letterSpacing: 0 }} style={{ alignSelf: "flex-start", marginTop: 2, marginBottom: -6, marginLeft: -8 }} />
      ) : null}
      {opened ? (
        <View role="status" accessibilityLiveRegion="polite" style={{ marginTop: 4 }}>
          <T style={[small(t), { color: opened.bad ? t.c.bad : t.c.dim }]}>{opened.text}</T>
        </View>
      ) : null}
      {diff ? <View style={{ marginTop: 8, minWidth: 0 }}>{diff}</View> : null}
    </View>
  );
}

/** An item's diff, read when it is opened. */
export function ItemDiff({ sessionId, reviewId, item }: { sessionId: string; reviewId: string; item: ReviewItem }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [diff, setDiff] = useState<{ change: CheckpointChange; before?: string; after?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.reviewDiff(sessionId, reviewId, item.path).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, reviewId, item.path]);
  const dimSmall = [small(t), { color: t.c.dim }];
  if (error) return <Banner kind="bad" role="alert"><T style={[small(t), { color: t.c.badText }]}>{`Could not read the diff: ${error}`}</T></Banner>;
  if (!diff) return <T style={dimSmall}>Reading the diff.</T>;
  const c = diff.change;
  const name = fileName(item.path);
  // A failed diff's reason is already the banner; the native view's reason would repeat it.
  const native = item.native && !item.native.available && c.assetDiff?.state !== "error" ? <T style={dimSmall}>{`No Unreal diff view: ${item.native.reason}`}</T> : null;
  // The engine records are the whole diff, so blueprint(diff)'s structural summary is not repeated under them.
  if (c.assetDiff) {
    return (
      <View style={{ gap: 6, minWidth: 0 }}>
        <AssetDiffView diff={c.assetDiff} name={name} asset={item.asset} status={item.status} nativeNote={native} />
      </View>
    );
  }
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      {native}
      {c.diff !== undefined ? <DiffView lines={unifiedLines(c.diff)} label={`Diff of ${item.path}`} /> : null}
      {c.blueprintDiff ? <BlueprintDiff diff={c.blueprintDiff} /> : null}
      {item.visual ? <CapturedPictures name={name} item={item} before={diff.before} after={diff.after} /> : null}
      {c.diff === undefined && !c.blueprintDiff && !item.visual ? <T style={dimSmall}>{item.summary ?? (c.large ? "A large file: no diff is kept for it." : "Not a text file, so there is no line diff.")}</T> : null}
    </View>
  );
}

function CapturedSide({ file, label, alt, missing, failed, onFail }: { file?: string; label: string; alt: string; missing: string; failed: boolean; onFail: () => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const uri = useDaemonImage(file && !failed ? api.reviewImageUrl(file) : null);
  useEffect(() => {
    if (uri === "failed") onFail();
  }, [uri, onFail]);
  if (file && !failed && uri !== "failed") {
    return (
      <View style={{ gap: 4 }}>
        <View style={{ width: 220, maxWidth: "100%", aspectRatio: 1, borderWidth: 1, borderColor: t.c.line, borderRadius: 4, backgroundColor: t.c.panel2, overflow: "hidden" }}>
          {uri ? <Image accessibilityLabel={alt} source={{ uri }} style={{ width: "100%", height: "100%" }} /> : null}
        </View>
        <T style={[small(t), { color: t.c.dim }]}>{label}</T>
      </View>
    );
  }
  return (
    <View style={{ gap: 2, maxWidth: 220, paddingTop: 2 }}>
      <T style={[small(t), { color: t.c.dim }]}>{label}</T>
      <T style={[small(t), { color: t.c.dim }]}>{failed ? "The picture could not be read." : missing}</T>
    </View>
  );
}

/**
 * The pictures a review recorded before engine diffs captured after the turn.
 * A side with none says why in words; with none at all, the asset's tile.
 */
function CapturedPictures({ name, item, before, after }: { name: string; item: ReviewItem; before?: string; after?: string }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const sides = [
    { label: "Before", file: before, alt: `${name} before the turn`, missing: item.status === "added" ? "Did not exist before this turn" : "No picture was captured before this turn." },
    { label: "After", file: after, alt: `${name} after the turn`, missing: item.status === "deleted" ? "Deleted in this turn" : "No picture was captured after this turn." },
  ];
  if (!sides.some((s) => s.file && !failed[s.label])) return <AssetTile fileName={name} path={item.asset} status={item.status} note="No picture was captured for this asset." />;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {sides.map((s) => (
        <CapturedSide key={s.label} file={s.file} label={s.label} alt={s.alt} missing={s.missing} failed={!!failed[s.label]} onFail={() => setFailed((f) => (f[s.label] ? f : { ...f, [s.label]: true }))} />
      ))}
    </View>
  );
}

/** blueprint(diff)'s answer as nested lines: each key, and its value or its children. */
export function BlueprintDiff({ diff }: { diff: Record<string, unknown> }) {
  const t = useTheme();
  return (
    <View accessibilityLabel="Blueprint diff" style={{ paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: t.c.line, borderRadius: 4, maxHeight: 320, overflow: "hidden" }}>
      {blueprintLines(diff).map((l, i) => (
        <T key={i} style={[font(t, "mono", 400, 12 * 0.92), { lineHeight: 12 * lh(t), paddingLeft: l.depth * 11, color: t.c.text }]}>
          {l.text}
        </T>
      ))}
    </View>
  );
}

/**
 * The session's switch and its checkpoint timeline, newest first. Restore to
 * here puts every recorded file back to that point; every restore is a mark of
 * its own with Undo.
 */
export function ReviewPanel({ sessionId, review, timeline, onChanged }: {
  sessionId: string;
  /** The session's switch, null for the Settings default. */
  review: boolean | null;
  timeline: TimelineMark[];
  onChanged: () => void;
}) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; retry?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.reviewStatus().then(setStatus, (e: Error) => setError(e.message));
  }, [api]);
  const on = typeof review === "boolean" ? review : !!status?.default;

  const run = (call: () => Promise<{ outcome?: RestoreOutcome }>, retry?: () => void) => {
    setBusy(true);
    setError(null);
    setNote(null);
    call()
      .then(
        (r) => {
          const text = r.outcome ? outcomeNote(r.outcome) : null;
          setNote(text ? { text, ...(r.outcome?.conflicts.length && retry ? { retry } : {}) } : null);
          onChanged();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => {
        setBusy(false);
        setConfirming(null);
      });
  };
  const restore = (m: TimelineMark, force = false): void => {
    haptic.warning();
    run(() => api.timelineRestore(sessionId, m.checkpoint, force), force ? undefined : () => restore(m, true));
  };
  const undo = (m: TimelineMark) => run(() => api.timelineUndo(sessionId, m.checkpoint));
  const toggle = (next: boolean) =>
    run(async () => {
      await api.setSessionReview(sessionId, next === status?.default ? null : next);
      return {};
    });

  const marks = [...timeline].reverse();
  const dimSmall = [small(t), { color: t.c.dim }];
  return (
    <View testID="review-panel" style={{ gap: 10 }}>
      {/* label.row.toggle: .row's 6 px above and below, the checkbox's own 4 px and 3 px margins, and the label's 14 px on the right. */}
      <View style={{ paddingLeft: 4, marginRight: 14, marginVertical: 6 }}>
      <Check checked={on} disabled={busy || !status} onChange={toggle} label="Review this session's turns">
        <T style={{ marginLeft: 3, color: t.c.muted }}>
          {"Review this session's turns "}
          <T style={dimSmall}>{`A checkpoint before and after each turn, and a card to keep or revert the files it changed.${review === null ? " Following Settings." : ""}`}</T>
        </T>
      </Check>
      </View>
      {note ? (
        <Banner kind="warn">
          <T style={[small(t), { color: t.c.warnText }]}>{note.text}</T>
          {note.retry ? <OutlineButton title="Restore those too" disabled={busy} onPress={note.retry} /> : null}
        </Banner>
      ) : null}
      {error ? <Banner kind="bad"><T style={[small(t), { color: t.c.badText }]}>{error}</T></Banner> : null}
      {marks.length === 0 ? (
        <T style={dimSmall}>No checkpoints in this session yet.</T>
      ) : (
        <View accessibilityRole="list" accessibilityLabel="Checkpoint timeline" style={{ gap: 2 }}>
          {marks.map((m) => (
            <View key={`${m.kind}-${m.checkpoint}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.c.line, opacity: m.undone ? 0.6 : 1 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: m.kind === "restore" ? t.c.warn : m.kind === "attempt" ? t.c.ok : t.c.accent }} />
              <T style={{ flexShrink: 1 }}>{m.label}</T>
              <T style={dimSmall}>{`${markKind(m)} ${markTime(m.at)}`}</T>
              <View style={{ flexGrow: 1 }} />
              {m.kind === "restore" ? (
                !m.undone && m.undo ? <GhostSmall title="Undo" disabled={busy} onPress={() => undo(m)} /> : null
              ) : confirming === m.checkpoint ? (
                <>
                  <OutlineButton title="Restore every file" kind="primary" disabled={busy} onPress={() => restore(m)} />
                  <GhostSmall title="Cancel" onPress={() => setConfirming(null)} />
                </>
              ) : (
                <OutlineButton title="Restore to here" disabled={busy} onPress={() => setConfirming(m.checkpoint)} />
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** button.ghost.small-button outside the conversation: no outline, muted. */
function GhostSmall({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 10, justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" })}>
      <T style={[...smallButtonText(t), { color: disabled ? t.c.dim : t.c.muted }]}>{title}</T>
    </Pressable>
  );
}
