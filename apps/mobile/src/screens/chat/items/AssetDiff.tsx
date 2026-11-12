/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, in one tree with a picture of each version above it where
 * the asset's change is a visual one. The web client's chat/AssetDiff.tsx at a phone's width: the tree's rows come
 * from diffTree in the shared package, each value under its name.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View, type TextStyle } from "react-native";
import { diffClass, diffErrorConsequence, diffPictures, isBlankPicture, isVisualAsset, thumbnailErrors, wantsTile, type PictureFailure, type PictureSide } from "@ue-mcp-studio/client-core";
import {
  diffTree,
  inlineFits,
  LABEL_JOIN,
  splitNeeded,
  TONE_GLYPH,
  TONE_WORD,
  treeLines,
  unifiedLines,
  WEB_ROW_METRICS,
  type AssetDiff,
  type DiffTreeRow,
  type DiffValue,
  type RowMetrics,
} from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../nav";
import { Banner, font, lineBox, T, useTheme, type Theme } from "../../../ui";
import { DiffView } from "../../../chat/Diff";
import { engineText } from "../../../chat/breakable";
import { AssetTile, tileOf } from "../../../chat/AssetTile";
import { useDaemonImage } from "../../../chat/daemon-image";
import { small } from "../../../chat/styles";
import { Swatch, useCardSize, type CompareTier } from "./compare";
import { picturePixels } from "./picture-pixels";

const lh = (t: Theme): number => (t.editor ? 1.5 : 1.55);

/** Each side whose picture is no picture of it, and why. */
type PictureFailures = Partial<Record<PictureSide, PictureFailure>>;

/**
 * One version's picture, read through the transport. It stays hidden until
 * every picture beside it has loaded and been looked at, so a blank one (one
 * flat colour, a renderer that drew nothing, the empty checkerboard) never
 * flashes; a blank or unreadable one reports why.
 */
function Picture({ id, label, name, ready, onSeen, onFail }: { id: string; label: string; name: string; ready: boolean; onSeen: () => void; onFail: (why: PictureFailure) => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const uri = useDaemonImage(api.reviewThumbnailUrl(id));
  useEffect(() => {
    if (uri === "failed") return onFail("unreadable");
    if (!uri) return;
    let live = true;
    void picturePixels(uri).then((px) => {
      if (!live) return;
      if (px && isBlankPicture(px)) onFail("blank");
      else onSeen();
    });
    return () => {
      live = false;
    };
  }, [uri]);
  return (
    <View style={{ flex: 1, minWidth: 0, maxWidth: 220, gap: 4, opacity: ready ? 1 : 0 }}>
      <View style={{ width: "100%", aspectRatio: 1, borderWidth: 1, borderColor: t.c.line, borderRadius: 4, backgroundColor: t.c.panel2, overflow: "hidden" }}>
        {uri && uri !== "failed" ? <Image accessibilityLabel={`${name} ${label.toLowerCase()}`} source={{ uri }} style={{ width: "100%", height: "100%" }} /> : null}
      </View>
      <T style={[small(t), { color: t.c.dim }]}>{label}</T>
    </View>
  );
}

/**
 * The pictures diffPictures allows: Before and After of a changed visual
 * asset, or a new or deleted one's single picture; none for a Blueprint or
 * any other change a picture does not show. Where none is shown, a new or
 * deleted asset with no facts gets its tile in the space; otherwise nothing,
 * the tree's rows being the change.
 */
function Pictures({ diff, name, asset, status, failed, setFailed }: {
  diff: AssetDiff;
  name: string;
  asset?: string;
  status: "added" | "modified" | "deleted";
  failed: PictureFailures;
  setFailed: (f: (old: PictureFailures) => PictureFailures) => void;
}) {
  const [seen, setSeen] = useState<Partial<Record<PictureSide, boolean>>>({});
  const shown = diffPictures(diff, status, name, failed);
  if (shown.length === 0) {
    if (!wantsTile(diff, status)) return null;
    const errors = isVisualAsset(diffClass(diff), name) ? thumbnailErrors(diff) : [];
    const tile = tileOf(diff, name, asset, status);
    // The facts are rows of the tree below it.
    tile.facts = [];
    return <AssetTile {...tile} note={errors.length ? `No picture: ${engineText(errors.join("; "))}` : undefined} />;
  }
  const ready = shown.every((p) => seen[p.side]);
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {shown.map(({ side, label, thumbnail }) => (
        <Picture
          key={side}
          id={thumbnail.id}
          label={label}
          name={name}
          ready={ready}
          onSeen={() => setSeen((s) => (s[side] ? s : { ...s, [side]: true }))}
          onFail={(why) => setFailed((f) => (f[side] ? f : { ...f, [side]: why }))}
        />
      ))}
    </View>
  );
}

