/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, in one tree grid (Property, Before, After), with a picture of
 * each version above it where the asset's change is a visual one. The tree's
 * rows come from diffTree in the shared package, which the app renders too.
 */
import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import { diffClass, diffErrorConsequence, diffPictures, isBlankPicture, isFlatPicture, isVisualAsset, thumbnailErrors, wantsTile, type PictureFailure, type PictureSide } from "@ue-mcp-studio/client-core";
import {
  diffTree,
  inlineFits,
  LABEL_JOIN,
  splitNeeded,
  numberStruct,
  TONE_GLYPH,
  TONE_WORD,
  treeLines,
  unifiedLines,
  type AssetDiff,
  type DiffTreeRow,
  type DiffValue,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";
import { EngineText } from "./breakable";
import { AssetTile, tileOf } from "./AssetTile";
import { Swatch, useCardSize, type CompareTier } from "./compare";

export { isFlatPicture, numberStruct };

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

/** Each side whose picture is no picture of it, and why. */
type PictureFailures = Partial<Record<PictureSide, PictureFailure>>;

/**
 * The pictures diffPictures allows: Before and After of a changed visual
 * asset, or a new or deleted one's single picture; none for a Blueprint or
 * any other change a picture does not show. Where none is shown, a new or
 * deleted asset with no facts gets its tile in the space; otherwise nothing,
 * the diff's rows being the change.
 */
function Pictures({ diff, name, asset, status, failed, setFailed }: {
  diff: AssetDiff;
  name: string;
  asset?: string;
  status: "added" | "modified" | "deleted";
  failed: PictureFailures;
  setFailed: (f: (old: PictureFailures) => PictureFailures) => void;
}) {
  /** Sides whose picture has loaded and been looked at; until every one has, none is shown, so a blank one never flashes. */
  const [seen, setSeen] = useState<Partial<Record<PictureSide, boolean>>>({});
  const loaded = (side: PictureSide, img: HTMLImageElement) => {
    const px = pixelsOf(img);
    if (px && isBlankPicture(px)) setFailed((f) => ({ ...f, [side]: "blank" }));
    else setSeen((s) => ({ ...s, [side]: true }));
  };
  const shown = diffPictures(diff, status, name, failed);
  if (shown.length === 0) {
    if (!wantsTile(diff, status)) return null;
    const errors = isVisualAsset(diffClass(diff), name) ? thumbnailErrors(diff) : [];
    const tile = tileOf(diff, name, asset, status);
    // The facts are rows of the grid below it.
    tile.facts = [];
    return <AssetTile {...tile} note={errors.length ? <>No picture: <EngineText text={errors.join("; ")} /></> : undefined} />;
  }
  const ready = shown.every((p) => seen[p.side]);
  return (
    <div className="review-pictures">
      {shown.map(({ side, label, thumbnail: t }) => (
        <figure key={side}>
          <img
            src={api.reviewThumbnailUrl(t.id)}
            alt={`${name} ${label.toLowerCase()}`}
            title={t.source === "saved" ? `The thumbnail saved with this version. ${t.note ?? ""}` : "Rendered from this version"}
            className={ready ? undefined : "picture-pending"}
            onLoad={(e) => loaded(side, e.currentTarget)}
            onError={() => setFailed((f) => ({ ...f, [side]: "unreadable" }))}
          />
          <figcaption className="small dim"><span className="picture-label">{label}</span></figcaption>
        </figure>
      ))}
    </div>
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

/** A value cell: one line cut to its column, the whole value on hover; a long or many-line value opens its row's values in place on a click or tap. */
function ValueCell({ v, none, side, open, toggle, other }: { v?: DiffValue; none?: boolean; side: "before" | "after"; open: boolean; toggle: () => void; other?: DiffValue }) {
  const theirs = new Set(other?.lines ?? []);
  const label = side === "before" ? "Before" : "After";
  if (!v) return <div role="gridcell" data-label={label} className={`dt-val dt-${side}${none ? "" : " dt-blank"}`}>{none && <span className="dim">none</span>}</div>;
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  const body = v.text === "" ? <span className="dim">empty</span>
    : open && v.lines ? v.lines.map((l, i) => <span key={i} className={`dt-line${other?.lines && !theirs.has(l) ? (side === "after" ? " dt-line-add" : " dt-line-del") : ""}`}><Swatch text={l} /><EngineText text={l} /></span>)
    : open ? <><Swatch text={v.raw} /><EngineText text={v.text} /></>
    // Cut to one line: no break opportunities, which Chrome takes even under nowrap.
    : <><Swatch text={v.raw} />{v.text}</>;
  return (
    <div
      role="gridcell"
      data-label={label}
      className={`dt-val dt-${side} mono${v.long ? " long" : ""}${open ? " open" : ""}`}
      title={`${v.raw !== v.text ? v.raw : v.text}${v.long ? (open ? "\n\nClick to fold it back." : "\n\nClick to show all of it.") : ""}`}
      {...(v.long ? { tabIndex: 0, "aria-expanded": open, onClick: toggle, onKeyDown: key } : {})}
    >
      {body}
    </div>
  );
}

/** The rows with no children under a row: what a group's count says when its changes are one, such as an added node's values. */
const leaves = (row: DiffTreeRow): number => row.children.reduce((n, c) => n + (c.children.length ? leaves(c) : 1), 0);

/** Whether no row of the tree has anything on one side: an added asset's Before, a deleted one's After. */
const sideless = (rows: DiffTreeRow[], side: "before" | "after"): boolean =>
  rows.every((r) => !(side === "before" ? r.before || r.beforeNone : r.after || r.afterNone) && sideless(r.children, side));

/** A row's name: its levels joined, an engine name breaking only between its parts. */
const Label = ({ row }: { row: DiffTreeRow }) => (
  <span className="dt-label" title={[row.label.join(LABEL_JOIN), row.title].filter(Boolean).join("\n")}>
    {row.label.map((p, i) => <Fragment key={i}>{i > 0 && <span className="dt-sep" aria-hidden="true">{" › "}</span>}<EngineText text={p} /></Fragment>)}
  </span>
);

/** The change a row is, as a glyph, and in words for a screen reader. */
const Glyph = ({ row }: { row: DiffTreeRow }) => (row.tone
  ? <span className={`dt-glyph ${row.tone}`} title={TONE_WORD[row.tone]}><span aria-hidden="true">{TONE_GLYPH[row.tone]}</span><span className="sr-only">{TONE_WORD[row.tone]}</span></span>
  : <span className="dt-glyph" aria-hidden="true" />);

/**
 * The diff as one tree grid: Property, Before, After. Sections, then the
 * object, node or actor, then the property path, each level open to start
 * (differences the details panel does not show start closed) and closed with
 * its triangle. On a narrow card the values go under the name, "False → True".
 */
export function DiffTreeGrid({ roots, name, tier, width }: { roots: DiffTreeRow[]; name: string; tier: CompareTier; width: number }) {
  const stacked = tier === "narrow" || tier === "tiny";
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setToggled((t) => {
    const n = new Set(t);
    if (!n.delete(id)) n.add(id);
    return n;
  });
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const openRow = (id: string) => setOpened((t) => {
    const n = new Set(t);
    if (!n.delete(id)) n.add(id);
    return n;
  });
  return (
    <div className={`dtree${sideless(roots, "before") ? " dt-no-before" : ""}${sideless(roots, "after") ? " dt-no-after" : ""}`} role="treegrid" aria-label={`Differences in ${name}`}>
      <div className="dt-row dt-head" role="row">
        <span role="columnheader">Property</span>
        <span role="columnheader" className="dt-before">Before</span>
        <span role="columnheader" className="dt-after">After</span>
      </div>
      {treeLines(roots, toggled).map(({ row, depth, open }) => {
        const parent = row.children.length > 0;
        const both = !!(row.before || row.beforeNone) && !!(row.after || row.afterNone);
        const valued = !!(row.before || row.after || row.beforeNone || row.afterNone);
        const cls = ["dt-row", row.tone ?? "", row.section ? "dt-section" : "", parent ? "dt-parent" : "", row.detail ? "dt-detail" : "", both ? "dt-both" : "", valued ? "" : "dt-bare", stacked && inlineFits(row, depth, width) ? "dt-inline" : stacked && splitNeeded(row, depth, width) ? "dt-split" : ""].filter(Boolean).join(" ");
        const n = parent ? (row.count > (row.tone ? 1 : 0) && !row.tone ? row.count : leaves(row)) : 0;
        const count = n > 0 ? <span className="dt-count" title={row.count > 1 ? `${row.count} differences` : n === 1 ? "1 row" : `${n} rows`}>{n}</span> : null;
        return (
          <div key={row.id} role="row" aria-level={depth + 1} aria-expanded={parent ? open : undefined} className={cls} data-id={row.id} style={{ ["--depth" as string]: depth }}>
            <div role="rowheader" className="dt-name">
              {parent ? (
                <button type="button" className="dt-toggle" aria-expanded={open} onClick={() => toggle(row.id)}>
                  <span className="dt-twisty" aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <Glyph row={row} />
                  <Label row={row} />
                  {count}
                </button>
              ) : (
                <>
                  <span className="dt-twisty" aria-hidden="true" />
                  <Glyph row={row} />
                  <Label row={row} />
                </>
              )}
              {row.note && <span className="dt-note"><EngineText text={row.note} /></span>}
            </div>
            <ValueCell v={row.before} other={row.after} none={row.beforeNone} side="before" open={opened.has(row.id)} toggle={() => openRow(row.id)} />
            <ValueCell v={row.after} other={row.before} none={row.afterNone} side="after" open={opened.has(row.id)} toggle={() => openRow(row.id)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A diff Unreal produced, laid out for the card's own width. The item's
 * one-line summary is above it on the card, so it is not repeated here.
 */
function ReadyDiff({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const { tier, width } = useCardSize(box);
  const [failed, setFailed] = useState<PictureFailures>({});
  const roots = diffTree(diff);
  return (
    <div className="asset-diff" ref={box} data-tier={tier}>
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} failed={failed} setFailed={setFailed} />
      {diff.classChanged && <div className="banner warn small">The asset's class changed: {diff.classChanged}.</div>}
      {roots.length > 0 && <DiffTreeGrid roots={roots} name={name} tier={tier} width={width} />}
      {(diff.recordsDropped ?? 0) > 0 && <div className="dim small">{diff.recordsDropped} more differences past the limit are not listed.</div>}
      {diff.textDiff?.diff && (
        <div className="diff-section">
          <div className="diff-section-head"><span className="diff-section-title">{diff.textDiff.format.toUpperCase()} export</span><span className="dim small">the text Unreal's own diff compares for this type</span></div>
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </div>
      )}
    </div>
  );
}
