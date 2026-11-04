
/**
 * Per-turn review in the chat: the turn card listing what a turn changed,
 * grouped by type, each with a one-line summary and Keep or Revert, and Revert
 * all; each item's diff (text for config and source; for a package, Unreal's
 * own diff records with before and after values and a picture of each
 * version), a button that opens Unreal's own diff in the editor; and the
 * session's checkpoint timeline with Restore to here and Undo.
 */
import { useContext, useEffect, useState, type ReactNode } from "react";
import { Image, Pressable, View } from "react-native";
import { REVIEW_GROUPS, unifiedLines, type CheckpointChange, type RestoreOutcome, type ReviewItem, type ReviewStatus, type TimelineMark, type TurnReview } from "@ue-mcp-studio/shared";
import { REVIEW_STATUS, blueprintLines, fileName, markKind, markTime, nativeTitle, openedText, outcomeNote } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../../nav";
import { haptic } from "../../../native/haptics";
import { Banner, Check, font, labelFont, Pill, T, useTheme, type Theme } from "../../../ui";
import { AssetDiffView } from "./AssetDiff";
import { AssetTile } from "../../../chat/AssetTile";
import { DiffView } from "../../../chat/Diff";
import { SessionIdContext } from "../../../chat/attachments";
import { engineText } from "../../../chat/breakable";
import { useDaemonImage } from "../../../chat/daemon-image";
import { buttonText, small } from "../../../chat/styles";

export { outcomeNote };

const lh = (t: Theme): number => (t.editor ? 1.5 : 1.55);

/** A small-button's text: the body's size in the button font (the editor themes keep 12px). */
const smallButtonText = (t: Theme) => [buttonText(t), { fontSize: t.editor ? 12 : 13.5, lineHeight: (t.editor ? 12 : 13.5) * 1.2 }];

/**
 * A button inside the conversation at a finger's size, outlined as every
 * other button is (pointer: coarse makes the ghost ones look the same).
 * `kind` picks primary or danger; `small` the small-button text; `left` aligns
 * a long label to the start, wrapping.
 */
export function OutlineButton({ title, onPress, disabled, expanded, kind, small: isSmall = true, left, fill, label, children, faded }: {
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
      {children ?? <T style={[...(isSmall ? smallButtonText(t) : [buttonText(t, primary ? 600 : 500)]), { color, textAlign: left ? "left" : "center" }]}>{title}</T>}
    </Pressable>
  );
}

/** Two to a row, as the phone's review actions grid lays them out. */
function Pairs({ items }: { items: ReactNode[] }) {
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 6 }}>
          {r.map((x, j) => (
            <View key={j} style={{ flex: 1, minWidth: 0, justifyContent: "center", alignItems: "stretch" }}>
              {x}
            </View>
          ))}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </>
  );
}

