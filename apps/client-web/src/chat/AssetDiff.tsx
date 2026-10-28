/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, grouped under the engine's categories with both values side
 * by side, a picture of each version, and the facts about each version.
 */
import { useState } from "react";
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
  type AssetThumbnail,
  type AssetVersion,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";
import { EngineText } from "./breakable";
import { AssetTile, TILE_FACTS, tileOf } from "./AssetTile";

/** EDiffType::Category and the diff types, in words. */
const CHANGE_KIND: Record<string, string> = {
  ADDITION: "Added",
  SUBTRACTION: "Removed",
  MODIFICATION: "Changed",
  MINOR: "Minor",
  OBJECT_ADDED: "Added",
  OBJECT_REMOVED: "Removed",
  NODE_ADDED: "Added",
  NODE_REMOVED: "Removed",
  NODE_TYPE_CHANGED: "Changed",
  NODE_PROPERTY_CHANGED: "Changed",
  NODE_MOVED: "Moved",
  PropertyAddedToA: "Removed",
  PropertyAddedToB: "Added",
  PropertyValueChanged: "Changed",
};

const kindOf = (r: AssetDiffRecord): string => CHANGE_KIND[r.category ?? ""] ?? CHANGE_KIND[r.diffType] ?? "Changed";
const kindClass = (k: string): string => (k === "Added" ? "add" : k === "Removed" ? "del" : k === "Minor" || k === "Moved" ? "minor" : "mod");

/** A value as ExportText wrote it, a parameter struct in words, or what its absence means. */
function Value({ v, side }: { v: string | null | undefined; side: "before" | "after" }) {
  if (v === null || v === undefined) return <span className="dim">{side === "before" ? "not there" : "gone"}</span>;
  if (v === "") return <span className="dim">empty</span>;
  const parts = readableParts(v);
  if (parts && parts.length > 1) return <span className="mono diff-value diff-parts" title={v}>{parts.map((x, i) => <span key={i}><EngineText text={x} /></span>)}</span>;
  const words = parts?.[0] ?? (exportNumber(v) !== v ? exportNumber(v) : null);
  return <span className="mono diff-value" title={words ? v : undefined}><EngineText text={words ?? v} /></span>;
}

const pictureOf = (v: AssetVersion | null | undefined): Extract<AssetThumbnail, { id: string }> | null => (v?.thumbnail && "id" in v.thumbnail ? v.thumbnail : null);

/**
 * A picture of each version that has one. Where neither has, the asset's tile
 * takes the space: its type, path, what changed and its facts. A version with
 * no picture beside one that has says why in words, never in an empty frame.
 */
