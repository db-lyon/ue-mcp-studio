/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, grouped under the engine's categories with both values side
 * by side, a picture of each version, and the facts that differ between them.
 * The web client's chat/AssetDiff.tsx; what it decides is client-core's.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Image, Pressable, View } from "react-native";
import {
  exportNumber,
  factRows,
  nodeValues,
  readableParts,
  readableValue,
  recordsByGroup,
  unifiedLines,
  type AssetDiff,
  type AssetDiffRecord,
  type AssetDiffSection,
  type AssetVersion,
} from "@ue-mcp-studio/shared";
import {
  coveredFacts,
  diffErrorConsequence,
  isCoveredFact,
  isFlatPicture,
  kindClass,
  kindOf,
  nodeOf,
  nodeSubtitle,
  numberStruct,
  pictureOf,
  pictureWhy,
  thumbnailErrors,
  wantsTile,
  withoutVerb,
  type PictureFailure,
} from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../../nav";
import { Banner, font, T, useTheme, type Theme } from "../../../ui";
import { DiffView } from "../../../chat/Diff";
import { engineText } from "../../../chat/breakable";
import { AssetTile, TILE_FACTS, tileOf } from "../../../chat/AssetTile";
import { useDaemonImage } from "../../../chat/daemon-image";
import { small } from "../../../chat/styles";
import { CompareGroup, CompareRow, CompareTable, KeyValues, PlainRow, Swatch, useCompareTier, type CompareSide, type CompareTier } from "./compare";
import { OutlineButton } from "./TurnReview";
import { picturePixels } from "./picture-pixels";

const lh = (t: Theme): number => (t.editor ? 1.5 : 1.55);

/** .diff-table's 12px, and .mono inside it. */
const cellText = (t: Theme) => ({ fontSize: 12, lineHeight: 12 * lh(t) });
const monoCell = (t: Theme) => [font(t, "mono", 400, 12 * 0.92), { lineHeight: 12 * lh(t), color: t.c.text }];

/** A value as ExportText wrote it, a parameter struct in words, or what its absence means. */
function Value({ v, side }: { v: string | null | undefined; side: "before" | "after" }) {
  const t = useTheme();
  if (v === null || v === undefined) return <T style={[cellText(t), { color: t.c.dim }]}>{side === "before" ? "not there" : "gone"}</T>;
  if (v === "") return <T style={[cellText(t), { color: t.c.dim }]}>empty</T>;
  const parts = readableParts(v);
  if (parts && parts.length > 1) {
    return (
      <View style={{ gap: 2 }}>
        {parts.map((x, i) => (
          // .diff-parts: each part a block line of its own, at the mono size's own line height.
          <T key={i} style={[monoCell(t), { lineHeight: Math.round(12 * 0.92 * lh(t) * 100) / 100 }]}>{engineText(x)}</T>
        ))}
      </View>
    );
  }
  const words = parts?.[0] ?? numberStruct(v) ?? (exportNumber(v) !== v ? exportNumber(v) : null);
  return (
    // The swatch sits inline in the text, so a long value wraps flush with it.
    <T style={monoCell(t)}>
      <Swatch text={v} />
      {engineText(words ?? v)}
    </T>
  );
}

/** Each side whose picture is no picture of it, and why. */
type PictureFailures = Record<string, PictureFailure>;

/**
 * One version's picture, read through the transport. It stays hidden until it
 * has loaded and been looked at, so a blank one (one flat colour, a renderer
 * that drew nothing) never flashes; a blank or unreadable one reports why.
 */