/** A package's diff from Unreal's diff code. */
export function AssetDiffView({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: ReactNode }) {
  const t = useTheme();
  if (diff.state === "error") {
    return (
      <Banner kind="bad" role="alert">
        <T style={[small(t), { color: t.c.badText }]}>Unreal could not load this asset to diff it, so there is no before and after to show.</T>
        <T style={[font(t, "mono", 400, 12 * 0.92), { color: t.c.badText }]}>{engineText(diff.error ?? "No reason was given.")}</T>
        <T style={[small(t), { color: t.c.badText }]}>{diffErrorConsequence(status)}</T>
      </Banner>
    );
  }
  if (diff.state === "deferred") return <T style={[small(t), { color: t.c.dim }]}>Diffing in the editor.</T>;
  return <ReadyDiff diff={diff} name={name} asset={asset} status={status} nativeNote={nativeNote} />;
}

/**
 * The app's row metrics for inlineFits and splitNeeded: the same fonts at the
 * same sizes as the web client's 12px grid (Plus Jakarta Sans or Roboto, and
 * the theme's mono at 0.92 of it), so the same guesses, which keeps a row on
 * the same number of lines as the web draws it. A device's own system mono in
 * the editor themes is narrower, so they stay on the safe side there.
 */
export const APP_ROW_METRICS: RowMetrics = { ...WEB_ROW_METRICS };

/** .dtree's indent per level and the triangle and glyph before a name. */
const INDENT = 14;
const LEAD = 28;

/** The rows with no children under a row: what a group's count says when its changes are one, such as an added node's values. */
const leaves = (row: DiffTreeRow): number => row.children.reduce((n, c) => n + (c.children.length ? leaves(c) : 1), 0);

/** How a row lays out on a phone: its values on the name's line, a line each, or together on one line under the name. */
export type RowLayout = "inline" | "split" | "under";

export function rowLayout(row: DiffTreeRow, depth: number, width: number, m: RowMetrics = APP_ROW_METRICS): RowLayout {
  // Not laid out yet: under the name, until the width says more.
  if (!(width > 0)) return "under";
  return inlineFits(row, depth, width, m) ? "inline" : splitNeeded(row, depth, width, m) ? "split" : "under";
}

/** .dtree's 12px on an 18px line, in the body font. */
const cell = (t: Theme, weight: 400 | 500 | 600 = 400): TextStyle => ({ ...font(t, "sans", weight, 12), lineHeight: 18 });
/** .mono in a cell: the theme's mono at 0.92 of 12px, on the row's 18px line. */
const monoCell = (t: Theme): TextStyle => ({ ...font(t, "mono", 400, 12 * 0.92), lineHeight: 18 });
/** The uppercase word that names a value on a line of its own. */
const sideWord = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 } as const;

/**
 * A value under its row's name: one line cut to the width, in the theme's
 * mono; a long or many-line value opens in place on a tap, with the lines a
 * list gained or lost marked. A removed value (Before with no After) is
 * struck through. On a line of its own it says which side it is.
 */
