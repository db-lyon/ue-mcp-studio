/**
 * Runs holding at a manual step for the person's verdict, on the phone
 * (client-web held.tsx and held-context.ts): the list from GET /qa/held and
 * studio.qa.held, the context the playtest card reads for Resume and watch,
 * and the bar under the top bar on every tab, with its countdown, the
 * verdict, Stop now, Live and the way to the card. Beside it, the Playtest
 * Hub's lease bar: while the hub holds the editor, every tab says so and
 * offers Release the editor (client-web held.tsx LeaseBar).
 */
import { createContext, useContext, useEffect, useState } from "react";
import { View } from "react-native";
import { HELD_COPY, LEASE_COPY, QA_VERDICTS, heldForBar, heldLeft, heldOfEvent, leaseOfEvent } from "@ue-mcp-studio/client-core";
import type { EditorLease, QaHeld, QaVerdict } from "@ue-mcp-studio/shared";
import { useProjectNav } from "./nav";
import type { DaemonState } from "./state";
import { Banner, T, useTheme } from "./ui";
import { FailNote, SmallButton } from "./screens/playtests/parts";
import { LiveButton } from "./chat/PieLive";
import { SHELL_BANNER } from "./views/VersionNotice";

export interface HeldValue {
  held: QaHeld[];
  /** Resume and watch: Play In Editor runs again while the step waits. */
  resume: (runId: string) => Promise<void>;
}

export const HeldContext = createContext<HeldValue | null>(null);

/** The held run with this id, while it waits. */
export function useHeldRun(runId: string): { held: QaHeld; resume: () => Promise<void> } | null {
  const v = useContext(HeldContext);
  const held = v?.held.find((h) => h.runId === runId);
  return v && held ? { held, resume: () => v.resume(runId) } : null;
}

/** The list as the agent has it: read when the stream comes up, then replaced by each studio.qa.held. */
export function useHeld(daemon: Pick<DaemonState, "events" | "streaming">): HeldValue {
  const { api } = useProjectNav();
  const [held, setHeld] = useState<QaHeld[]>([]);
  useEffect(() => {
    if (!daemon.streaming) return;
    api.qaHeld().then((r) => setHeld(Array.isArray(r?.held) ? r.held : []), () => setHeld([]));
  }, [daemon.streaming, api]);
  const last = [...daemon.events].reverse().find((e) => heldOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? heldOfEvent(last) : null;
    if (next) setHeld(next);
  }, [last?.id]);
  const resume = async (runId: string) => {
    const r = await api.qaResume(runId);
    setHeld((list) => list.map((h) => (h.runId === runId ? r.held : h)));
  };
  return { held, resume };
}

/** The hub's lease as the agent has it: read when the stream comes up, then replaced by each studio.hub.lease. */
export function useLease(daemon: Pick<DaemonState, "events" | "streaming">): EditorLease | null {
  const { api } = useProjectNav();
  const [lease, setLease] = useState<EditorLease | null>(null);
  useEffect(() => {
    if (!daemon.streaming) return;
    // An agent without the hub has no route: nothing is leased then.
    api.hubLease().then((r) => setLease(r?.lease ?? null), () => setLease(null));
  }, [daemon.streaming, api]);
  const last = [...daemon.events].reverse().find((e) => leaseOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? leaseOfEvent(last) : null;
    if (next) setLease(next.lease);
  }, [last?.id]);
  return lease;
}

/** The bar while the Playtest Hub holds the editor: what it runs, and Release the editor. */
export function LeaseBar({ lease }: { lease: EditorLease | null }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lease) return null;
  const release = () => {
    setBusy(true);
    setError(null);
    api.hubRelease().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Banner role="status" style={[SHELL_BANNER, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
      <T style={{ color: t.c.text }}>
        <T weight={700} style={{ color: t.c.text }}>{LEASE_COPY.holding}</T> {lease.purpose}
      </T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <SmallButton title={LEASE_COPY.release} label={LEASE_COPY.releaseHelp} danger disabled={busy} onPress={release} />
      </View>
      {error ? <T accessibilityRole="alert" style={{ color: t.c.badText }}>{error}</T> : null}
    </Banner>
  );
}

export function HeldBar({ value, onOpenCard, onWatchLive }: { value: HeldValue; onOpenCard: (h: QaHeld) => void; onWatchLive: () => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const h = heldForBar(value.held);
  const [now, setNow] = useState(() => Date.now());
  const [failing, setFailing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!h) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [!!h]);
  useEffect(() => {
    setFailing(false);
    setError(null);
  }, [h?.runId, h?.step]);
  if (!h) return null;
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    f().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const decide = (verdict: QaVerdict, note?: string) => act(() => api.qaVerdict(h.runId, h.step, verdict, note));
  return (
    <Banner kind="warn" role="status" style={[SHELL_BANNER, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <T style={{ flex: 1, minWidth: 0, color: t.c.text }}>
          <T weight={700} style={{ color: t.c.text }}>{HELD_COPY.waiting(h)}</T> {h.instruction}
        </T>
        <T accessibilityRole="timer" style={{ color: t.c.warnText, fontVariant: ["tabular-nums"] }}>{HELD_COPY.endsIn(heldLeft(h.dueAt, now))}</T>
      </View>
      {failing ? (
        <FailNote step={h.step} inset={false} initial="" onCancel={() => setFailing(false)} onSubmit={(note) => { setFailing(false); decide("fail", note); }} />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {h.paused ? <SmallButton title={HELD_COPY.resume} label={HELD_COPY.resumeHelp} disabled={busy} onPress={() => act(() => value.resume(h.runId))} /> : null}
          {QA_VERDICTS.map((v) => (
            <SmallButton key={v.verdict} title={v.label} disabled={busy} onPress={() => (v.verdict === "fail" ? setFailing(true) : decide(v.verdict))} />
          ))}
          <LiveButton onOpen={onWatchLive} />
          {h.sessionId ? <SmallButton title={HELD_COPY.openCard} ghost onPress={() => onOpenCard(h)} /> : null}
          <SmallButton title={HELD_COPY.stopNow} label={HELD_COPY.stopNowHelp} danger disabled={busy} onPress={() => act(() => api.qaStop(h.runId))} />
        </View>
      )}
      {error ? <T accessibilityRole="alert" style={{ color: t.c.badText }}>{error}</T> : null}
    </Banner>
  );
}
