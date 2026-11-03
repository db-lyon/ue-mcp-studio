import { useCallback, useEffect, useRef, useState } from "react";
import { REMOTE_NO_PLAN, type RemotePairing, type RemoteStatus } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { ApprovalPrompt, PairedBrowsers, useApprovalsInCard, useRemoteApprovals } from "./approvals";
import { PairingCode } from "./PairingCode";

/** How often the card rereads the connection while it waits for it, and how long it waits. */
export const CONNECT_POLL_MS = 1000;
export const CONNECT_WAIT_MS = 30_000;

export type ChatCardState =
  | { at: "connecting" }
  | { at: "code"; pairing: RemotePairing }
  | { at: "error"; message: string };

/** Why a status that is not online will not become online by waiting, or null while it still may. */
function failed(s: RemoteStatus): string | null {
  if (s.state !== "error") return null;
  if (s.code === "no-plan") return REMOTE_NO_PLAN;
  return s.reason ?? `Could not reach the relay at ${s.relay}.`;
}

/**
 * /remote on a paid account: remote control turned on if it was off, then a
 * pairing code to scan, in the chat. Waits for the relay connection first and
 * says plainly why when it does not come.
 */
export function RemoteChatCard({ onSettings }: { onSettings?: () => void }) {
  const [state, setState] = useState<ChatCardState>({ at: "connecting" });
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const { approvals, decide } = useRemoteApprovals();
  useApprovalsInCard();

  const start = useCallback(async () => {
    const mine = ++run.current;
    const live = () => mine === run.current;
    setState({ at: "connecting" });
    try {
      let s = await api.remoteStatus();
      if (!live()) return;
      if (!s.enabled) s = await api.setRemote(true);
      if (!live()) return;
      const until = Date.now() + CONNECT_WAIT_MS;
      while (s.state !== "online") {
        const why = failed(s);
        if (why) throw new Error(why);
        if (Date.now() > until) throw new Error(`Remote control did not connect to ${s.relay} within ${CONNECT_WAIT_MS / 1000} seconds.`);
        await new Promise((r) => setTimeout(r, CONNECT_POLL_MS));
        if (!live()) return;
        s = await api.remoteStatus();
      }
      const pairing = await api.pairRemote();
      if (live()) setState({ at: "code", pairing });
    } catch (e) {
      if (!live()) return;
      const message = e instanceof ApiError && e.status === 403 ? REMOTE_NO_PLAN : e instanceof Error ? e.message : String(e);
      setState({ at: "error", message });
    }
  }, []);

  useEffect(() => {
    void start();
    return () => void run.current++;
  }, [start]);

  const renew = () => {
    setBusy(true);
    api.pairRemote().then(
      (pairing) => setState({ at: "code", pairing }),
      (e: Error) => setState({ at: "error", message: e instanceof ApiError && e.status === 403 ? REMOTE_NO_PLAN : e.message }),
    ).finally(() => setBusy(false));
  };

  return (
    <div className="remote-chat-card">
      {state.at === "connecting" && <p className="muted small" role="status"><span className="dot warn" /> Connecting to the relay</p>}
      {state.at === "error" && (
        <div className="banner bad row" role="alert">
          <span className="grow">{state.message}</span>
          <button onClick={() => void start()}>Retry</button>
        </div>
      )}
      {approvals.map((a) => <ApprovalPrompt key={a.id} approval={a} onDecide={decide} />)}
      {state.at === "code" && (
        <>
          <p className="small">Scan the code with your phone, or open the link on it. Then allow the device here: it shows a code that must match. It pairs the device with every project on this computer.</p>
          <PairingCode pairing={state.pairing} onRenew={renew} busy={busy} />
        </>
      )}
      {state.at !== "connecting" && <PairedBrowsers />}
      {onSettings && <button className="ghost small-button remote-manage" onClick={onSettings}>Manage paired browsers in Settings</button>}
    </div>
  );
}