/** A turn's changes, with Keep or Revert per item. */
export function TurnReviewCard({ review: saved }: { review: TurnReview }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const sessionId = useContext(SessionIdContext);
  const [review, setReview] = useState(saved);
  useEffect(() => setReview(saved), [saved]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What opening Unreal's view of an item did, shown under that item. */
  const [opened, setOpened] = useState<{ path: string; text: string; bad?: boolean } | null>(null);
  /** A conflict whose Revert anyway waits for its second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = (call: () => Promise<{ review: TurnReview; outcome?: RestoreOutcome }>) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    setNote(null);
    call()
      .then(
        (r) => {
          setReview(r.review);
          setNote(r.outcome ? outcomeNote(r.outcome) : null);
          haptic.success();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => {
        setBusy(false);
        setConfirming(null);
      });
  };
  const keep = (paths: string[]) => run(async () => api.reviewKeep(sessionId!, review.id, paths));
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
    run(() => api.reviewRevert(sessionId!, review.id, paths, force));
  };
  const undo = (path: string) => run(() => api.reviewUndo(sessionId!, review.id, path));

  const open_ = review.items.filter((i) => i.state !== "reverted");
  const reverted = review.items.length - open_.length;
  const dimSmall = [small(t), { color: t.c.dim }];
  return (
    <View
      accessibilityRole="none"
      accessibilityLabel="Changes in this turn"
      style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 8, marginVertical: 8, minWidth: 0, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.editor ? "transparent" : t.c.line, borderRadius: t.radiusLg }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <T style={labelFont(t)}>Changes in this turn</T>
        <T style={dimSmall}>{`${review.items.length === 1 ? "1 file" : `${review.items.length} files`}${reverted ? `, ${reverted} reverted` : ""}`}</T>
        <View style={{ flex: 1 }} />
        {open_.length > 0 ? <OutlineButton title="Revert all" disabled={busy || !sessionId} onPress={() => revert(open_.map((i) => i.path))} /> : null}
      </View>
      {REVIEW_GROUPS.map(({ group, label }) => {
        const items = review.items.filter((i) => i.group === group);
        if (items.length === 0) return null;
        return (
          <View key={group} style={{ gap: 4 }}>
            <T style={{ ...small(t), fontSize: 10, lineHeight: 10 * lh(t), letterSpacing: 0.6, textTransform: "uppercase", color: t.c.dim }}>{label}</T>
            <View style={{ gap: 2 }}>
              {items.map((it) => (
                <Item
                  key={it.path}
                  it={it}
                  open={open === it.path}
                  busy={busy}
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
      {note ? <Banner kind="warn" style={{ marginBottom: 0 }}><T style={[small(t), { color: t.c.warnText }]}>{note}</T></Banner> : null}
      {error ? <Banner kind="bad" style={{ marginBottom: 0 }}><T style={[small(t), { color: t.c.badText }]}>{error}</T></Banner> : null}
    </View>
  );
}

function Item({ it, open, busy, opened, confirming, onToggle, onNative, onKeep, onRevert, onUndo, onConfirm, diff }: {
  it: ReviewItem;
  open: boolean;
  busy: boolean;
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
  const border = it.state === "pending" ? t.c.accentLine : it.state === "kept" ? t.c.ok : it.state === "reverted" ? t.c.dim : t.c.lineStrong;
  const actions: ReactNode[] = [];
  if (it.state === "kept") actions.push(<View style={{ alignSelf: "center" }}><Pill kind="ok">Kept</Pill></View>);
  if (it.state === "reverted") {
    actions.push(<View style={{ alignSelf: "center" }}><Pill>Reverted</Pill></View>);
    if (it.undo) actions.push(<OutlineButton title="Undo revert" disabled={busy} faded onPress={onUndo} />);
  } else {
    if (it.state === "pending") actions.push(<OutlineButton title="Keep" disabled={busy} faded onPress={onKeep} />);
    if (!it.conflict) actions.push(<OutlineButton title="Revert" disabled={busy} faded onPress={() => onRevert()} />);
  }
  return (
    <View accessibilityLabel={it.path} style={{ borderLeftWidth: 2, borderLeftColor: border, paddingVertical: 4, paddingRight: 4, paddingLeft: 10, gap: 4, minWidth: 0 }}>
      <View style={{ gap: 6, minWidth: 0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={fileName(it.path)}
            accessibilityHint={it.path}
            accessibilityState={{ expanded: open }}
            onPress={onToggle}
            style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", flexShrink: 1, minWidth: 0, borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.accentLine : t.c.lineStrong, backgroundColor: pressed ? t.c.panel3 : t.c.panel2 })}
          >
            <T style={[buttonText(t, 600), { color: it.state === "reverted" ? t.c.muted : t.c.text, textDecorationLine: it.state === "reverted" ? "line-through" : "none" }]}>{engineText(fileName(it.path))}</T>
          </Pressable>
          <View style={{ alignSelf: "center" }}>
            <Pill>{REVIEW_STATUS[it.status]}</Pill>
          </View>
          {it.untracked ? (
            <View style={{ alignSelf: "center" }}>
              <Pill kind="warn">Outside the agent</Pill>
            </View>
          ) : null}
        </View>
        <OutlineButton title="Open in Unreal diff" label="Open in Unreal diff" disabled={!it.native?.available} faded onPress={onNative} />
        <Pairs items={actions} />
      </View>
      {it.summary ? <T style={[small(t), { color: it.diffError ? t.c.bad : t.c.text }]}>{engineText(it.summary)}</T> : null}
      {/* .small.mono on one element: .mono's 0.92em is of the body's size, not of .small's 12px. */}
      <T style={[font(t, "mono", 400, Math.round(t.base.size * 0.92 * 100) / 100), { lineHeight: 12 * lh(t), color: t.c.dim }]} accessibilityHint={nativeTitle(it)}>{engineText(it.path)}</T>
      {opened ? <T accessibilityLiveRegion="polite" style={[small(t), { color: opened.bad ? t.c.bad : t.c.dim }]}>{opened.text}</T> : null}
      {it.conflict && it.state !== "reverted" ? (
        <Banner kind="warn" role="alert" style={{ marginBottom: 0 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <T style={[small(t), { color: t.c.warnText }]}>You edited this file after the agent, so Revert left it alone.</T>
            {confirming ? (
              <>
                <OutlineButton title="Revert and lose my edits" kind="danger" disabled={busy} onPress={() => onRevert(true)} />
                <OutlineButton title="Keep my edits" onPress={() => onConfirm(false)} />
              </>
            ) : (
              <OutlineButton title="Revert anyway" disabled={busy} onPress={() => onConfirm(true)} />
            )}
          </View>
        </Banner>
      ) : null}
      {diff}
    </View>
  );
}

/** An item's diff, read when it is opened. */
export function ItemDiff({ sessionId, reviewId, item }: { sessionId: string; reviewId: string; item: ReviewItem }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [diff, setDiff] = useState<{ change: CheckpointChange; before?: string; after?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
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
  if (error) return <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}><T style={[small(t), { color: t.c.badText }]}>{`Could not read the diff: ${error}`}</T></Banner>;
  if (!diff) return <T style={dimSmall}>Reading the diff.</T>;
  const c = diff.change;
  const name = fileName(item.path);
  // A failed diff's reason is already the banner; the native view's reason would repeat it.
  const native = item.native && !item.native.available && c.assetDiff?.state !== "error" ? <T style={dimSmall}>{`No Unreal diff view: ${item.native.reason}`}</T> : null;
  if (c.assetDiff) {
    const bp = c.assetDiff.blueprint;
    return (
      <View style={{ gap: 6, minWidth: 0 }}>
        <AssetDiffView
          diff={c.assetDiff}
          name={name}
          asset={item.asset}
          status={item.status}
          nativeNote={native}
          blueprintTree={
            bp ? (
              <View>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: treeOpen }} onPress={() => setTreeOpen(!treeOpen)} style={{ minHeight: 44, justifyContent: "center" }}>
                  <T style={small(t)}>{`${treeOpen ? "▾" : "▸"} Structure (blueprint diff)`}</T>
                </Pressable>
                {treeOpen ? <BlueprintDiff diff={bp} /> : null}
              </View>
            ) : undefined
          }
        />
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
    <View style={{ gap: 10 }}>
      {/* label.toggle: the checkbox's own 4 px and 3 px margins, and the label's 14 px on the right. */}
      <View style={{ paddingLeft: 4, marginRight: 14 }}>
      <Check checked={on} disabled={busy || !status} onChange={toggle} label="Review this session's turns">
        <T style={{ marginLeft: 3 }}>
          {"Review this session's turns "}
          <T style={dimSmall}>{`A checkpoint before and after each turn, and a card to keep or revert its changes.${review === null ? " Following Settings." : ""}`}</T>
        </T>
      </Check>
      </View>
      {note ? (
        <Banner kind="warn" style={{ marginBottom: 0 }}>
          <T style={[small(t), { color: t.c.warnText }]}>{note.text}</T>
          {note.retry ? <OutlineButton title="Restore those too" disabled={busy} onPress={note.retry} /> : null}
        </Banner>
      ) : null}
      {error ? <Banner kind="bad" style={{ marginBottom: 0 }}><T style={[small(t), { color: t.c.badText }]}>{error}</T></Banner> : null}
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
