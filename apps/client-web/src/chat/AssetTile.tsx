/**
 * What a review shows for an asset version with no picture: the type's icon,
 * its class and object path, what the turn changed in it, and its facts. Unreal
 * keeps no thumbnail for many types (levels, data, input), and an empty frame
 * says nothing, so the space carries what Studio already knows instead.
 */
import { useState, type ReactNode } from "react";
import type { AssetDiff, AssetDiffRecord, AssetDiffSection, AssetVersion } from "@ue-mcp-studio/shared";
import { EngineText } from "./breakable";

export type AssetFamily = "blueprint" | "material" | "mesh" | "texture" | "level" | "sound" | "effect" | "data" | "input" | "animation" | "file";

const BY_CLASS: Array<[RegExp, AssetFamily]> = [
  [/^World$/, "level"],
  [/Blueprint/, "blueprint"],
  [/^Material/, "material"],
  [/^Niagara|^ParticleSystem/, "effect"],
  [/Mesh$|^GeometryCollection/, "mesh"],
  [/^Texture|RenderTarget|^MediaTexture/, "texture"],
  [/Sound|^MetaSound|^Audio|^Dialogue/, "sound"],
  [/^Input(Action|MappingContext)|^PlayerMappable/, "input"],
  [/^Anim|Montage|^Skeleton$|^BlendSpace|^PoseAsset/, "animation"],
  [/DataTable|CurveTable|DataAsset|^Curve|^StringTable|^UserDefined(Struct|Enum)|^PCGGraph|^StateTree|^Chooser/, "data"],
];

/** The asset naming convention's prefixes, for an asset whose class nobody sent. */
const BY_PREFIX: Array<[RegExp, AssetFamily]> = [
  [/^(BP|WBP|ABP|BPI|BPFL|GA|GE|GC)_/i, "blueprint"],
  [/^(M|MI|MF|MPC)_/i, "material"],
  [/^(SM|SK|GC)_/i, "mesh"],
  [/^(T|RT|TC)_/i, "texture"],
  [/^(L|LV|MAP)_/i, "level"],
  [/^(S|SC|SW|MS|ATT)_/i, "sound"],
  [/^(NS|NE|PS|FX)_/i, "effect"],
  [/^(IA|IMC)_/i, "input"],
  [/^(A|AM|AS|BS|SKEL)_/i, "animation"],
  [/^(DT|CT|DA|C|ST|E|F|PCG)_/i, "data"],
];

/** The kind of asset a class names, or its file name's prefix where no class came. */
export function assetFamily(cls: string | undefined, fileName = ""): AssetFamily {
  if (cls) for (const [re, f] of BY_CLASS) if (re.test(cls)) return f;
  if (/\.umap$/i.test(fileName)) return "level";
  for (const [re, f] of BY_PREFIX) if (re.test(fileName)) return f;
  return "file";
}

/** 16 px strokes in the app's own icon style, one per family. */
const PATHS: Record<AssetFamily, string> = {
  blueprint: "M2 3h4v3H2zM10 10h4v3h-4zM10 3h4v3h-4zM6 4.5h4M12 6v4M6 4.5c2 0 2 7 4 7",
  material: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM5 5.5a3.5 3.5 0 0 1 3-1.6",
  mesh: "M8 1.5l6 3.2v6.6l-6 3.2-6-3.2V4.7zM2 4.7l6 3.3 6-3.3M8 8v6.5",
  texture: "M2 2.5h12v11H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 6.2a1.2 1.2 0 1 0 0-.1",
  level: "M1.5 4l4-1.5 5 2 4-1.5v9.5l-4 1.5-5-2-4 1.5zM5.5 2.5v9.5M10.5 4.5V14",
  sound: "M2 6h3l4-3v10l-4-3H2zM11.5 5.5c1.4 1.4 1.4 3.6 0 5M13.3 3.7c2.4 2.4 2.4 6.2 0 8.6",
  effect: "M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM12.5 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  data: "M2 2.5h12v11H2zM2 6h12M2 9.5h12M6.5 2.5v11",
  input: "M1.5 4.5h13v7h-13zM4 7h1M7.5 7h1M11 7h1M4.5 9.5h7",
  animation: "M9.5 3a1.3 1.3 0 1 0 0-.1M8.5 5.5l-2 3.5 3 1.5-1 4M6.5 9l-3 1M8.5 5.5l3 2.5 2-1",
  file: "M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5",
};

export function AssetIcon({ family }: { family: AssetFamily }) {
  return (
    <svg className={`asset-icon ${family}`} width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[family]} />
    </svg>
  );
}

const NOUN: Record<AssetDiffSection["kind"], [string, string]> = { graph: ["node", "nodes"], components: ["component", "components"], properties: ["property", "properties"] };
const VERB: Record<string, string> = { add: "added", del: "removed", mod: "changed", moved: "moved", minor: "touched" };

