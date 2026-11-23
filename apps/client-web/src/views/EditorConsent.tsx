/**
 * An editor operation the consent gate held (ue-mcp feature "editor.consent"):
 * who is holding it and why, with the person's override and Cancel. The
 * mobile app draws the same in screens/editor/EditorConsent.tsx.
 */
import { useState } from "react";
import { STUDIO_REQUESTER, consentAskOf, consentCopy, consentHolders, type ConsentAsk, type ConsentOp, type EditorOpBody } from "@ue-mcp-studio/client-core";
import { api } from "../api";

export function EditorConsent({ ask, onApprove, onCancel }: { ask: ConsentAsk; onApprove: () => void; onCancel: () => void }) {
  const copy = consentCopy(ask.op);
  const holders = consentHolders(ask.request);
  return (
    <div className="banner warn small" role="alert" data-testid="editor-consent">
      <strong>{copy.title}</strong>
      <p>{copy.lead}</p>
      {holders.length > 0 && (
        <ul className="consent-holders">
          {holders.map((h) => (
            <li key={h.session}>
              <strong>{h.label}</strong>: {h.state}{h.reason ? <span className="muted">, {h.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="primary" onClick={onApprove}>{copy.approve}</button>
        <button className="ghost" onClick={onCancel}>{copy.cancel}</button>
      </div>
    </div>
  );
}

/**
 * Run an editor operation from a button, and keep the gate's ask when it is
 * held. `run` resolves with the operation's answer, or with null while the
 * person is being asked; any other error throws as before.
 */
export function useEditorConsent() {
  const [ask, setAsk] = useState<ConsentAsk | null>(null);
  const run = async (op: ConsentOp, body?: EditorOpBody): Promise<Record<string, unknown> | null> => {
    try {
      // Named on the first ask too, so the override reuses the request the sessions were already told about.
      const r = await api.editor(op, { requester: STUDIO_REQUESTER, ...body });
      setAsk(null);
      return r;
    } catch (e) {
      const held = consentAskOf(op, e);
      if (!held) throw e;
      setAsk(held);
      return null;
    }
  };
  /** The person's override: the same operation again, run now. */
  const approve = (): Promise<Record<string, unknown> | null> => {
    const op = ask?.op;
    setAsk(null);
    return op ? run(op, { force: true }) : Promise.resolve(null);
  };
  /** The person gives up: the request is denied so the sessions stop waiting on it. */
  const cancel = () => {
    if (ask) void api.denyDisruption(ask.request.id, STUDIO_REQUESTER).catch(() => undefined);
    setAsk(null);
  };
  return { ask, run, approve, cancel };
}
