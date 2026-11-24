/**
 * The runner editor in one line, for the Overview's Now running strip: what
 * it is doing, and Stop runner while it is up. Nothing while there is no
 * runner, which is every ue-mcp until asks 13 and 14 ship (runner-editor.md).
 */
import { useState } from "react";
import { RUNNER_COPY, runnerLine } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";

export function RunnerStatus() {
  const { data, notify } = useHub();
  const [busy, setBusy] = useState(false);
  const v = data.runner?.runner;
  if (!v || (v.state === "stopped" && !v.error)) return null;
  const up = v.state === "starting" || v.state === "ready" || v.state === "running";
  const stop = () => {
    setBusy(true);
    api.hubStopRunner().catch((e: Error) => notify(e.message, "bad")).finally(() => setBusy(false));
  };
  return (
    <div className="hub-now-line" role="status" aria-label={RUNNER_COPY.name}>
      <span className="hub-row-title">{RUNNER_COPY.name}</span>
      <span className="dim small">{runnerLine(v)}</span>
      {up && <button className="ghost small-button" disabled={busy} title={RUNNER_COPY.stopHelp} onClick={stop}>{RUNNER_COPY.stop}</button>}
    </div>
  );
}
