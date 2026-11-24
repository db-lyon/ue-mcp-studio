import { useState } from "react";
import { DISCONNECT_CAUSE, EDITOR_OPS, isConsentOp, stepsLine } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import { EditorConsent, useEditorConsent } from "./EditorConsent";
import type { DaemonState } from "../state";

export function StatusView({ daemon }: { daemon: DaemonState }) {
  const h = daemon.health;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const consent = useEditorConsent();
  const run = (op: "start" | "stop" | "restart" | "rebuild", override = false) => {
    setBusy(op);
    setResult(null);
    // Stop, restart and rebuild wait for the other sessions using the editor; start takes nothing from anyone.
    const answer = override ? consent.approve() : isConsentOp(op) ? consent.run(op) : api.editor(op);
    answer.then(
      (r) => setResult(r ? stepsLine(r) : null),
      (e: Error) => setResult(e.message),
    ).finally(() => setBusy(null));
  };

  if (!h) return <p className="muted">Connecting to ue-mcp</p>;
  return (
    <div className="stack">
      <section className="card">
        <h2>Editors</h2>
        {h.editors.map((e) => (
          <div key={e.name} className="row">
            <span className={`dot ${e.connected ? "ok" : "warn"}`} />
            <strong>{e.name}</strong>
            <span className="muted">port {e.port}{e.pid ? `, pid ${e.pid}` : ""}</span>
            <span className="spacer" />
            {!e.connected && e.lastDisconnect && (
              <span className="muted">
                {DISCONNECT_CAUSE[e.lastDisconnect.cause] ?? e.lastDisconnect.cause} at {new Date(e.lastDisconnect.at).toLocaleTimeString()}
              </span>
            )}
          </div>
        ))}
        <div className="actions">
          {EDITOR_OPS.map((op) => (
            <button key={op} disabled={busy !== null || (op === "start" ? h.editors.some((e) => e.connected) : !h.editors.some((e) => e.connected))} onClick={() => run(op)}>
              {busy === op ? `${op}...` : op[0].toUpperCase() + op.slice(1)}
            </button>
          ))}
        </div>
        {consent.ask && <EditorConsent ask={consent.ask} onApprove={() => run(consent.ask!.op, true)} onCancel={consent.cancel} />}
        {result && <p className="muted">{result}</p>}
      </section>
      <section className="card">
        <h2>Daemon</h2>
        <dl className="grid">
          <dt>Version</dt><dd>{h.version} (API {h.apiVersion})</dd>
          <dt>Process</dt><dd>pid {h.pid}, since {new Date(h.startedAt).toLocaleString()}</dd>
          <dt>MCP clients connected now</dt><dd>{h.clients}{h.inflight ? `, ${h.inflight} call(s) in flight` : ""}</dd>
          <dt>Extensions</dt><dd>{h.extensions.map((x) => `${x.name} ${x.version}`).join(", ") || "none"}</dd>
          <dt>UI</dt><dd>{h.ui ?? "development server"}</dd>
          <dt>Project</dt><dd className="mono">{h.projectRoot}</dd>
        </dl>
      </section>
    </div>
  );
}
