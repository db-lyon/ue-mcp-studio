/**
 * A step's arrange and act, as a line under its text: what the engine sets up
 * and does before the step is checked, with the assets they name linked. The
 * entries are ue-mcp's script step format (docs/pie-scripts.md, Arrange and
 * act): arrange is {kind: spawn|set|call, class|target, ...}, each act entry
 * one verb, {press: {action}} or {place: {at}}.
 */
import { Fragment } from "react";
import { assetLinkTarget, classifyAssetToken, type QaStep } from "@ue-mcp-studio/shared";
import { AssetToken, ExactAssetLink } from "./AssetLink";

export interface SetupEntry {
  verb: string;
  /** The actor, class or asset the entry names. */
  target: string | null;
  /** What it does to the target: a set's property and value, a call's function. */
  detail?: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const brief = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The keys an act entry names its target by, in the order they are read. */
const TARGET_KEYS = ["action", "at", "target", "class", "actor", "asset", "map"];

function arrangeEntry(e: Record<string, unknown>): SetupEntry {
  const kind = str(e.kind) ?? "arrange";
  if (kind === "spawn") return { verb: "spawn", target: str(e.class) };
  if (kind === "set") return { verb: "set", target: str(e.target), ...(str(e.path) ? { detail: `${e.path} = ${brief(e.value)}` } : {}) };
  if (kind === "call") return { verb: "call", target: str(e.target), ...(str(e.func) ? { detail: str(e.func)! } : {}) };
  return { verb: kind, target: str(e.target) ?? str(e.class) };
}

function actEntry(e: Record<string, unknown>): SetupEntry {
  const [verb, body] = Object.entries(e)[0] ?? ["act", null];
  const b = obj(body);
  const key = b ? TARGET_KEYS.find((k) => str(b[k])) : undefined;
  const target = key ? str(b![key]) : str(body);
  return { verb: key === "at" ? `${verb} at` : verb, target };
}

/** A step's arrange and act entries in words, in the order they run. */
export function stepSetup(s: Pick<QaStep, "arrange" | "act">): { arrange: SetupEntry[]; act: SetupEntry[] } {
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(obj).filter((x): x is Record<string, unknown> => !!x);
  return { arrange: list(s.arrange).map(arrangeEntry), act: list(s.act).map(actEntry) };
}

/** A target as a link where it names an asset: an object path exactly, an asset-like name once it resolves. A class's _C is the Blueprint's. */
export function SetupTarget({ target }: { target: string }) {
  const asset = target.replace(/\.([A-Za-z0-9_]+)_C$/, ".$1").replace(/_C$/, "");
  if (asset.startsWith("/")) {
    const path = assetLinkTarget(asset);
    if (path) return <ExactAssetLink path={path} label={path.slice(path.lastIndexOf(".") + 1)} />;
  }
  if (asset.includes("_") && classifyAssetToken(asset)?.kind === "name") return <AssetToken token={asset} code={false} />;
  return <>{target}</>;
}

function Entries({ entries }: { entries: SetupEntry[] }) {
  return (
    <>
      {entries.map((e, i) => (
        <Fragment key={i}>
          {i > 0 && ", "}
          {e.verb}
          {e.target && <> <SetupTarget target={e.target} /></>}
          {e.detail && <> <span className="mono">{e.detail}</span></>}
        </Fragment>
      ))}
    </>
  );
}

/** The line under a step that sets itself up or acts; nothing for a step that does neither. */
export function StepSetup({ step }: { step: Pick<QaStep, "arrange" | "act"> }) {
  const { arrange, act } = stepSetup(step);
  if (!arrange.length && !act.length) return null;
  return (
    <div className="qa-setup dim small">
      {arrange.length > 0 && <span className="qa-setup-part"><span className="qa-setup-lead">Arrange: </span><Entries entries={arrange} /></span>}
      {act.length > 0 && <span className="qa-setup-part"><span className="qa-setup-lead">Act: </span><Entries entries={act} /></span>}
    </div>
  );
}