function Pictures({ diff, name, asset, status }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted" }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const sides = [
    { label: "Before", v: diff.before, missing: "Did not exist before this turn" },
    { label: "After", v: diff.after, missing: "Deleted in this turn" },
  ];
  const shown = sides.filter((s) => pictureOf(s.v) && !failed[s.label]);
  if (shown.length === 0) {
    const errors = [...new Set(sides.flatMap((s) => (s.v?.thumbnail && "error" in s.v.thumbnail ? [s.v.thumbnail.error] : [])))];
    return <AssetTile {...tileOf(diff, name, asset, status)} note={errors.length ? <>No picture: <EngineText text={errors.join("; ")} /></> : undefined} />;
  }
  return (
    <div className="review-pictures">
      {sides.map((s) => {
        const t = pictureOf(s.v);
        if (t && !failed[s.label]) {
          return (
            <figure key={s.label}>
              <img src={api.reviewThumbnailUrl(t.id)} alt={`${name} ${s.label.toLowerCase()}`} title={t.source === "saved" ? `The thumbnail saved with this version. ${t.note ?? ""}` : "Rendered from this version"} onError={() => setFailed((f) => ({ ...f, [s.label]: true }))} />
              <figcaption className="small dim"><span className="picture-label">{s.label}</span><span className="picture-class"><EngineText text={s.v!.class} /></span></figcaption>
            </figure>
          );
        }
        const why = !s.v ? s.missing : s.v.thumbnail && "error" in s.v.thumbnail ? `No picture: ${s.v.thumbnail.error}` : failed[s.label] ? "No picture: the file could not be read." : "No picture: the editor kept none for this version.";
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

/** The node a graph record is about, by the title the graph shows. */
const nodeOf = (r: AssetDiffRecord): string | undefined => r.node2?.title ?? r.node1?.title;

/** An added or removed node's values: what it was set to, so an added Constant shows its number. */
function NodeValues({ r }: { r: AssetDiffRecord }) {
  if (r.diffType !== "NODE_ADDED" && r.diffType !== "NODE_REMOVED") return null;
  const n = r.node1 ?? r.node2;
  const values = nodeValues(n);
  const full = n?.fullTitle?.replace(/\s*\n\s*/g, ", ");
  // The full title only when it says more than the node's name and its values already do.
  const title = full && full !== n!.title && !r.displayString.includes(full) && !values.some((v) => exportNumber(v.value) === full) ? full : null;
  if (!values.length && !title) return null;
  return (
    <div className="diff-node-values small">
      {title && <div className="dim"><EngineText text={title} /></div>}
      {values.length > 0 && (
        <dl className="diff-node-props">
          {values.map((v) => (
            <div key={v.name}><dt><EngineText text={v.name} /></dt><dd className="mono"><EngineText text={readableValue(v.value) ?? exportNumber(v.value)} /></dd></div>
          ))}
        </dl>
      )}
      {(n?.propertiesDropped ?? 0) > 0 && <div className="dim">{n!.propertiesDropped} more properties not listed.</div>}
    </div>
  );
}

/** Property records as a table: the engine's path, then before and after. Graph and component records show the engine's message. */
function RecordRows({ entries }: { entries: AssetDiffRecord[] }) {
  return (
    <>
      {entries.map((r, i) => {
        const k = kindOf(r);
        const values = r.path !== undefined && (r.before !== undefined || r.after !== undefined);
        const node = nodeOf(r);
        const head = (
          <>
            <span className={`diff-kind ${kindClass(k)}`}>{k}</span>
            {values ? <span className="diff-path" title={r.displayString}><EngineText text={r.path!} /></span> : <span className="diff-message" title={r.toolTip}><EngineText text={r.displayString} /></span>}
            {node && !r.displayString.includes(node) && <span className="dim"> on <EngineText text={node} /></span>}
          </>
        );
        if (values) {
          return (
            <tr key={i} className={`diff-row ${kindClass(k)}`}>
              <td>{head}</td>
              <td data-label="Before"><Value v={r.before} side="before" /></td>
              <td data-label="After"><Value v={r.after} side="after" /></td>
            </tr>
          );
        }
        return (
          <tr key={i} className={`diff-row ${kindClass(k)}`}>
            <td colSpan={3}>
              {head}
              {r.toolTip && r.toolTip !== r.displayString && <div className="dim small"><EngineText text={r.toolTip} /></div>}
              <NodeValues r={r} />
              {r.facts && r.facts.length > 0 && (
                <div className="dim small"><EngineText text={r.facts.map((f) => `${f.name} ${f.value}`).join(", ")} /></div>
              )}
              {r.properties && r.properties.length > 0 && (
                <table className="diff-table nested"><tbody><RecordRows entries={r.properties} /></tbody></table>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function RecordTable({ entries, graph }: { entries: AssetDiffRecord[]; graph: boolean }) {
  return (
    <div className="diff-table-wrap">
      <table className="diff-table">
        <thead><tr><th>{graph ? "Change" : "Property"}</th><th>Before</th><th>After</th></tr></thead>
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
      <div className="diff-section-head" title={`From Unreal's ${s.engineSource}`}>
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

/** Facts about each version side by side: LODs, sizes, parameters. */
function Facts({ before, after, tiled }: { before: AssetVersion | null | undefined; after: AssetVersion | null | undefined; tiled: boolean }) {
  const rows = factRows(before, after);
  const [open, setOpen] = useState(!tiled && (!before || !after));
  // The tile already lists up to TILE_FACTS of them.
  if (rows.length === 0 || (tiled && rows.length <= TILE_FACTS)) return null;
  const changed = rows.filter((r) => r.changed).length;
  const count = before && after ? (changed ? ` (${changed} ${changed === 1 ? "fact differs" : "facts differ"})` : " (no fact differs)") : "";
  return (
    <div className="diff-facts">
      <button className="ghost small-button diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} details of {before && after ? "both versions" : "this version"}{count}
      </button>
      {open && (
        <div className="diff-table-wrap">
          <table className="diff-table">
            <thead><tr><th>Fact</th>{before && <th>Before</th>}{after && <th>After</th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={r.changed ? "diff-row mod" : "diff-row"}>
                  <td><EngineText text={r.name} /></td>
                  {before && <td data-label="Before"><Value v={r.before ?? null} side="before" /></td>}
                  {after && <td data-label="After"><Value v={r.after ?? null} side="after" /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A package's diff from Unreal's diff code. */
export function AssetDiffView({ diff, name, asset, status, blueprintTree, nativeNote }: { diff: AssetDiff; name: string; asset?: string; status: "added" | "modified" | "deleted"; blueprintTree?: React.ReactNode; nativeNote?: React.ReactNode }) {
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
  const sections = diff.sections ?? [];
  const records = sections.reduce((n, s) => n + s.entries.length, 0);
  return (
    <div className="asset-diff">
      {nativeNote}
      <Pictures diff={diff} name={name} asset={asset} status={status} />
      {diff.classChanged && <div className="banner warn small">The asset's class changed: {diff.classChanged}.</div>}
      {sections.map((s) => <Section key={s.category} s={s} />)}
      {diff.status === "modified" && records === 0 && !diff.textDiff && (
        <div className="dim small">{diff.summary}</div>
      )}
      {(diff.recordsDropped ?? 0) > 0 && <div className="dim small">{diff.recordsDropped} more differences past the limit are not listed.</div>}
      {diff.textDiff?.diff && (
        <div className="diff-section">
          <div className="diff-section-head"><span className="diff-section-title">{diff.textDiff.format.toUpperCase()} export</span><span className="dim small">the text Unreal's own diff compares for this type</span></div>
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </div>
      )}
      <Facts before={diff.before} after={diff.after} tiled={!pictureOf(diff.before) && !pictureOf(diff.after)} />
      {blueprintTree}
      {diff.engine && (
        <details className="small dim engine-note">
          <summary>How Unreal compared this</summary>
          {diff.engine.note}
        </details>
      )}
    </div>
  );
}
