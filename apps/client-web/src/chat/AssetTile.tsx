/**
 * What a review shows for an asset version with no picture: the type's icon,
 * its class and object path, what the turn changed in it, and its facts. Unreal
 * keeps no thumbnail for many types (levels, data, input), and an empty frame
 * says nothing, so the space carries what Studio already knows instead. What
 * the tile says is worked out in client-core, shared with the mobile app.
 */
import { useState, type ReactNode } from "react";
import { ASSET_ICON_PATHS, TILE_STATUS_LINE, assetFamily, type AssetFamily } from "@ue-mcp-studio/client-core";
import { EngineText } from "./breakable";

export { TILE_FACTS, assetFamily, changeCounts, tileFacts, tileOf, type AssetFamily } from "@ue-mcp-studio/client-core";

export function AssetIcon({ family }: { family: AssetFamily }) {
  return (
    <svg className={`asset-icon ${family}`} width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ASSET_ICON_PATHS[family]} />
    </svg>
  );
}

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
          <span className={`asset-tile-status small ${status}`}>{TILE_STATUS_LINE[status]}</span>
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
export function PictureOr({ src, alt, title, lazy, fallback, caption }: { src: string; alt: string; title?: string; lazy?: boolean; fallback: ReactNode; caption?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  const img = <img src={src} alt={alt} title={title} loading={lazy ? "lazy" : undefined} onError={() => setFailed(true)} />;
  // A caption names the picture that drew, so it is never read as the note of the one beside it that failed.
  return caption ? <>{img}<span className="picture-caption mono small dim">{caption}</span></> : img;
}
