/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, grouped under the engine's categories with both values side
 * by side, a picture of each version, and the facts about each version.
 */
import { Fragment, useRef, useState, type ReactNode } from "react";
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
  wantsTile,
  withoutVerb,
  type PictureFailure,
} from "@ue-mcp-studio/client-core";
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
import { api } from "../api";
import { DiffView } from "./Diff";
import { EngineText } from "./breakable";
import { AssetTile, TILE_FACTS, tileOf } from "./AssetTile";
import { CompareRow, KeyValues, Swatch, useCompareTier, type CompareSide } from "./compare";

/** A value as ExportText wrote it, a parameter struct in words, or what its absence means. */
function Value({ v, side }: { v: string | null | undefined; side: "before" | "after" }) {
  if (v === null || v === undefined) return <span className="dim">{side === "before" ? "not there" : "gone"}</span>;
  if (v === "") return <span className="dim">empty</span>;
  const parts = readableParts(v);
  if (parts && parts.length > 1) return <span className="mono diff-value diff-parts" title={v}>{parts.map((x, i) => <span key={i}><EngineText text={x} /></span>)}</span>;
  const words = parts?.[0] ?? numberStruct(v) ?? (exportNumber(v) !== v ? exportNumber(v) : null);
  return <span className="mono diff-value" title={words ? v : undefined}><Swatch text={v} /><EngineText text={words ?? v} /></span>;
}

/** A loaded picture's pixels, read through a small canvas; null where the browser will not give them. */
function pixelsOf(img: HTMLImageElement): Uint8ClampedArray | null {
  try {
    const n = 64;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, n, n);
    return ctx.getImageData(0, 0, n, n).data;
  } catch {
    return null;
  }
}

/**
 * A picture of each version that has one; a picture that loads as one flat
 * colour (a renderer that drew nothing) is no picture. Where neither has one,
 * a new, deleted or record-less asset gets its tile in the space: its type,
 * path and facts; a changed one with records gets nothing, the records being
 * the change. A version with no picture beside one that has says why in
 * words, never in an empty frame.
 */

/** Each side whose picture is no picture of it, and why. */
type PictureFailures = Record<string, PictureFailure>;

function Pictures({ diff, name, asset, status, failed, setFailed }: {
  diff: AssetDiff;
  name: string;
  asset?: string;
  status: "added" | "modified" | "deleted";
  failed: PictureFailures;
  setFailed: (f: (old: PictureFailures) => PictureFailures) => void;
}) {
  /** Sides whose picture has loaded and been looked at; until then it is not shown, so a blank one never flashes. */
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const sides = [
    { label: "Before", v: diff.before, missing: "Did not exist before this turn" },
    { label: "After", v: diff.after, missing: "Deleted in this turn" },
  ];
  const loaded = (label: string, img: HTMLImageElement) => {
    const px = pixelsOf(img);
    if (px && isFlatPicture(px)) setFailed((f) => ({ ...f, [label]: "blank" }));
    else setSeen((s) => ({ ...s, [label]: true }));
  };
  const shown = sides.filter((s) => pictureOf(s.v) && !failed[s.label]);
  if (shown.length === 0) {
    if (!wantsTile(diff, status)) return null;
    const errors = [...new Set(sides.flatMap((s) => (s.v?.thumbnail && "error" in s.v.thumbnail ? [s.v.thumbnail.error] : [])))];
    const tile = tileOf(diff, name, asset, status);
    // Beside the other version, the tile names only the facts that changed; the rest are counted below.
    if (diff.before && diff.after) tile.facts = tile.facts.filter((f) => f.was !== undefined);
    return <AssetTile {...tile} note={errors.length && status !== "modified" ? <>No picture: <EngineText text={errors.join("; ")} /></> : undefined} />;
  }
  return (
    <div className="review-pictures">
      {sides.map((s) => {
        const t = pictureOf(s.v);
        if (t && !failed[s.label]) {
          return (
            <figure key={s.label}>
              <img
                src={api.reviewThumbnailUrl(t.id)}
                alt={`${name} ${s.label.toLowerCase()}`}
                title={t.source === "saved" ? `The thumbnail saved with this version. ${t.note ?? ""}` : "Rendered from this version"}
                className={seen[s.label] ? undefined : "picture-pending"}
                onLoad={(e) => loaded(s.label, e.currentTarget)}
                onError={() => setFailed((f) => ({ ...f, [s.label]: "unreadable" }))}
              />
              <figcaption className="small dim"><span className="picture-label">{s.label}</span></figcaption>
            </figure>
          );
        }
        const why = pictureWhy(s.v, s.missing, failed[s.label]);
        return (
          <div key={s.label} className="review-picture-side small">
            <span className="picture-label dim">{s.label}</span>
            <span className="dim"><EngineText text={why} /></span>
          </div>
        );
      })}
    </div>
  );
}

