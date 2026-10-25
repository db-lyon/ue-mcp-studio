/**
 * A package's diff in the review: Unreal's own diff records, as ue-mcp
 * serializes them, grouped under the engine's categories with both values side
 * by side, a picture of each version, and the facts about each version.
 */
import { useState } from "react";
import {
  factRows,
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

/** A value as ExportText wrote it, or what its absence means. */
function Value({ v, side }: { v: string | null | undefined; side: "before" | "after" }) {
  if (v === null || v === undefined) return <span className="dim">{side === "before" ? "not there" : "gone"}</span>;
  if (v === "") return <span className="dim">empty</span>;
  return <span className="mono">{v}</span>;
}

/** One version's picture, or why there is none. */
function Picture({ version, missing, label, name }: { version: AssetVersion | null | undefined; missing: string; label: string; name: string }) {
  const t: AssetThumbnail | undefined = version?.thumbnail;
  return (
    <figure>
      {!version ? (
        <div className="review-nopicture">{missing}</div>
      ) : t && "id" in t ? (
        <img src={api.reviewThumbnailUrl(t.id)} alt={`${name} ${label.toLowerCase()}`} title={t.source === "saved" ? `The thumbnail saved with this version. ${t.note ?? ""}` : "Rendered from this version"} />
      ) : (
        <div className="review-nopicture dim small">No picture: {t && "error" in t ? t.error : "the editor kept none for this version."}</div>
      )}
      <figcaption className="small dim">{label}{version?.class ? ` (${version.class})` : ""}</figcaption>
    </figure>
  );
}

/** Property records as a table: the engine's path, then before and after. Graph and component records show the engine's message. */
function RecordRows({ entries }: { entries: AssetDiffRecord[] }) {
  return (
    <>
      {entries.map((r, i) => {
        const k = kindOf(r);
        const values = r.path !== undefined && (r.before !== undefined || r.after !== undefined);
        const head = (
          <>
            <span className={`diff-kind ${kindClass(k)}`}>{k}</span>
            {values ? <span className="diff-path" title={r.displayString}>{r.path}</span> : <span className="diff-message" title={r.toolTip}>{r.displayString}</span>}
          </>
        );
        if (values) {
          return (
            <tr key={i} className={`diff-row ${kindClass(k)}`}>
              <td>{head}</td>
              <td><Value v={r.before} side="before" /></td>
              <td><Value v={r.after} side="after" /></td>
            </tr>
          );
        }
        return (
          <tr key={i} className={`diff-row ${kindClass(k)}`}>
            <td colSpan={3}>
              {head}
              {r.toolTip && r.toolTip !== r.displayString && <div className="dim small">{r.toolTip}</div>}
              {r.facts && r.facts.length > 0 && (
                <div className="dim small">{r.facts.map((f) => `${f.name} ${f.value}`).join(", ")}</div>
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

function Section({ s }: { s: AssetDiffSection }) {
  const groups = recordsByGroup(s.entries);
  return (
    <section className="diff-section" aria-label={s.category}>
      <div className="diff-section-head">
        <span className="diff-section-title">{s.category}</span>
        <span className="dim small">{s.entries.length === 1 ? "1 difference" : `${s.entries.length} differences`}</span>
        <span className="spacer" />
        <span className="dim small mono" title="The engine code these records came from">{s.engineSource}</span>
      </div>
      {s.entries.length > 0 && (
        <div className="diff-table-wrap">
          <table className="diff-table">
            <thead><tr><th>{s.kind === "graph" ? "Change" : "Property"}</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.group ?? ""} group={g.group} entries={g.entries} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(s.hiddenChanges ?? 0) > 0 && (
        <div className="dim small">{s.hiddenChanges === 1 ? "1 more difference" : `${s.hiddenChanges} more differences`} in properties the details panel does not show.</div>
      )}
    </section>
  );
}

function GroupRows({ group, entries }: { group: string | null; entries: AssetDiffRecord[] }) {
  return (
    <>
      {group !== null && (
        <tr className="diff-group"><th colSpan={3}>{group}</th></tr>
      )}
      <RecordRows entries={entries} />
    </>
  );
}

/** Facts about each version side by side: LODs, sizes, parameters. */
function Facts({ before, after }: { before: AssetVersion | null | undefined; after: AssetVersion | null | undefined }) {
  const rows = factRows(before, after);
  const [open, setOpen] = useState(!before || !after);
  if (rows.length === 0) return null;
  const changed = rows.filter((r) => r.changed).length;
  return (
    <div className="diff-facts">
      <button className="ghost small-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} details of {before && after ? "both versions" : "this version"}{changed ? ` (${changed} differ)` : ""}
      </button>
      {open && (
        <div className="diff-table-wrap">
          <table className="diff-table">
            <thead><tr><th>Fact</th>{before && <th>Before</th>}{after && <th>After</th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={r.changed ? "diff-row mod" : "diff-row"}>
                  <td>{r.name}</td>
                  {before && <td><Value v={r.before ?? null} side="before" /></td>}
                  {after && <td><Value v={r.after ?? null} side="after" /></td>}
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
export function AssetDiffView({ diff, name, blueprintTree }: { diff: AssetDiff; name: string; blueprintTree?: React.ReactNode }) {
  if (diff.state === "error") {
    return <div className="banner bad small" role="alert">Unreal could not diff this asset: {diff.error ?? "no reason given"}</div>;
  }
  if (diff.state === "deferred") return <div className="dim small">Diffing in the editor.</div>;
  const sections = diff.sections ?? [];
  const records = sections.reduce((n, s) => n + s.entries.length, 0);
  return (
    <div className="asset-diff">
      <div className="review-pictures">
        <Picture version={diff.before} missing="Did not exist before this turn" label="Before" name={name} />
        <Picture version={diff.after} missing="Deleted in this turn" label="After" name={name} />
      </div>
      {diff.engine && <div className="dim small engine-note" title={diff.engine.note}>Unreal's {diff.engine.tool}: {diff.engine.note}</div>}
      {diff.classChanged && <div className="banner warn small">The asset's class changed: {diff.classChanged}.</div>}
      {sections.map((s) => <Section key={s.category} s={s} />)}
      {diff.status === "modified" && records === 0 && !diff.textDiff && (
        <div className="dim small">{diff.summary}</div>
      )}
      {(diff.recordsDropped ?? 0) > 0 && <div className="dim small">{diff.recordsDropped} more differences past the limit are not listed.</div>}
      {diff.textDiff?.diff && (
        <div className="diff-section">
          <div className="diff-section-head"><span className="diff-section-title">{diff.textDiff.format.toUpperCase()} export</span><span className="dim small">the engine's own diff for this type</span></div>
          <DiffView lines={unifiedLines(diff.textDiff.diff)} label={`${diff.textDiff.format} diff of ${name}`} />
        </div>
      )}
      <Facts before={diff.before} after={diff.after} />
      {blueprintTree}
    </div>
  );
}
