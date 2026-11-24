/**
 * An editor operation the consent gate held (ue-mcp feature "editor.consent"),
 * drawn natively: who is holding it and why, with the person's override and
 * Cancel. The web client's views/EditorConsent.tsx is the same.
 */
import { useState } from "react";
import { View } from "react-native";
import { STUDIO_REQUESTER, consentAskOf, consentCopy, consentHolders, type AskKind, type ConsentAsk, type ConsentOp, type EditorDisruptionRequest, type EditorOpBody } from "@ue-mcp-studio/client-core";
import { Banner, Button, T, bannerText, useTheme } from "../../ui";

/** `ask.op` is a button's operation, or "update" for an Update that closes the editor. */
export function EditorConsent({ ask, onApprove, onCancel }: { ask: { op: AskKind; request: EditorDisruptionRequest }; onApprove: () => void; onCancel: () => void }) {
  const t = useTheme();
  const copy = consentCopy(ask.op);
  const holders = consentHolders(ask.request);
  const color = { color: bannerText(t, "warn") };
  return (
    <View testID="editor-consent">
      <Banner kind="warn" role="alert">
        <T weight={700} size={12} style={color}>{copy.title}</T>
        <T size={12} style={[color, { marginTop: 4 }]}>{copy.lead}</T>
        {holders.map((h) => (
          <T key={h.session} size={12} style={[color, { marginTop: 4 }]}>
            <T weight={700} size={12} style={color}>{h.label}</T>: {h.state}
            {h.reason ? `, ${h.reason}` : ""}
          </T>
        ))}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <Button variant="primary" title={copy.approve} onPress={onApprove} />
          <Button variant="ghost" title={copy.cancel} onPress={onCancel} />
        </View>
      </Banner>
    </View>
  );
}

/** The two routes the ask needs, which every phone API object has. */
export interface ConsentApi {
  editor(op: ConsentOp, body?: EditorOpBody): Promise<Record<string, unknown>>;
  denyDisruption(id: string, by: string): Promise<unknown>;
}

/**
 * Run an editor operation from a button, and keep the gate's ask when it is
 * held. `run` resolves with the operation's answer, or with null while the
 * person is being asked; any other error throws as before.
 */
export function useEditorConsent(api: ConsentApi) {
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
  const approve = (): Promise<Record<string, unknown> | null> => {
    const op = ask?.op;
    setAsk(null);
    return op ? run(op, { force: true }) : Promise.resolve(null);
  };
  const cancel = () => {
    if (ask) void api.denyDisruption(ask.request.id, STUDIO_REQUESTER).catch(() => undefined);
    setAsk(null);
  };
  return { ask, run, approve, cancel };
}