/** What an added or removed node or actor holds, so an added Constant shows its number; null when it holds nothing. */
function heldBy(r: AssetDiffRecord): ReactNode {
  const node = r.diffType === "NODE_ADDED" || r.diffType === "NODE_REMOVED" ? r.node1 ?? r.node2 : undefined;
  const values = [...nodeValues(node).map((v) => ({ name: v.name, value: readableValue(v.value) ?? exportNumber(v.value) })), ...(r.facts ?? [])];
  const dropped = node?.propertiesDropped ?? 0;
  if (!values.length && !dropped) return null;
  return (
    <div className="diff-node-values">
      {values.length > 0 && <KeyValues values={values} />}
      {dropped > 0 && <div className="dim small">{dropped} more properties not listed.</div>}
    </div>
  );
}

const sideOf = (v: string | null | undefined, side: "before" | "after"): CompareSide => (v === null ? "absent" : v === undefined ? null : { content: <Value v={v} side={side} /> });

/**
 * The records as comparison rows, every cell in its column. A property's two
 * values go under Before and After; an added node's or actor's values under
 * After and a removed one's under Before; the engine's message, the badge and
 * its subtitle under Change. A graph record's property changes follow it as
 * rows of their own.
 */
function RecordRows({ entries, sub, owner }: { entries: AssetDiffRecord[]; sub?: boolean; owner?: string }) {
  return (
    <>
      {entries.map((r, i) => {
        // A graph record that only says its node's properties changed is those properties, each named by the node.
        if (r.properties?.length && r.before === undefined && r.after === undefined && (r.diffType === "NODE_PROPERTY" || r.diffType === "OBJECT_PROPERTY")) {
          return <RecordRows key={i} entries={r.properties} owner={nodeOf(r)} />;
        }
        const k = kindOf(r);
        const tone = kindClass(k);
        // A pin's default value change carries both defaults on its pins.
        const pinDefaults = r.diffType === "PIN_DEFAULT_VALUE" && r.pin1 && r.pin2 ? { before: r.pin1.defaultValue, after: r.pin2.defaultValue } : null;
        const values = r.before !== undefined || r.after !== undefined || !!pinDefaults;
        const node = nodeOf(r);
        const subtitle = nodeSubtitle(r) ?? (r.toolTip && r.toolTip !== r.displayString ? r.toolTip : null);
        const change = (
          <>
            <span className={`diff-kind ${tone}`}>{k}</span>
            {values && r.path !== undefined
              ? <span className="diff-path" title={r.label && r.label !== r.path ? `${r.path}: ${r.displayString}` : r.displayString}><EngineText text={owner ? `${owner} > ${r.label ?? r.path}` : r.label ?? r.path} /></span>
              : <span className="diff-message" title={r.toolTip ?? r.displayString}><EngineText text={withoutVerb(r.displayString, k)} /></span>}
            {node && !r.displayString.includes(node) && <span className="dim"> on <EngineText text={node} /></span>}
            {subtitle && <div className="cmp-subtitle dim small"><EngineText text={subtitle} /></div>}
          </>
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
            <CompareRow tone={tone} change={change} before={before} after={after} sub={sub} />
            {r.properties && r.properties.length > 0 && <RecordRows entries={r.properties} sub />}
          </Fragment>
        );
      })}
    </>
  );
}

