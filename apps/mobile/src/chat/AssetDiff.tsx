/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, grouped under the engine's categories with both values side
 * by side, a picture of each version, and the facts about each version.
 */
import { Fragment, useState, type ReactNode } from "react";
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
import { diffErrorConsequence, kindClass, kindOf, nodeOf, nodeSubtitle, pictureOf, pictureWhy, thumbnailErrors } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import { Banner, font, T, useTheme, type Theme } from "../ui";
import { DiffView } from "./Diff";
import { engineText } from "./breakable";
import { AssetTile, TILE_FACTS, tileOf } from "./AssetTile";
import { CompareGroup, CompareRow, CompareTable, KeyValues, Swatch, useCompareTier, type CompareSide, type CompareTier } from "./compare";
import { useDaemonImage } from "./daemon-image";
import { small } from "./styles";
import { OutlineButton } from "./TurnReview";

const lh = (t: Theme): number => (t.editor ? 1.5 : 1.55);

/** A value as ExportText wrote it, a parameter struct in words, or what its absence means. */
function Value({ v, side }: { v: string | null | undefined; side: "before" | "after" }) {
  const t = useTheme();
  const mono = [font(t, "mono", 400, 12 * 0.92), { lineHeight: 12 * lh(t), color: t.c.text }];
  if (v === null || v === undefined) return <T size={12} tone="dim">{side === "before" ? "not there" : "gone"}</T>;
  if (v === "") return <T size={12} tone="dim">empty</T>;
  const parts = readableParts(v);
  if (parts && parts.length > 1) {
    return (
      <View style={{ gap: 2 }}>
        {parts.map((x, i) => (
          <T key={i} style={mono}>{engineText(x)}</T>
        ))}
      </View>
    );
  }
  const words = parts?.[0] ?? (exportNumber(v) !== v ? exportNumber(v) : null);
  return (
    <View style={{ flexDirection: "row", minWidth: 0 }}>
      <Swatch text={v} />
      <T style={[mono, { flexShrink: 1 }]}>{engineText(words ?? v)}</T>
    </View>
  );
}

