/**
 * Where a change is refused to a paired phone: asks the computer to make it
 * (client-web views/remote/AskComputer.tsx). Nothing runs from the request;
 * the computer shows it and the owner makes the change there.
 */
import { useContext, useState } from "react";
import { View } from "react-native";
import { ASK_BUTTON, ASK_SENT, askFailed } from "@ue-mcp-studio/client-core";
import type { RemoteAskKind } from "@ue-mcp-studio/shared";
import { Button, T, useTheme } from "../ui";
import { ProjectContext } from "../nav";

/** `ask`: how to send it where no project is open yet (the refused screen); else the open project's API. */
export function AskComputer({ what, ask }: { what: RemoteAskKind; ask?: (what: RemoteAskKind) => Promise<unknown> }) {
  const t = useTheme();
  const nav = useContext(ProjectContext);
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  const send = ask ?? nav?.api.askComputer;
  if (!send) return null;
  const go = () => {
    setState("busy");
    send(what).then(() => setState("sent"), (e: Error) => setState(askFailed(e.message)));
  };
  return (
    <View style={{ gap: 6, alignItems: "flex-start", marginVertical: 6 }}>
      <Button title={ASK_BUTTON[what]} disabled={state === "busy"} onPress={go} />
      {state === "sent" ? <T style={{ color: t.c.dim }}>{ASK_SENT}</T> : null}
      {state !== "idle" && state !== "busy" && state !== "sent" ? <T accessibilityRole="alert" style={{ color: t.c.dim }}>{state}</T> : null}
    </View>
  );
}
