/**
 * /remote (and /rc): the client answers it itself, never the agent, as the
 * web client's views/Chat.tsx does. useRemoteCommand takes the command out of
 * the composer; RemoteReply is the answer above it: the pairing code on a paid
 * plan, the sign-in when signed out, the Upgrade action otherwise. It stays
 * until the next message or Dismiss.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { REMOTE_COMMAND, REMOTE_COMMAND_REPLY, SLASH_COMMANDS, STUDIO_PLAN_AVAILABLE, isLocalCommand, remoteCommand, remoteShown, type SlashCommand } from "@ue-mcp-studio/shared";
import { T, useTheme } from "../../../ui";
import { SignInForm } from "./ModelPicker";
import { RemoteChatCard } from "./remote/RemoteChatCard";
import { REMOTE_NOW_ON, REMOTE_SIGN_IN, UpgradeAction } from "./remote/Upgrade";
import { useRemoteAvailable } from "./remote/remote-available";

export { RemoteChatCard } from "./remote/RemoteChatCard";
export { PairingCode, pairingExpired, timeLeft } from "./remote/PairingCode";
export { ApprovalPrompt, PairedBrowsers, useApprovalsInCard, useRemoteApprovals } from "./remote/approvals";
export { CHECKOUT_OPENED, REMOTE_NOW_ON, REMOTE_SIGN_IN, UpgradeAction } from "./remote/Upgrade";
export { useRemoteAvailable, watchForCheckout, stopCheckoutWatch } from "./remote/remote-available";

/** The account name the sign-in names, as Settings' account card does. */
export const ACCOUNT_NAME = "your ue-mcp account";

export type RemoteState = ReturnType<typeof useRemoteAvailable>;

export interface RemoteCommand {
  /** The slash commands the menu offers: /remote only where Settings lists remote control. */
  commands: readonly SlashCommand[];
  /** Answers the draft when it is /remote: true when it took it, and the composer sends nothing. */
  runRemoteCommand: () => boolean;
  /** The session the reply is open in, or null. */
  reply: string | null;
  dismiss: () => void;
  remote: RemoteState;
}

export function useRemoteCommand({ sessionId, draft, setDraft, readyFiles, saveDraft }: {
  sessionId: string | null;
  draft: string;
  setDraft: (text: string) => void;
  /** Files attached and uploaded: /remote with files is an ordinary message. */
  readyFiles: number;
  saveDraft: (id: string, text: string) => Promise<unknown>;
}): RemoteCommand {
  const remote = useRemoteAvailable(false);
  // Listed in the menu only where Settings lists remote control; typed, it also answers any signed-in account without a paid plan.
  const listed = remoteShown(remote.surface);
  const action = remoteCommand(STUDIO_PLAN_AVAILABLE, remote.available, remote.signedIn ?? true);
  const commands = useMemo(() => (listed ? [...SLASH_COMMANDS, REMOTE_COMMAND] : SLASH_COMMANDS), [listed]);
  const [reply, setReply] = useState<string | null>(null);
  const runRemoteCommand = (): boolean => {
    if (!sessionId || !action || readyFiles > 0 || !isLocalCommand(draft, REMOTE_COMMAND)) return false;
    setDraft("");
    void saveDraft(sessionId, "").catch(() => undefined);
    setReply(sessionId);
    return true;
  };
  return { commands, runRemoteCommand, reply, dismiss: () => setReply(null), remote };
}

/** .msg.assistant.local-reply: the words and a 24 px close, then the card across the width, at most 60% of the screen tall. */
export function RemoteReply({ remote, onDismiss, onSettings }: { remote: RemoteState; onDismiss: () => void; onSettings?: () => void }) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  const text = remote.available ? REMOTE_NOW_ON : remote.signedIn === false ? REMOTE_SIGN_IN : REMOTE_COMMAND_REPLY;
  return (
    <ScrollView
      accessibilityLiveRegion="polite"
      style={{ alignSelf: "flex-start", marginHorizontal: 14, marginBottom: 8, maxHeight: height * 0.6, maxWidth: "100%" }}
      contentContainerStyle={{ paddingVertical: 10, paddingRight: 13, paddingLeft: 2, gap: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <T style={{ flex: 1, minWidth: 0, alignSelf: "center", fontSize: t.base.size, lineHeight: t.base.lineHeight, color: t.c.text }}>{text}</T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          style={({ pressed }) => ({ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.lineStrong : t.c.line, backgroundColor: t.c.panel2 })}
          hitSlop={10}
        >
          <T style={{ color: t.c.muted, fontSize: 14, lineHeight: 16 }}>{"×"}</T>
        </Pressable>
      </View>
      {remote.available ? (
        <RemoteChatCard onSettings={onSettings && (() => {
          onDismiss();
          onSettings();
        })} />
      ) : remote.signedIn === false ? (
        <View style={{ gap: 8 }}>
          <SignInForm id="studio" name={ACCOUNT_NAME} about="Sign in with GitHub." onDone={remote.recheck} />
        </View>
      ) : (
        <UpgradeAction />
      )}
    </ScrollView>
  );
}