/** One version's picture, read through the transport; `onFail` when it cannot be read. */
function Picture({ id, label, cls, name, onFail }: { id: string; label: string; cls: string; name: string; onFail: () => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const uri = useDaemonImage(api.reviewThumbnailUrl(id));
  if (uri === "failed") {
    onFail();
    return null;
  }
  return (
    <View style={{ flex: 1, minWidth: 0, maxWidth: 220, gap: 4 }}>
      <View style={{ width: "100%", aspectRatio: 1, borderWidth: 1, borderColor: t.c.line, borderRadius: 4, backgroundColor: t.c.panel2, overflow: "hidden" }}>
        {uri ? <Image accessibilityLabel={`${name} ${label.toLowerCase()}`} source={{ uri }} style={{ width: "100%", height: "100%" }} /> : null}
      </View>
      <View>
        <T style={[small(t), { color: t.c.dim }]}>{label}</T>
        <T style={[small(t), { color: t.c.dim }]}>{engineText(cls)}</T>
      </View>
    </View>
  );
}

/**
 * A picture of each version that has one. Where neither has, the asset's tile
 * takes the space. A version with no picture beside one that has says why in
 * words, never in an empty frame.
 */
function Pictures({ diff, name, asset, status }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted" }) {
  const t = useTheme();
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const sides = [
    { label: "Before", v: diff.before, missing: "Did not exist before this turn" },
    { label: "After", v: diff.after, missing: "Deleted in this turn" },
  ];
  const shown = sides.filter((s) => pictureOf(s.v) && !failed[s.label]);
  if (shown.length === 0) {
    const errors = thumbnailErrors(diff);
    return <AssetTile {...tileOf(diff, name, asset, status)} note={errors.length ? `No picture: ${engineText(errors.join("; "))}` : undefined} />;
  }
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {sides.map((s) => {
        const p = pictureOf(s.v);
        if (p && !failed[s.label]) return <Picture key={s.label} id={p.id} label={s.label} cls={s.v!.class} name={name} onFail={() => setFailed((f) => (f[s.label] ? f : { ...f, [s.label]: true }))} />;
        return (
          <View key={s.label} style={{ flex: 1, minWidth: 0, maxWidth: 220, paddingTop: 2, gap: 2 }}>
            <T style={[small(t), { color: t.c.dim }]}>{s.label}</T>
            <T style={[small(t), { color: t.c.dim }]}>{engineText(pictureWhy(s.v, s.missing, !!failed[s.label]))}</T>
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
  return (
    <View style={{ marginTop: 2 }}>
      {values.length > 0 ? <KeyValues values={values} /> : null}
      {dropped > 0 ? <T size={12} tone="dim">{`${dropped} more properties not listed.`}</T> : null}
    </View>
  );
}

const sideOf = (v: string | null | undefined, side: "before" | "after"): CompareSide => (v === null ? "absent" : v === undefined ? null : { content: <Value v={v} side={side} /> });

/** .diff-kind: the change's badge, inline before its text. */
function Kind({ k, tone }: { k: string; tone: string }) {
  const t = useTheme();
  const color = tone === "add" ? t.c.ok : tone === "del" ? t.c.bad : tone === "mod" ? t.c.warn : t.c.muted;
  const line = tone === "add" ? t.c.ok : tone === "del" ? t.c.bad : tone === "mod" ? t.c.warn : t.c.lineStrong;
  return <T style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color, borderWidth: 1, borderColor: line, borderRadius: 3, paddingHorizontal: 5, opacity: tone === "minor" ? 0.7 : 1 }}>{k}</T>;
}

/** The records as comparison rows. A graph record's property changes follow it as rows of their own. */
function RecordRows({ entries, sub }: { entries: AssetDiffRecord[]; sub?: boolean }) {
  const t = useTheme();
  return (
    <>
      {entries.map((r, i) => {
        const k = kindOf(r);
        const tone = kindClass(k);
        const values = r.before !== undefined || r.after !== undefined;
        const node = nodeOf(r);
        const subtitle = nodeSubtitle(r) ?? (r.toolTip && r.toolTip !== r.displayString ? r.toolTip : null);
        const size = tone === "minor" ? 11 : 12;
        const change = (
          <View>
            <T style={{ fontSize: size, lineHeight: size * lh(t), color: tone === "minor" ? t.c.muted : t.c.text }}>
              <Kind k={k} tone={tone} />
              {"  "}
              {engineText(values && r.path !== undefined ? r.path : r.displayString)}
              {node && !r.displayString.includes(node) ? <T style={{ fontSize: size, color: t.c.dim }}>{` on ${engineText(node)}`}</T> : null}
            </T>
            {subtitle ? <T style={[small(t), { marginTop: 2, color: t.c.dim }]}>{engineText(subtitle)}</T> : null}
          </View>
        );
        let before: CompareSide = null;
        let after: CompareSide = null;
        if (values) {
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

/** Facts about each version side by side: LODs, sizes, parameters. */
function Facts({ before, after, tiled, tier }: { before: AssetVersion | null | undefined; after: AssetVersion | null | undefined; tiled: boolean; tier: CompareTier }) {
  const t = useTheme();
  const rows = factRows(before, after);
  const [open, setOpen] = useState(!tiled && (!before || !after));
  // The tile already lists up to TILE_FACTS of them.
  if (rows.length === 0 || (tiled && rows.length <= TILE_FACTS)) return null;
  const changed = rows.filter((r) => r.changed).length;
  const count = before && after ? (changed ? ` (${changed} ${changed === 1 ? "fact differs" : "facts differ"})` : " (no fact differs)") : "";
  return (
    <View style={{ gap: 4, alignItems: "flex-start" }}>
      <OutlineButton title={`${open ? "Hide" : "Show"} details of ${before && after ? "both versions" : "this version"}${count}`} expanded={open} onPress={() => setOpen(!open)} left />
      {open ? (
        <View style={{ alignSelf: "stretch" }}>
          <CompareTable tier={tier} head={["Fact", before ? "Before" : undefined, after ? "After" : undefined]}>
            {rows.map((r, i) => (
              <CompareRow
                key={r.name}
                index={i}
                tone={r.changed ? "mod" : ""}
                change={<T style={{ fontSize: 12, lineHeight: 12 * lh(t) }}>{engineText(r.name)}</T>}
                before={before ? { content: <Value v={r.before ?? null} side="before" /> } : null}
                after={after ? { content: <Value v={r.after ?? null} side="after" /> } : null}
              />
            ))}
          </CompareTable>
        </View>
      ) : null}
    </View>
  );
}

/** A package's diff from Unreal's diff code. */
export function AssetDiffView({ diff, name, asset, status, blueprintTree, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; blueprintTree?: ReactNode; nativeNote?: ReactNode }) {
  const t = useTheme();
  if (diff.state === "error") {
    return (
      <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
        <T style={[small(t), { color: t.c.badText }]}>Unreal could not load this asset to diff it, so there is no before and after to show.</T>
        <T style={[font(t, "mono", 400, 12 * 0.92), { color: t.c.badText }]}>{engineText(diff.error ?? "No reason was given.")}</T>
        <T style={[small(t), { color: t.c.badText }]}>{diffErrorConsequence(status)}</T>
      </Banner>
    );
  }
  if (diff.state === "deferred") return <T style={[small(t), { color: t.c.dim }]}>Diffing in the editor.</T>;
  return <ReadyDiff diff={diff} name={name} asset={asset} status={status} blueprintTree={blueprintTree} nativeNote={nativeNote} />;
}

/** A diff Unreal produced, laid out for the card's own width. */
function ReadyDiff({ diff, name, asset, status, blueprintTree, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; blueprintTree?: ReactNode; nativeNote?: ReactNode }) {
  const t = useTheme();
  const { tier, onLayout } = useCompareTier(t.base.size);
  const [engineOpen, setEngineOpen] = useState(false);
  const sections = diff.sections ?? [];
  const records = sections.reduce((n, s) => n + s.entries.length, 0);
  return (
    <View onLayout={onLayout} style={{ gap: 8, minWidth: 0 }}>
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} />
      {diff.classChanged ? <Banner kind="warn" style={{ marginBottom: 0 }}><T style={[small(t), { color: t.c.warnText }]}>{`The asset's class changed: ${diff.classChanged}.`}</T></Banner> : null}
      {sections.map((s) => (
        <Section key={s.category} s={s} tier={tier} />
      ))}
      {diff.status === "modified" && records === 0 && !diff.textDiff ? <T style={[small(t), { color: t.c.dim }]}>{diff.summary}</T> : null}
      {(diff.recordsDropped ?? 0) > 0 ? <T style={[small(t), { color: t.c.dim }]}>{`${diff.recordsDropped} more differences past the limit are not listed.`}</T> : null}
      {diff.textDiff?.diff ? (
        <View style={{ gap: 4 }}>
          <SectionHead title={`${diff.textDiff.format.toUpperCase()} export`} note="the text Unreal's own diff compares for this type" />
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </View>
      ) : null}
      <Facts before={diff.before} after={diff.after} tiled={!pictureOf(diff.before) && !pictureOf(diff.after)} tier={tier} />
      {blueprintTree}
      {diff.engine ? (
        <View>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: engineOpen }} onPress={() => setEngineOpen(!engineOpen)} style={{ minHeight: 44, justifyContent: "center" }}>
            <T style={[small(t), { color: t.c.dim }]}>{`${engineOpen ? "▾" : "▸"} How Unreal compared this`}</T>
          </Pressable>
          {engineOpen ? <T style={[small(t), { color: t.c.dim }]}>{diff.engine.note}</T> : null}
        </View>
      ) : null}
    </View>
  );
}