function Picture({ id, label, name, onFail }: { id: string; label: string; name: string; onFail: (why: PictureFailure) => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const uri = useDaemonImage(api.reviewThumbnailUrl(id));
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (uri === "failed") return onFail("unreadable");
    if (!uri) return;
    let live = true;
    void picturePixels(uri).then((px) => {
      if (!live) return;
      if (px && isFlatPicture(px)) onFail("blank");
      else setSeen(true);
    });
    return () => {
      live = false;
    };
  }, [uri]);
  return (
    <View style={{ flex: 1, minWidth: 0, maxWidth: 220, gap: 4 }}>
      <View style={{ width: "100%", aspectRatio: 1, borderWidth: 1, borderColor: t.c.line, borderRadius: 4, backgroundColor: t.c.panel2, overflow: "hidden", opacity: seen ? 1 : 0 }}>
        {uri && uri !== "failed" ? <Image accessibilityLabel={`${name} ${label.toLowerCase()}`} source={{ uri }} style={{ width: "100%", height: "100%" }} /> : null}
      </View>
      <T style={[small(t), { color: t.c.dim }]}>{label}</T>
    </View>
  );
}

/**
 * A picture of each version that has one. Where neither has one, a new,
 * deleted or record-less asset gets its tile in the space; a changed one with
 * records gets nothing, the records being the change. A version with no
 * picture beside one that has says why in words, never in an empty frame.
 */
function Pictures({ diff, name, asset, status, failed, setFailed }: {
  diff: AssetDiff;
  name: string;
  asset?: string;
  status: "added" | "modified" | "deleted";
  failed: PictureFailures;
  setFailed: (f: (old: PictureFailures) => PictureFailures) => void;
}) {
  const t = useTheme();
  const sides = [
    { label: "Before", v: diff.before, missing: "Did not exist before this turn" },
    { label: "After", v: diff.after, missing: "Deleted in this turn" },
  ];
  const shown = sides.filter((s) => pictureOf(s.v) && !failed[s.label]);
  if (shown.length === 0) {
    if (!wantsTile(diff, status)) return null;
    const errors = thumbnailErrors(diff);
    const tile = tileOf(diff, name, asset, status);
    // Beside the other version, the tile names only the facts that changed; the rest are counted below.
    if (diff.before && diff.after) tile.facts = tile.facts.filter((f) => f.was !== undefined);
    return <AssetTile {...tile} note={errors.length && status !== "modified" ? `No picture: ${engineText(errors.join("; "))}` : undefined} />;
  }
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {sides.map((s) => {
        const p = pictureOf(s.v);
        if (p && !failed[s.label]) return <Picture key={s.label} id={p.id} label={s.label} name={name} onFail={(why) => setFailed((f) => (f[s.label] ? f : { ...f, [s.label]: why }))} />;
        return (
          <View key={s.label} style={{ flex: 1, minWidth: 0, maxWidth: 220, paddingTop: 2, gap: 2 }}>
            <T style={[small(t), { color: t.c.dim }]}>{s.label}</T>
            <T style={[small(t), { color: t.c.dim }]}>{engineText(pictureWhy(s.v, s.missing, failed[s.label]))}</T>
          </View>
        );
      })}
    </View>
  );
}

/** What an added or removed node or actor holds, so an added Constant shows its number; null when it holds nothing. */
function heldBy(r: AssetDiffRecord): ReactNode {
  const node = r.diffType === "NODE_ADDED" || r.diffType === "NODE_REMOVED" ? (r.node1 ?? r.node2) : undefined;
  const values = [...nodeValues(node).map((v) => ({ name: v.name, value: readableValue(v.value) ?? exportNumber(v.value) })), ...(r.facts ?? [])];
  const dropped = node?.propertiesDropped ?? 0;
  if (!values.length && !dropped) return null;
  return <HeldValues values={values} dropped={dropped} />;
}

function HeldValues({ values, dropped }: { values: Array<{ name: string; value: string }>; dropped: number }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 2 }}>
      {values.length > 0 ? <KeyValues values={values} /> : null}
      {dropped > 0 ? <T style={[small(t), { color: t.c.dim }]}>{`${dropped} more properties not listed.`}</T> : null}
    </View>
  );
}

const sideOf = (v: string | null | undefined, side: "before" | "after"): CompareSide => (v === null ? "absent" : v === undefined ? null : { content: <Value v={v} side={side} /> });