function RecordTable({ entries, graph }: { entries: AssetDiffRecord[]; graph: boolean }) {
  return (
    <div className="diff-table-wrap">
      <table className="diff-table">
        <thead><tr><th>{graph ? "Change" : "Property"}</th><th className="cmp-before">Before</th><th className="cmp-after">After</th></tr></thead>
        <tbody>
          {recordsByGroup(entries).map((g) => (
            <GroupRows key={g.group ?? ""} group={g.group} entries={g.entries} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ s }: { s: AssetDiffSection }) {
  const shown = s.entries.filter((e) => !e.hidden);
  const hidden = s.entries.filter((e) => e.hidden);
  const [openHidden, setOpenHidden] = useState(shown.length === 0);
  return (
    <section className="diff-section" aria-label={s.category}>
      <div className="diff-section-head" title={[`From Unreal's ${s.engineSource}`, ...(s.notes ?? [])].join("\n")}>
        <span className="diff-section-title"><EngineText text={s.category} /></span>
        <span className="dim small">{shown.length === 1 ? "1 difference" : `${shown.length} differences`}</span>
      </div>
      {shown.length > 0 && <RecordTable entries={shown} graph={s.kind === "graph"} />}
      {hidden.length > 0 && (
        <div className="diff-hidden">
          <button className="ghost small-button diff-toggle" aria-expanded={openHidden} onClick={() => setOpenHidden(!openHidden)}>
            {openHidden ? "Hide" : "Show"} {hidden.length === 1 ? "1 more difference" : `${hidden.length} more differences`} in properties the details panel does not show
          </button>
          {openHidden && <RecordTable entries={hidden} graph={false} />}
        </div>
      )}
    </section>
  );
}

function GroupRows({ group, entries }: { group: string | null; entries: AssetDiffRecord[] }) {
  return (
    <>
      {group !== null && (
        <tr className="diff-group"><th colSpan={3}><EngineText text={group} /></th></tr>
      )}
      <RecordRows entries={entries} />
    </>
  );
}

/** A fact's value cell. */
const FactValue = ({ v, side }: { v: string | undefined; side: "before" | "after" }) => <Value v={v ?? null} side={side} />;

/**
 * Facts about each version: LOD counts, sizes, parameters. With both versions,
 * only the facts that differ and that no record already shows are compared,
 * Before beside After; the ones that are the same are counted on one folded
 * line and listed once, uncoloured, when opened. With one version, its facts.
 * The tile lists up to TILE_FACTS of them, so they are not repeated when they
 * fit there.
 */
function Facts({ before, after, tiled, covered }: { before: AssetVersion | null | undefined; after: AssetVersion | null | undefined; tiled: boolean; covered: Set<string> }) {
  const rows = factRows(before, after);
  const both = !!before && !!after;
  const [openOne, setOpenOne] = useState(!tiled);
  if (rows.length === 0 || (!both && tiled && rows.length <= TILE_FACTS)) return null;
  if (!both) {
    const side = before ? "before" : "after";
    return (
      <div className="diff-facts">
        <button className="ghost small-button diff-toggle" aria-expanded={openOne} onClick={() => setOpenOne(!openOne)}>
          {openOne ? "Hide" : "Show"} details of this version ({rows.length})
        </button>
        {openOne && (
          <div className="diff-table-wrap">
            <table className="diff-table facts-table">
              <thead><tr><th>Fact</th><th>Value</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name} className="diff-row fact-same">
                    <td className="cmp-change"><EngineText text={r.name} /></td>
                    <td className="cmp-side cmp-plain"><FactValue v={side === "before" ? r.before : r.after} side={side} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }
  const changed = rows.filter((r) => r.changed && !isCoveredFact(covered, r.name));
  const same = rows.filter((r) => !r.changed);
  return (
    <>
      {changed.length > 0 && !(tiled && changed.length <= TILE_FACTS) && (
        <section className="diff-section" aria-label="Facts">
          <div className="diff-section-head">
            <span className="diff-section-title">Facts</span>
            <span className="dim small">{changed.length === 1 ? "1 changed" : `${changed.length} changed`}</span>
          </div>
          <div className="diff-table-wrap">
            <table className="diff-table">
              <thead><tr><th>Fact</th><th className="cmp-before">Before</th><th className="cmp-after">After</th></tr></thead>
              <tbody>
                {changed.map((r) => (
                  <tr key={r.name} className="diff-row mod">
                    <td className="cmp-change"><EngineText text={r.name} /></td>
                    <td data-label="Before" className="cmp-side"><FactValue v={r.before} side="before" /></td>
                    <td data-label="After" className="cmp-side"><FactValue v={r.after} side="after" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {same.length > 0 && (
        <details className="diff-unchanged small dim">
          <summary>{same.length === 1 ? "1 unchanged fact" : `${same.length} unchanged facts`}</summary>
          <div className="diff-table-wrap">
            <table className="diff-table facts-table">
              <thead><tr><th>Fact</th><th>Both versions</th></tr></thead>
              <tbody>
                {same.map((r) => (
                  <tr key={r.name} className="diff-row fact-same">
                    <td className="cmp-change"><EngineText text={r.name} /></td>
                    <td className="cmp-side cmp-plain"><FactValue v={r.after} side="after" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

/** A package's diff from Unreal's diff code. */
export function AssetDiffView({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: React.ReactNode }) {
  if (diff.state === "error") {
    const consequence = diffErrorConsequence(status);
    return (
      <div className="banner bad small" role="alert">
        <div>Unreal could not load this asset to diff it, so there is no before and after to show.</div>
        <div className="mono small"><EngineText text={diff.error ?? "No reason was given."} /></div>
        <div>{consequence}</div>
      </div>
    );
  }
  if (diff.state === "deferred") return <div className="dim small">Diffing in the editor.</div>;
  return <ReadyDiff diff={diff} name={name} asset={asset} status={status} nativeNote={nativeNote} />;
}

/**
 * A diff Unreal produced, laid out for the card's own width. The item's
 * one-line summary is above it on the card, so it is not repeated here.
 */
function ReadyDiff({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const tier = useCompareTier(box);
  const sections = diff.sections ?? [];
  const [failed, setFailed] = useState<PictureFailures>({});
  const pictured = [diff.before, diff.after].filter((v, i) => pictureOf(v) && !failed[i === 0 ? "Before" : "After"]).length;
  return (
    <div className="asset-diff" ref={box} data-tier={tier}>
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} failed={failed} setFailed={setFailed} />
      {diff.classChanged && <div className="banner warn small">The asset's class changed: {diff.classChanged}.</div>}
      {sections.map((s) => <Section key={s.category} s={s} />)}
      {(diff.recordsDropped ?? 0) > 0 && <div className="dim small">{diff.recordsDropped} more differences past the limit are not listed.</div>}
      {diff.textDiff?.diff && (
        <div className="diff-section">
          <div className="diff-section-head"><span className="diff-section-title">{diff.textDiff.format.toUpperCase()} export</span><span className="dim small">the text Unreal's own diff compares for this type</span></div>
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </div>
      )}
      <Facts before={diff.before} after={diff.after} tiled={pictured === 0 && wantsTile(diff, status)} covered={coveredFacts(sections)} />
    </div>
  );
}

export { isFlatPicture, numberStruct };
