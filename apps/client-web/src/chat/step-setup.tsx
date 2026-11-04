/**
 * A step's arrange and act, as a line under its text: what the engine sets up
 * and does before the step is checked, with the assets they name linked. The
 * entries are ue-mcp's script step format (docs/pie-scripts.md, Arrange and
 * act): arrange is {kind: spawn|set|call, class|target, ...}, each act entry
 * one verb, {press: {action}} or {place: {at}}.
 */
import { Fragment } from "react";
import { assetLinkTarget, classifyAssetToken, type QaStep } from "@ue-mcp-studio/shared";
import { setupAsset, stepSetup, type SetupEntry } from "@ue-mcp-studio/client-core";

export { stepSetup, type SetupEntry } from "@ue-mcp-studio/client-core";
import { AssetToken, ExactAssetLink } from "./AssetLink";

/** A target as a link where it names an asset: an object path exactly, an asset-like name once it resolves. A class's _C is the Blueprint's. */
export function SetupTarget({ target }: { target: string }) {
  const asset = setupAsset(target);
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
