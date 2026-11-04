/**
 * The web client's views/remote/approvals.tsx, the parts the /remote reply
 * shows: devices waiting to be allowed, and the paired browsers with Remove.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { formatPairingCode, type RemoteApproval, type RemoteBrowser } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../../nav";
import { Banner, Button, T, font, useTheme } from "../../../../ui";
import { small } from "../../../../chat/styles";

/** How often the open approvals are read again besides the events that announce them. */
export const APPROVAL_POLL_MS = 10_000;

const APPROVAL_EVENTS = new Set(["studio.remote.approval", "studio.remote.paired"]);

/** Devices waiting for the owner to allow them, kept current by the agent's events. A refused route reads as none. */
export function useRemoteApprovals(): { approvals: RemoteApproval[]; decide: (id: string, allow: boolean) => Promise<string | null> } {
  const { api, project } = useProjectNav();
  const [approvals, setApprovals] = useState<RemoteApproval[]>([]);
  const load = useCallback(() => {
    api.remoteApprovals().then((r) => setApprovals(r.approvals), () => setApprovals([]));
  }, [api]);
  useEffect(() => {
    load();
    const timer = setInterval(load, APPROVAL_POLL_MS);
    const off = project.onEvent((e) => {
      if (APPROVAL_EVENTS.has(e.type)) load();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [load, project]);
  // Drop one at its expiry without waiting for the next read.
  useEffect(() => {
    if (approvals.length === 0) return;
    const next = Math.min(...approvals.map((a) => Date.parse(a.expiresAt))) - Date.now();
    const timer = setTimeout(load, Math.max(0, next) + 50);
    return () => clearTimeout(timer);
  }, [approvals, load]);
  const decide = useCallback(
    async (id: string, allow: boolean): Promise<string | null> => {
      try {
        await api.decideRemoteApproval(id, allow);
        setApprovals((list) => list.filter((a) => a.id !== id));
        return null;
      } catch (e) {
        load();
        return e instanceof Error ? e.message : String(e);
      }
    },
    [api, load],
  );
  return { approvals, decide };
}

// While a /remote reply is on screen it shows the requests itself, so a Studio-wide banner can leave them to it.
let cardsShown = 0;
const cardListeners = new Set<() => void>();

/** Call from the /remote reply while it is mounted. */
export function useApprovalsInCard(): void {
  useEffect(() => {
    cardsShown++;
    cardListeners.forEach((l) => l());
    return () => {
      cardsShown--;
      cardListeners.forEach((l) => l());
    };
  }, []);
}

/** Whether a /remote reply is showing the requests. */
export const approvalsInCard = (): boolean => cardsShown > 0;

/** One device asking to be allowed: its name, the six digits it shows, Allow or Deny. */
export function ApprovalPrompt({ approval, onDecide }: { approval: RemoteApproval; onDecide: (id: string, allow: boolean) => Promise<string | null> }) {
  const t = useTheme();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    setError(null);
    void onDecide(approval.id, allow).then((e) => {
      setBusy(null);
      setError(e);
    });
  };
  const text = t.c.warnText;
  return (
    // .banner.warn.remote-approval, 10 px above what follows it in the card.
    <Banner kind="warn" style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
      <View accessibilityRole="alert" accessibilityLabel={`${approval.label} wants to control ${approval.project}`} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0, gap: 4 }}>
        <T style={{ color: text }}>
          <T weight={700} style={{ color: text }}>{approval.label}</T>
          {` wants to control ${approval.project}.`}
        </T>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <T style={{ color: text }}>Code</T>
          <T style={{ ...font(t, "mono", 600, 22, 1.2), letterSpacing: 1.32, color: t.c.text }}>{formatPairingCode(approval.code)}</T>
        </View>
        <T style={[small(t), { color: t.c.dim }]}>Allow it only if your device shows the same code. Anyone you allow can run the agent on this computer.</T>
        {error ? <T accessibilityRole="alert" style={[small(t), { color: t.c.badText }]}>{error}</T> : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title={busy === "allow" ? "Allowing" : "Allow"} variant="primary" disabled={busy !== null} onPress={() => answer(true)} />
        <Button title={busy === "deny" ? "Denying" : "Deny"} disabled={busy !== null} onPress={() => answer(false)} />
      </View>
    </Banner>
  );
}

/** The browsers paired with this computer, each with Remove. */
export function PairedBrowsers() {
  const t = useTheme();
  const { api, project } = useProjectNav();
  const [browsers, setBrowsers] = useState<RemoteBrowser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.remoteBrowsers().then((b) => setBrowsers(b.browsers), (e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    load();
    return project.onEvent((e) => {
      if (e.type === "studio.remote.paired") load();
    });
  }, [load, project]);
  const remove = (b: RemoteBrowser) => {
    setBusy(b.id);
    setError(null);
    api.revokeRemoteBrowser(b.id).then(
      () => setBrowsers((list) => list?.filter((x) => x.id !== b.id) ?? null),
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(null));
  };
  if (!browsers) return error ? <T style={[small(t), { color: t.c.badText }]}>{error}</T> : null;
  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      <T style={[small(t), { color: t.c.muted, textTransform: "uppercase", letterSpacing: 0.48 }]}>Paired browsers</T>
      {browsers.length === 0 ? <T style={[small(t), { color: t.c.muted }]}>No browsers paired yet.</T> : null}
      {browsers.map((b) => (
        <View key={b.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T>{b.label}</T>
            <T style={[small(t), { color: t.c.dim }]}>{`Paired ${new Date(b.addedAt).toLocaleDateString()}`}</T>
          </View>
          <Button title={busy === b.id ? "Removing" : "Remove"} disabled={busy === b.id} onPress={() => remove(b)} />
        </View>
      ))}
      {error ? <T accessibilityRole="alert" style={[small(t), { color: t.c.badText }]}>{error}</T> : null}
    </View>
  );
}