function verbOf(r: AssetDiffRecord): keyof typeof VERB {
  const t = `${r.category ?? ""} ${r.diffType}`;
  if (/ADDITION|ADDED|AddedToB/.test(t)) return "add";
  if (/SUBTRACTION|REMOVED|AddedToA/.test(t)) return "del";
  if (/MOVED/.test(t)) return "moved";
  if (/MINOR/.test(t)) return "minor";
  return "mod";
}

/** What a diff changed, counted by what it changed: "1 node added", "2 properties changed". Hidden records are left out. */
export function changeCounts(sections: AssetDiffSection[] | undefined): Array<{ text: string; tone: string }> {
  const counts = new Map<string, { n: number; noun: [string, string]; verb: string }>();
  for (const s of sections ?? []) {
    for (const r of s.entries) {
      if (r.hidden) continue;
      const verb = verbOf(r);
      // A level's components section lists its actors.
      const noun: [string, string] = s.kind === "components" && /actor/i.test(s.category) ? ["actor", "actors"] : NOUN[s.kind];
      const key = `${noun[0]}:${verb}`;
      const c = counts.get(key) ?? { n: 0, noun, verb };
      c.n++;
      counts.set(key, c);
    }
  }
  return [...counts.values()].map((c) => ({ text: `${c.n} ${c.noun[c.n === 1 ? 0 : 1]} ${VERB[c.verb]}`, tone: c.verb }));
}

/** How many facts the tile lists. */
export const TILE_FACTS = 4;

/** A version's facts beside the other version's, the ones that changed first, at most `max`. */
export function tileFacts(before: AssetVersion | null | undefined, after: AssetVersion | null | undefined, max = TILE_FACTS): Array<{ name: string; value: string; was?: string }> {
  const main = after ?? before;
  if (!main) return [];
  const old = after && before ? new Map(before.facts.map((f) => [f.name, f.value])) : new Map<string, string>();
  const rows = main.facts.map((f) => ({ name: f.name, value: f.value, ...(old.has(f.name) && old.get(f.name) !== f.value ? { was: old.get(f.name)! } : {}) }));
  return [...rows.filter((r) => r.was !== undefined), ...rows.filter((r) => r.was === undefined)].slice(0, max);
}

const STATUS_LINE: Record<"added" | "modified" | "deleted", string> = { added: "New in this turn", modified: "Changed in this turn", deleted: "Deleted in this turn" };

/**
 * The tile: icon, class, path, what changed, facts. Used where a picture would
 * go; `note` says why there is no picture when that is worth knowing.
 */
export function AssetTile({ cls, fileName, path, status, changes, facts, note }: {
  cls?: string;
  fileName: string;
  path?: string;
  status: "added" | "modified" | "deleted";
  changes?: Array<{ text: string; tone: string }>;
  facts?: Array<{ name: string; value: string; was?: string }>;
  note?: ReactNode;
}) {
  const family = assetFamily(cls, fileName);
  return (
    <div className={`asset-tile ${family}`} data-family={family} role="group" aria-label={`${cls ?? "Asset"} ${fileName}`}>
      <AssetIcon family={family} />
      <div className="asset-tile-body">
        <div className="asset-tile-head">
          <span className="asset-tile-class">{cls ? <EngineText text={cls} /> : "Asset"}</span>
          <span className={`asset-tile-status small ${status}`}>{STATUS_LINE[status]}</span>
        </div>
        {path && <div className="asset-tile-path mono small"><EngineText text={path} /></div>}
        {changes && changes.length > 0 && (
          <ul className="asset-tile-changes small" aria-label="What changed">
            {changes.map((c) => <li key={c.text} className={c.tone}>{c.text}</li>)}
          </ul>
        )}
        {facts && facts.length > 0 && (
          <dl className="asset-tile-facts small">
            {facts.map((f) => (
              <div key={f.name}>
                <dt><EngineText text={f.name} /></dt>
                <dd className="mono">{f.was !== undefined && <><span className="dim"><EngineText text={f.was} /></span>{" to "}</>}<EngineText text={f.value} /></dd>
              </div>
            ))}
          </dl>
        )}
        {note && <div className="asset-tile-note dim small">{note}</div>}
      </div>
    </div>
  );
}

/** A picture that becomes `fallback` when it fails to load, so a missing file never leaves a broken frame. */
export function PictureOr({ src, alt, title, lazy, fallback }: { src: string; alt: string; title?: string; lazy?: boolean; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt={alt} title={title} loading={lazy ? "lazy" : undefined} onError={() => setFailed(true)} />;
}

/** The tile's facts for a package diff. */
export function tileOf(diff: AssetDiff, fileName: string, path: string | undefined, status: "added" | "modified" | "deleted") {
  return {
    cls: diff.assetClass ?? diff.after?.class ?? diff.before?.class,
    fileName,
    path: path ?? diff.packageName,
    status,
    changes: changeCounts(diff.sections),
    facts: tileFacts(diff.before, diff.after),
  };
}
