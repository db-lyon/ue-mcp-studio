/**
 * The Clips window: Clips on its own, popped out of the Arrangement into a
 * window of Studio's own (CLIPS_WINDOW_HASH). It edits nothing itself: a
 * pick, an add or an open goes to the Arrangement over the sync channel, and
 * the Arrangement's answer says what is picked and where an add goes. A clip
 * dragged from here drops onto the Arrangement's timelines as from its drawer.
 */
import { useEffect, useRef, useState } from "react";
import { SET_COPY } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { applyTheme } from "../../theme";
import { ClipBrowser } from "./ClipBrowser";
import { openSync, type ClipRef, type SyncMessage } from "./arrangement-sync";
import "./hub.css";
import "./arrangement.css";

const ref = (c: { kind: ClipRef["kind"]; target: string; name?: string }): ClipRef => ({ kind: c.kind, target: c.target, name: c.name });

export function ClipsWindow() {
  const [state, setState] = useState<Extract<SyncMessage, { t: "state" }> | null>(null);
  const sync = useRef<ReturnType<typeof openSync>>(null);
  useEffect(() => {
    document.title = SET_COPY.clips;
    api.settings().then((s) => void applyTheme(s.theme), () => void applyTheme("ue-mcp"));
    const s = openSync((m) => {
      if (m.t === "state") setState(m);
      else if (m.t === "ping") s?.post({ t: "hello" });
      else if (m.t === "close") window.close();
    });
    sync.current = s;
    s?.post({ t: "hello" });
    const bye = () => s?.post({ t: "bye" });
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bye();
      s?.close();
    };
  }, []);
  const post = (m: SyncMessage) => sync.current?.post(m);
  return (
    <div className="app">
    <div className="hub-root hub-set hub-clips-window">
      <header className="hub-clips-window-head">
        <h1>{SET_COPY.clips}</h1>
        <span className="dim small">{state ? state.addsTo : SET_COPY.noArrangement}</span>
      </header>
      <ClipBrowser
        variant="window"
        picked={state?.picked ?? null}
        version={state?.version ?? 0}
        addsTo={state?.addsTo ?? SET_COPY.noArrangement}
        onPick={(c) => post({ t: "pick", clip: c ? ref(c) : null })}
        onAdd={(c) => post({ t: "add", clip: ref(c) })}
        onOpen={(c) => post({ t: "open", clip: ref(c) })}
      />
    </div>
    </div>
  );
}