function ValueCell({ v, none, side, both, layout, open, toggle, other, first, depth, width, detail, rowName }: {
  rowName: string;
  v?: DiffValue;
  none?: boolean;
  side: "before" | "after";
  both: boolean;
  layout: RowLayout;
  open: boolean;
  toggle: () => void;
  other?: DiffValue;
  first: boolean;
  depth: number;
  width: number;
  detail?: boolean;
}) {
  const t = useTheme();
  const label = side === "before" ? "Before" : "After";
  const lead = 6 + depth * INDENT + LEAD;
  const opened = open && !!v?.long;
  const struck = side === "before" && !both;
  const full = layout === "split" || opened;
  const box = full
    ? { width: width > 0 ? width - lead : undefined, marginLeft: lead, flexShrink: 0 }
    : layout === "inline"
      ? { marginLeft: first ? 8 : 0, paddingTop: 2, flexShrink: 1 }
      : { marginLeft: first ? lead : 0, flexShrink: 1, maxWidth: width > 0 ? (both ? width / 2 - 6 - (depth * INDENT + LEAD) / 2 : width - 12 - depth * INDENT - LEAD) : undefined };
  const color = struck || (both && side === "before") || detail ? t.c.muted : t.c.text;
  const text: TextStyle = { ...(v ? monoCell(t) : cell(t)), color, ...(struck ? { textDecorationLine: "line-through", textDecorationColor: t.c.dim } : {}) };
  const dim = { color: t.c.dim };
  // The side's word: above an opened value of a pair, before a value on a line of its own; an arrow before After on a shared line.
  const blockWord = opened && both;
  const prefix = blockWord ? null
    : layout === "split" ? <Text style={[sideWord, dim]}>{`${label} `}</Text>
    : both && side === "after" ? <Text style={dim}>{"→ "}</Text>
    : null;
  let body: ReactNode;
  if (!v) body = <Text style={[text, { color: t.c.dim }]}>{prefix}none</Text>;
  else if (v.text === "") body = <Text style={text}>{prefix}<Text style={dim}>empty</Text></Text>;
  else if (opened && v.lines) {
    const theirs = new Set(other?.lines ?? []);
    body = (
      <>
        {prefix ? <Text style={text}>{prefix}</Text> : null}
        {v.lines.map((l, i) => {
          const marked = !!other?.lines && !theirs.has(l);
          return (
            <Text key={i} testID={marked ? `line-${side === "after" ? "add" : "del"}` : undefined} style={[text, marked ? { color: side === "after" ? t.c.ok : t.c.badText } : null]}>
              <Swatch text={l} />
              {engineText(l)}
            </Text>
          );
        })}
      </>
    );
  } else if (opened) {
    body = <Text style={text}>{prefix}<Swatch color={v.color} />{engineText(v.text)}</Text>;
  } else {
    body = <Text style={text} numberOfLines={1} ellipsizeMode="tail">{prefix}<Swatch color={v.color} />{v.text}</Text>;
  }
  const inner = (
    <>
      {/* The web's font-family: var(--font, inherit) names no variable it defines, so the cell's mono it is. */}
      {blockWord ? <Text style={[font(t, "mono", 400, 10), sideWord, { lineHeight: 18, color: t.c.dim }]}>{label}</Text> : null}
      {body}
    </>
  );
  const style = [{ paddingRight: 6, paddingBottom: 2, minWidth: 0 }, box];
  if (v?.long) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${rowName}, ${label}: ${v.text}`} accessibilityState={{ expanded: opened }} aria-expanded={opened} accessibilityHint={opened ? "Folds it back" : "Shows all of it"} onPress={toggle} style={style} testID={`value-${side}`}>
        {inner}
      </Pressable>
    );
  }
  return <View style={style} testID={`value-${side}`}>{inner}</View>;
}

/**
 * The line a name's text sits on: the row's 18px, except inside a group's
 * toggle in the editor themes, whose `button` rule (400 12px/1.2) outranks the
 * toggle's `all: unset` and gives its name and glyph a 14.4px line.
 */
const nameLine = (t: Theme, inToggle: boolean): number => (inToggle && t.editor ? lineBox(12, 1.2) : 18);

/** A row's name: its levels joined, an engine name breaking only between its parts. */
function Label({ row, parent }: { row: DiffTreeRow; parent: boolean }) {
  const t = useTheme();
  const weight = row.section ? 600 : parent ? 500 : 400;
  const color = row.detail || row.tone === "minor" ? t.c.muted : t.c.text;
  const lineHeight = nameLine(t, parent);
  return (
    <Text style={[cell(t, weight), { lineHeight, color, flexShrink: 1, minWidth: 0 }]}>
      {row.label.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <Text style={[cell(t, 400), { lineHeight, color: t.c.dim }]}>{LABEL_JOIN}</Text> : null}
          {engineText(p)}
        </Fragment>
      ))}
    </Text>
  );
}

/** The change a row is, as a glyph in its colour, and in words for a screen reader. */
function Glyph({ row }: { row: DiffTreeRow }) {
  const t = useTheme();
  const box = { width: 14, flexShrink: 0, textAlign: "center" as const, lineHeight: nameLine(t, row.children.length > 0) };
  if (!row.tone) return <View style={{ width: 14, flexShrink: 0 }} />;
  const color = row.tone === "add" ? t.c.ok : row.tone === "del" ? t.c.bad : row.tone === "mod" ? t.c.warn : t.c.dim;
  return (
    <Text accessibilityLabel={TONE_WORD[row.tone]} style={[font({ ...t, mono: "system-mono" }, "mono", 700, 12), box, { color }]}>
      {TONE_GLYPH[row.tone]}
    </Text>
  );
}

/**
 * The diff as one tree: sections, then the object, node or actor, then the
 * property path, each level open to start (differences the details panel does
 * not show start closed) and closed with its triangle. A phone has no room for
 * columns, so the values go under the name, "False → True" (the web's narrow
 * tier, whatever `tier` says): a short row on the name's line, two long values
 * a line each.
 */
export function DiffTreeGrid({ roots, name, width }: { roots: DiffTreeRow[]; name: string; tier?: CompareTier; width: number }) {
  const t = useTheme();
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const flip = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void) => (id: string) => set((s) => {
    const n = new Set(s);
    if (!n.delete(id)) n.add(id);
    return n;
  });
  const toggle = flip(setToggled);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const openRow = flip(setOpened);
  // The rows' own width: the tree's, inside its hairline.
  const inner = width > 0 ? width - 2 : 0;
  return (
    // role, never accessibilityRole: Android's accessibilityRole parser throws on "treegrid" and "row" and takes the app down.
    <View role="treegrid" accessibilityLabel={`Differences in ${name}`} style={{ borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 4, overflow: "hidden", minWidth: 0 }}>
      {treeLines(roots, toggled).map(({ row, depth, open }, i) => {
        const parent = row.children.length > 0;
        const hasBefore = !!(row.before || row.beforeNone);
        const hasAfter = !!(row.after || row.afterNone);
        const both = hasBefore && hasAfter;
        const layout = rowLayout(row, depth, width);
        const n = parent ? (row.count > (row.tone ? 1 : 0) && !row.tone ? row.count : leaves(row)) : 0;
        const count = n > 0 ? (
          <Text style={[font(t, "sans", 400, 10), { lineHeight: 16, marginTop: 1, marginLeft: 6, paddingHorizontal: 5, borderRadius: 8, color: t.c.muted, backgroundColor: t.c.panel2, flexShrink: 0 }]}>{String(n)}</Text>
        ) : null;
        const twisty = <Text style={[font(t, "sans", 400, 14), { width: 14, flexShrink: 0, lineHeight: 18, textAlign: "center", color: t.c.muted }]}>{parent ? (open ? "▾" : "▸") : ""}</Text>;
        const head = (
          <>
            {twisty}
            <Glyph row={row} />
            <Label row={row} parent={parent} />
            {count}
          </>
        );
        const values = { both, layout, depth, width: inner, open: opened.has(row.id), toggle: () => openRow(row.id), detail: row.detail, rowName: row.label.join(LABEL_JOIN) };
        return (
          <View
            key={row.id}
            testID={`row-${row.id}`}
            role="row"
            aria-level={depth + 1}
            style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", paddingBottom: 1, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: row.section ? t.c.lineStrong : t.c.line, minWidth: 0 }}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-start", minWidth: 0, paddingLeft: 6 + depth * INDENT, paddingRight: 6, paddingVertical: parent ? 5 : 2, ...(layout === "inline" ? { flexShrink: 1 } : { width: "100%" }) }}>
              {parent ? (
                <Pressable accessibilityRole="button" accessibilityLabel={row.label.join(LABEL_JOIN)} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => toggle(row.id)} style={{ flexGrow: 1, flexShrink: 1, flexDirection: "row", alignItems: "flex-start", minWidth: 0, borderRadius: 3 }}>
                  {head}
                </Pressable>
              ) : head}
              {row.note ? <Text numberOfLines={1} style={[cell(t), { marginLeft: 8, minWidth: 0, flexShrink: 1, color: t.c.dim }]}>{engineText(row.note)}</Text> : null}
            </View>
            {hasBefore ? <ValueCell {...values} v={row.before} other={row.after} none={row.beforeNone} side="before" first /> : null}
            {hasAfter ? <ValueCell {...values} v={row.after} other={row.before} none={row.afterNone} side="after" first={!hasBefore} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** .diff-section-head: the title, and a note in small dim. */
function SectionHead({ title, note }: { title: string; note: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 }}>
      <T weight={600} lh={lh(t)}>{engineText(title)}</T>
      <T style={[small(t), { color: t.c.dim }]}>{note}</T>
    </View>
  );
}

/**
 * A diff Unreal produced, laid out for the card's own width. The item's
 * one-line summary is above it on the card, so it is not repeated here.
 */
function ReadyDiff({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: ReactNode }) {
  const t = useTheme();
  const { tier, width, onLayout } = useCardSize(t.base.size);
  const [failed, setFailed] = useState<PictureFailures>({});
  const roots = diffTree(diff);
  return (
    <View onLayout={onLayout} style={{ gap: 8, minWidth: 0 }}>
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} failed={failed} setFailed={setFailed} />
      {diff.classChanged ? (
        <Banner kind="warn">
          <T style={[small(t), { color: t.c.warnText }]}>{`The asset's class changed: ${diff.classChanged}.`}</T>
        </Banner>
      ) : null}
      {roots.length > 0 ? <DiffTreeGrid roots={roots} name={name} tier={tier} width={width} /> : null}
      {(diff.recordsDropped ?? 0) > 0 ? <T style={[small(t), { color: t.c.dim }]}>{`${diff.recordsDropped} more differences past the limit are not listed.`}</T> : null}
      {diff.textDiff?.diff ? (
        <View style={{ gap: 4 }}>
          <SectionHead title={`${diff.textDiff.format.toUpperCase()} export`} note="the text Unreal's own diff compares for this type" />
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </View>
      ) : null}
    </View>
  );
}
