// TEMPORARY: the transcript port drawn on the session route until chat-core's
// views/Chat.tsx lands and renders MainTranscript itself. The integrator drops
// this file and its line in Project.tsx. The header and composer are blank
// blocks of the web client's heights, so the transcript sits where it does there.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useProjectNav } from "../nav";
import { useSession } from "../session";
import { useTheme } from "../ui";
import { MainTranscript, SubagentThread, EditMessageContext } from "../chat/Transcript";
import { Approvals } from "../chat/Approvals";
import { DialogCards } from "../chat/Dialogs";
import { FormCards, useForms } from "../chat/Forms";
import { useDialogs } from "../chat/dialog-model";
import { AskedContext } from "../chat/asked";
import { CompactContext } from "../chat/Compaction";
import { SessionIdContext } from "../chat/attachments";
import { AssetLinksContext, AssetTranscriptContext, useAssetLinks } from "../chat/asset-links";
import type { Call } from "@ue-mcp-studio/client-core";

export function TranscriptPreview({ id }: { id: string }) {
  const t = useTheme();
  const { project, api: studio } = useProjectNav();
  const { detail, streaming } = useSession(project, studio, id);
  const dialogs = useDialogs();
  const forms = useForms(id);
  const links = useAssetLinks(id);
  const [thread, setThread] = useState<string | null>(null);
  const asked = useMemo(() => new Set((detail?.approvals ?? []).map((a) => a.toolUseId)), [detail?.approvals]);
  const call = thread ? (detail?.transcript.find((e) => e.kind === "tool" && e.call.id === thread) as { call: Call } | undefined)?.call : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.panel }}>
      <View style={{ height: 95,backgroundColor: t.c.bg }} />
      {detail ? (
        <AskedContext.Provider value={asked}>
          <SessionIdContext.Provider value={id}>
            <AssetLinksContext.Provider value={links}>
              <AssetTranscriptContext.Provider value={detail.transcript}>
                <EditMessageContext.Provider value={() => undefined}>
                  <CompactContext.Provider value={() => undefined}>
                    <View style={{ flex: 1, minHeight: 0 }}>
                      {call ? (
                        <SubagentThread call={call} transcript={detail.transcript} sessionWaiting={detail.status === "waiting"} onBack={() => setThread(null)} onStop={() => undefined} />
                      ) : (
                        <MainTranscript transcript={detail.transcript} status={detail.status} streaming={streaming} waitingCause={detail.waitingCause} error={detail.error} onOpen={setThread} hidden={false} />
                      )}
                    </View>
                    <DialogCards dialogs={(dialogs.state?.dialogs ?? []).filter((d) => d.sessionId === id)} now={dialogs.now()} />
                    <Approvals sessionId={id} approvals={detail.approvals ?? []} />
                    <FormCards forms={forms} />
                  </CompactContext.Provider>
                </EditMessageContext.Provider>
              </AssetTranscriptContext.Provider>
            </AssetLinksContext.Provider>
          </SessionIdContext.Provider>
        </AskedContext.Provider>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <View style={{ height: t.editor ? 133 : 141, backgroundColor: t.c.composerBg, borderTopWidth: 1, borderTopColor: t.c.line }} />
    </View>
  );
}
