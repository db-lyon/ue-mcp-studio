/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, in one tree grid (Property, Before, After) with a picture of
 * each version above it. The tree's rows come from diffTree in the shared
 * package, which the app renders too.
 */
import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import {
  diffTree,
  inlineFits,
  factRows,
  numberStruct,
  TONE_GLYPH,
  TONE_WORD,
  treeLines,
  unifiedLines,
  type AssetDiff,
  type AssetThumbnail,
  type AssetVersion,
  type DiffTreeRow,
  type DiffValue,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";
import { EngineText } from "./breakable";
import { AssetTile, TILE_FACTS, tileOf } from "./AssetTile";
import { Swatch, useCardSize, type CompareTier } from "./compare";

export { numberStruct };

const pictureOf = (v: AssetVersion | null | undefined): Extract<AssetThumbnail, { id: string }> | null => (v?.thumbnail && "id" in v.thumbnail ? v.thumbnail : null);

/** Most a colour channel may vary across a picture that still counts as one flat colour. */
const FLAT_TOLERANCE = 6;

/**
 * Whether RGBA pixels are one flat colour, or fully transparent: what a
 * thumbnail renderer that drew nothing leaves (black, or only its background).
 * A picture of nothing is not a picture of the version.
 */
export function isFlatPicture(px: ArrayLike<number>): boolean {
  if (px.length < 4) return true;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    for (let c = 0; c < 3; c++) {
      if (px[i + c] < min[c]) min[c] = px[i + c];
      if (px[i + c] > max[c]) max[c] = px[i + c];
    }
    if (max[0] - min[0] > FLAT_TOLERANCE || max[1] - min[1] > FLAT_TOLERANCE || max[2] - min[2] > FLAT_TOLERANCE) return false;
  }
  return true;
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
/**
 * Whether the tile takes an absent picture's place. A new or deleted asset's
 * tile says what it is. A changed one's says only what changed in its facts,
 * so it is shown when a fact changed and no record lists the change: the item's
 * line above already names the asset.
 */
const wantsTile = (diff: AssetDiff, status: "added" | "modified" | "deleted"): boolean =>
  status !== "modified"
  || (!(diff.sections ?? []).some((x) => x.entries.some((e) => !e.hidden)) && !diff.textDiff?.diff && factRows(diff.before, diff.after).some((r) => r.changed));

/** A side whose picture file could not be read, or that drew one flat colour: either way, no picture of it. */
type PictureFailures = Record<string, "unreadable" | "blank">;

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
        const why = !s.v ? s.missing
          : s.v.thumbnail && "error" in s.v.thumbnail ? `No picture: ${s.v.thumbnail.error}`
          : failed[s.label] === "blank" ? "No picture: Unreal's thumbnail renderer drew nothing for this version."
          : failed[s.label] ? "No picture: the file could not be read."
          : "No picture: the editor kept none for this version.";
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

/** A package's diff from Unreal's diff code. */
export function AssetDiffView({ diff, name, asset, status, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; nativeNote?: React.ReactNode }) {
  if (diff.state === "error") {
    const consequence = status === "added"
      ? "Revert deletes the file the agent added; Keep leaves it."
      : status === "deleted"
        ? "Revert puts the file back as it was before this turn; Keep leaves it deleted."
        : "Revert puts the file back exactly as it was before this turn, byte for byte; Keep leaves it as the agent left it. Neither needs Unreal to load it.";
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
function ValueCell({ v, none, side, open, toggle }: { v?: DiffValue; none?: boolean; side: "before" | "after"; open: boolean; toggle: () => void }) {
  const label = side === "before" ? "Before" : "After";
  if (!v) return <div role="gridcell" data-label={label} className={`dt-val dt-${side}${none ? "" : " dt-blank"}`}>{none && <span className="dim">none</span>}</div>;
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  const body = v.text === "" ? <span className="dim">empty</span>
    : open && v.lines ? v.lines.map((l, i) => <span key={i} className="dt-line"><Swatch text={l} /><EngineText text={l} /></span>)
    : open ? <><Swatch text={v.raw} /><EngineText text={v.text} /></>
    // Cut to one line: no break opportunities, which Chrome takes even under nowrap.
    : <><Swatch text={v.raw} />{v.text}</>;
  return (
    <div
      role="gridcell"
      data-label={label}
      className={`dt-val dt-${side} mono${v.long ? " long" : ""}${open ? " open" : ""}`}
      title={v.raw !== v.text ? v.raw : v.text}
      {...(v.long ? { tabIndex: 0, "aria-expanded": open, onClick: toggle, onKeyDown: key } : {})}
    >
      {body}
    </div>
  );
}

/** A row's name: its levels joined, an engine name breaking only between its parts. */
const Label = ({ row }: { row: DiffTreeRow }) => (
  <span className="dt-label" title={row.title}>
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
    <div className="dtree" role="treegrid" aria-label={`Differences in ${name}`}>
      <div className="dt-row dt-head" role="row">
        <span role="columnheader">Property</span>
        <span role="columnheader" className="dt-before">Before</span>
        <span role="columnheader" className="dt-after">After</span>
      </div>
      {treeLines(roots, toggled).map(({ row, depth, open }) => {
        const parent = row.children.length > 0;
        const both = !!(row.before || row.beforeNone) && !!(row.after || row.afterNone);
        const valued = !!(row.before || row.after || row.beforeNone || row.afterNone);
        const cls = ["dt-row", row.tone ?? "", row.section ? "dt-section" : "", parent ? "dt-parent" : "", row.detail ? "dt-detail" : "", both ? "dt-both" : "", valued ? "" : "dt-bare", stacked && inlineFits(row, depth, width) ? "dt-inline" : ""].filter(Boolean).join(" ");
        const count = parent && !row.tone && !row.detail && row.count > 0 ? <span className="dt-count" title={row.count === 1 ? "1 difference" : `${row.count} differences`}>{row.count}</span> : null;
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
            <ValueCell v={row.before} none={row.beforeNone} side="before" open={opened.has(row.id)} toggle={() => openRow(row.id)} />
            <ValueCell v={row.after} none={row.afterNone} side="after" open={opened.has(row.id)} toggle={() => openRow(row.id)} />
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
  const pictured = [diff.before, diff.after].filter((v, i) => pictureOf(v) && !failed[i === 0 ? "Before" : "After"]).length;
  const roots = diffTree(diff, { shown: pictured === 0 && wantsTile(diff, status), facts: TILE_FACTS });
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