/**
 * .diff-kind: the change's badge, an inline block before its text: a box of its
 * own line height and border, sitting on the text's baseline, 6 pixels before it.
 */
function Kind({ k, tone }: { k: string; tone: string }) {
  const t = useTheme();
  const color = tone === "add" ? t.c.ok : tone === "del" ? t.c.bad : tone === "mod" ? t.c.warn : t.c.muted;
  const line = tone === "add" ? t.c.ok : tone === "del" ? t.c.bad : tone === "mod" ? t.c.warn : t.c.lineStrong;
  return (
    <View style={{ borderWidth: 1, borderColor: line, borderRadius: 3, paddingHorizontal: 5, marginRight: 6, opacity: tone === "minor" ? 0.7 : 1 }}>
      <T style={{ fontSize: 10, lineHeight: 10 * lh(t), letterSpacing: 0.5, textTransform: "uppercase", color }}>{k}</T>
    </View>
  );
}

/**
 * The records as comparison rows. A property's two values go under Before and
 * After; an added node's or actor's values under After and a removed one's
 * under Before; the engine's message, the badge and its subtitle under Change.
 * A graph record that only says its node's properties changed is those
 * properties, each named by the node; a pin default change shows the pin's
 * defaults.
 */
function RecordRows({ entries, sub, owner }: { entries: AssetDiffRecord[]; sub?: boolean; owner?: string }) {
  const t = useTheme();
  return (
    <>
      {entries.map((r, i) => {
        if (r.properties?.length && r.before === undefined && r.after === undefined && (r.diffType === "NODE_PROPERTY" || r.diffType === "OBJECT_PROPERTY")) {
          return <RecordRows key={i} entries={r.properties} owner={nodeOf(r)} />;
        }
        const k = kindOf(r);
        const tone = kindClass(k);
        const pinDefaults = r.diffType === "PIN_DEFAULT_VALUE" && r.pin1 && r.pin2 ? { before: r.pin1.defaultValue, after: r.pin2.defaultValue } : null;
        const values = r.before !== undefined || r.after !== undefined || !!pinDefaults;
        const node = nodeOf(r);
        const subtitle = nodeSubtitle(r) ?? (r.toolTip && r.toolTip !== r.displayString ? r.toolTip : null);
        const size = tone === "minor" ? 11 : 12;
        const text = values && r.path !== undefined ? (owner ? `${owner} > ${r.label ?? r.path}` : r.label ?? r.path) : withoutVerb(r.displayString, k);
        const change = (
          <View>
            {/* A minor row's 11px line is shorter than its badge, which sits inline-block on the web and stretches the line to 18 pixels. */}
            <T style={{ fontSize: size, lineHeight: tone === "minor" ? (t.editor ? 17 : 18) : size * lh(t), color: tone === "minor" ? t.c.muted : t.c.text }}>
              <Kind k={k} tone={tone} />
              {engineText(text)}
              {node && !r.displayString.includes(node) ? <T style={{ fontSize: size, lineHeight: size * lh(t), color: t.c.dim }}>{` on ${engineText(node)}`}</T> : null}
            </T>
            {subtitle ? <T style={[small(t), { marginTop: 2, color: t.c.dim }]}>{engineText(subtitle)}</T> : null}
          </View>
        );
        let before: CompareSide = null;
        let after: CompareSide = null;
        if (pinDefaults) {
          before = sideOf(pinDefaults.before, "before");
          after = sideOf(pinDefaults.after, "after");
        } else if (values) {
          before = sideOf(r.before, "before");
          after = sideOf(r.after, "after");
        } else {
          const held = heldBy(r);
          const content = held ? { content: held } : null;
          if (content && tone === "del") [before, after] = [content, "absent"];
          else if (content && tone === "add") [before, after] = ["absent", content];
          else if (content) after = content;
        }
        return (
          <Fragment key={i}>
            <CompareRow tone={tone} change={change} before={before} after={after} sub={sub} index={i} />
            {r.properties && r.properties.length > 0 ? <RecordRows entries={r.properties} sub /> : null}
          </Fragment>
        );
      })}
    </>
  );
}

