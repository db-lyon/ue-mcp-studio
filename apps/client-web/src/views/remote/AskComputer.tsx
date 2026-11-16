import { useState } from "react";
import type { RemoteAskKind } from "@ue-mcp-studio/shared";
import { ASK_BUTTON, ASK_SENT, askFailed } from "@ue-mcp-studio/client-core";
import { api } from "../../api";

/**
 * On a paired browser, where a change is refused: asks the computer to make
 * it. Nothing runs from the request; the computer shows it and the owner
 * makes the change there.
 */
export function AskComputer({ what }: { what: RemoteAskKind }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  const ask = () => {
    setState("busy");
    api.askComputer(what).then(() => setState("sent"), (e: Error) => setState(askFailed(e.message)));
  };
  const failed = state !== "idle" && state !== "busy" && state !== "sent";
  return (
    <span className="ask-computer">
      <button disabled={state === "busy"} onClick={ask}>{ASK_BUTTON[what]}</button>
      {state === "sent" && <span className="dim small" role="status"> {ASK_SENT}</span>}
      {failed && <span className="dim small" role="alert"> {state}</span>}
    </span>
  );
}
