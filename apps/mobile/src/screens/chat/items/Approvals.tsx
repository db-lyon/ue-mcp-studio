import { useState, type ReactNode } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { ApprovalDecision, ApprovalRequest } from "@ue-mcp-studio/shared";
import { RESTART_OPERATION, approvalTitle } from "@ue-mcp-studio/client-core";
import { Banner, baseFont, ContentButton, font, labelFont, Output, useTheme, type Theme } from "../../../ui";
import { useProjectNav } from "../../../nav";
import { haptic } from "../../../native/haptics";
import { DiffView } from "../../../chat/Diff";

/**
 * .approvals: the cards waiting for the user under the conversation, 10px
 * apart, 8px 10px in from the panel, at most half the screen and scrolling.
 */
export function CardsRegion({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) {
  const vh = useWindowDimensions().height;
  const t = useTheme();
  // It paints the panel it sits on, as the transcript does: a scroller on a layer keeps subpixel text only over an opaque background.
  return (
    <ScrollView testID={testID} accessibilityRole="none" accessibilityLabel={label} style={{ maxHeight: vh * 0.5, flexGrow: 0, flexShrink: 0, backgroundColor: t.c.panel }} contentContainerStyle={{ gap: 10, paddingTop: 8, paddingHorizontal: 10 }} nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

/** .approval.card: the accent outline (none in the editor themes) on the accent wash, 12px 14px, its parts 8px apart. */
export function approvalCard(t: Theme) {
  return {
    borderWidth: 1,
    borderColor: t.editor ? "transparent" : t.c.accentLine,
    backgroundColor: t.c.accentWash,
    borderRadius: t.radiusLg,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
    minWidth: 0,
    ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}),
  } as const;
}

/** The calls waiting for the user, oldest first, each with its own buttons. */
export function Approvals({ sessionId, approvals }: { sessionId: string; approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) return null;
  return (
    <CardsRegion label="Waiting for your approval" testID="approvals">
      {approvals.map((a) => <ApprovalCard key={a.id} sessionId={sessionId} approval={a} />)}
    </CardsRegion>
  );
}

/** One command or file change: what it is, and Allow, Allow for this session, Deny. */
export function ApprovalCard({ sessionId, approval: a }: { sessionId: string; approval: ApprovalRequest }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const vh = useWindowDimensions().height;
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: ApprovalDecision) => {
    haptic.success();
    setSent(decision);
    setError(null);
    api.approve(sessionId, a.id, decision).catch((e: Error) => {
      setSent(null);
      setError(e.message);
    });
  };
  const title = approvalTitle(a);
  const body = baseFont(t);
  const small = { ...body, fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size), color: t.c.dim };
  const path = { ...font(t, "mono", 400, 12, 1.5), color: t.c.text };
  const outputMax = vh * 0.28;
  return (
    <View accessibilityRole="none" accessibilityLabel={title} style={approvalCard(t)}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={labelFont(t)}>{title}</Text>
        {a.subagent ? <Text style={small}>{`from subagent ${a.subagent}`}</Text> : null}
      </View>
      {a.tool === "shell" ? (
        <>
          <Output maxHeight={outputMax}>{`$ ${a.command ?? ""}`}</Output>
          {a.cwd ? <Text style={small}>{`in ${a.cwd}`}</Text> : null}
        </>
      ) : a.tool === "editor_restart" ? (
        <>
          <Text style={body}>{`${RESTART_OPERATION[a.operation ?? "restart"]}. Unsaved work in the editor is lost.`}</Text>
          {a.reason ? <Text style={small}>{`Why: ${a.reason}`}</Text> : null}
        </>
      ) : a.tool === "ue_mcp" ? (
        <>
          <Text style={path}>{`${a.call?.category}.${a.call?.method}`}</Text>
          <Output maxHeight={outputMax}>{JSON.stringify(a.call?.args ?? {}, null, 2)}</Output>
          <Text style={small}>ue-mcp marks this action as one that deletes or overwrites.</Text>
        </>
      ) : (
        <>
          <Text style={path}>{a.path}</Text>
          <DiffView lines={a.diff ?? []} label={`Changes to ${a.path}`} maxHeight={outputMax} />
        </>
      )}
      {error ? <Banner kind="bad">{error}</Banner> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginVertical: 6 }}>
        <ContentButton kind="primary" title="Allow" disabled={sent !== null} onPress={() => answer("allow")} />
        <ContentButton title="Allow for this session" disabled={sent !== null} onPress={() => answer("session")} />
        <ContentButton kind="ghost" title="Deny" disabled={sent !== null} onPress={() => answer("deny")} />
      </View>
    </View>
  );
}