function RecordTable({ entries, graph, tier }: { entries: AssetDiffRecord[]; graph: boolean; tier: CompareTier }) {
  return (
    <CompareTable tier={tier} head={[graph ? "Change" : "Property", "Before", "After"]}>
      {recordsByGroup(entries).map((g) => (
        <Fragment key={g.group ?? ""}>
          {g.group !== null ? <CompareGroup>{g.group}</CompareGroup> : null}
          <RecordRows entries={g.entries} />
        </Fragment>
      ))}
    </CompareTable>
  );
}

/** .diff-section-head: the title, and a count in small dim. */
function SectionHead({ title, note }: { title: string; note: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 }}>
      <T weight={600}>{engineText(title)}</T>
      <T style={[small(t), { color: t.c.dim }]}>{note}</T>
    </View>
  );
}

function Section({ s, tier }: { s: AssetDiffSection; tier: CompareTier }) {
  const shown = s.entries.filter((e) => !e.hidden);
  const hidden = s.entries.filter((e) => e.hidden);
  const [openHidden, setOpenHidden] = useState(shown.length === 0);
  return (
    <View accessibilityLabel={s.category} style={{ gap: 4, minWidth: 0 }}>
      <SectionHead title={s.category} note={shown.length === 1 ? "1 difference" : `${shown.length} differences`} />
      {shown.length > 0 ? <RecordTable entries={shown} graph={s.kind === "graph"} tier={tier} /> : null}
      {hidden.length > 0 ? (
        <View style={{ gap: 4, alignItems: "flex-start" }}>
          <OutlineButton
            title={`${openHidden ? "Hide" : "Show"} ${hidden.length === 1 ? "1 more difference" : `${hidden.length} more differences`} in properties the details panel does not show`}
            expanded={openHidden}
            onPress={() => setOpenHidden(!openHidden)}
            left
          />
          {openHidden ? <View style={{ alignSelf: "stretch" }}><RecordTable entries={hidden} graph={false} tier={tier} /></View> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A fact's name in its cell. */
function FactName({ name }: { name: string }) {
  const t = useTheme();
  return <T style={cellText(t)}>{engineText(name)}</T>;
}

/** The browser's disclosure triangle on a <summary>: right while closed, down while open, in the summary's colour. */
function Disclosure({ open, color }: { open: boolean; color: string }) {
  return open ? (
    <View style={{ width: 0, height: 0, marginTop: 7, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 6, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: color, marginRight: 5.7 }} />
  ) : (
    <View style={{ width: 0, height: 0, marginTop: 6, borderTopWidth: 4, borderBottomWidth: 4, borderLeftWidth: 6, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: color, marginRight: 6.7 }} />
  );
}

/**
 * <details class="diff-unchanged small dim">: a summary 44 pixels tall (a finger's size) with the browser's
 * triangle that opens what follows. Closed, the flex gap before the hidden body still counts, so 4 pixels follow it.
 */
function Fold({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} style={{ flexDirection: "row", alignItems: "flex-start", alignSelf: "flex-start", minHeight: 44, marginBottom: open ? 2 : 4 }}>
        <Disclosure open={open} color={t.c.dim} />
        <T style={[small(t), { color: t.c.dim }]}>{title}</T>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/**
 * Facts about each version: LOD counts, sizes, parameters. With both versions,
 * only the facts that differ and that no record already shows are compared,
 * Before beside After; the ones that are the same are counted on one folded
 * line and listed once, uncoloured, when opened. With one version, its facts.
 * The tile lists up to TILE_FACTS of them, so they are not repeated when they
 * fit there.
 */
function Facts({ before, after, tiled, covered, tier }: { before: AssetVersion | null | undefined; after: AssetVersion | null | undefined; tiled: boolean; covered: Set<string>; tier: CompareTier }) {
  const rows = factRows(before, after);
  const both = !!before && !!after;
  const [openOne, setOpenOne] = useState(!tiled);
  const [openSame, setOpenSame] = useState(false);
  if (rows.length === 0 || (!both && tiled && rows.length <= TILE_FACTS)) return null;
  if (!both) {
    const side = before ? "before" : "after";
    return (
      <View style={{ gap: 4, alignItems: "flex-start", minWidth: 0 }}>
        <OutlineButton title={`${openOne ? "Hide" : "Show"} details of this version (${rows.length})`} expanded={openOne} onPress={() => setOpenOne(!openOne)} left />
        {openOne ? (
          <View style={{ alignSelf: "stretch" }}>
            <CompareTable tier={tier} head={["Fact", "Value"]}>
              {rows.map((r, i) => (
                <PlainRow key={r.name} index={i} name={<FactName name={r.name} />} value={<Value v={(side === "before" ? r.before : r.after) ?? null} side={side} />} />
              ))}
            </CompareTable>
          </View>
        ) : null}
      </View>
    );
  }
  const changed = rows.filter((r) => r.changed && !isCoveredFact(covered, r.name));
  const same = rows.filter((r) => !r.changed);
  return (
    <>
      {changed.length > 0 && !(tiled && changed.length <= TILE_FACTS) ? (
        <View accessibilityLabel="Facts" style={{ gap: 4, minWidth: 0 }}>
          <SectionHead title="Facts" note={changed.length === 1 ? "1 changed" : `${changed.length} changed`} />
          <CompareTable tier={tier} head={["Fact", "Before", "After"]}>
            {changed.map((r, i) => (
              <CompareRow key={r.name} index={i} tone="mod" change={<FactName name={r.name} />} before={{ content: <Value v={r.before ?? null} side="before" /> }} after={{ content: <Value v={r.after ?? null} side="after" /> }} />
            ))}
          </CompareTable>
        </View>
      ) : null}
      {same.length > 0 ? (
        <Fold title={same.length === 1 ? "1 unchanged fact" : `${same.length} unchanged facts`} open={openSame} onToggle={() => setOpenSame(!openSame)}>
          <CompareTable tier={tier} head={["Fact", "Both versions"]}>
            {same.map((r, i) => (
              <PlainRow key={r.name} index={i} name={<FactName name={r.name} />} value={<Value v={r.after ?? null} side="after" />} />
            ))}
          </CompareTable>
        </Fold>
      ) : null}
    </>
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
 * A diff Unreal produced, laid out for the card's own width. The item's
 * one-line summary is above it on the card, so it is not repeated here.
 */
function ReadyDiff({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: ReactNode }) {
  const t = useTheme();
  const { tier, onLayout } = useCompareTier(t.base.size);
  const sections = diff.sections ?? [];
  const [failed, setFailed] = useState<PictureFailures>({});
  const pictured = [diff.before, diff.after].filter((v, i) => pictureOf(v) && !failed[i === 0 ? "Before" : "After"]).length;
  return (
    <View onLayout={onLayout} style={{ gap: 8, minWidth: 0 }}>
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} failed={failed} setFailed={setFailed} />
      {diff.classChanged ? (
        <Banner kind="warn">
          <T style={[small(t), { color: t.c.warnText }]}>{`The asset's class changed: ${diff.classChanged}.`}</T>
        </Banner>
      ) : null}
      {sections.map((s) => (
        <Section key={s.category} s={s} tier={tier} />
      ))}
      {(diff.recordsDropped ?? 0) > 0 ? <T style={[small(t), { color: t.c.dim }]}>{`${diff.recordsDropped} more differences past the limit are not listed.`}</T> : null}
      {diff.textDiff?.diff ? (
        <View style={{ gap: 4 }}>
          <SectionHead title={`${diff.textDiff.format.toUpperCase()} export`} note="the text Unreal's own diff compares for this type" />
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </View>
      ) : null}
      <Facts before={diff.before} after={diff.after} tiled={pictured === 0 && wantsTile(diff, status)} covered={coveredFacts(sections)} tier={tier} />
    </View>
  );
}
