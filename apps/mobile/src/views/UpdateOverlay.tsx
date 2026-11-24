/**
 * The whole-panel states (apps/client-web views/UpdateOverlay.tsx): an update
 * Studio on the computer is running, followed through its studio.update.run
 * and studio.update.progress events, and the connection to ue-mcp. A phone
 * never starts or resumes an update itself; installing runs on the computer.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { PENDING_COPY, holdCopy, STUDIO_REQUESTER, UPDATE_RETRY_ON_COMPUTER, STEP_NAME, STEP_NOTE, holdOf, waitingSteps, waitingWho, type UpdateHold, type UpdateRun } from "@ue-mcp-studio/client-core";
import { Banner, Button, edgePadding, font, Row, Spacer, Spinner, T, useInsets, useStyles, useTheme, type Theme } from "../ui";
import { useProjectNav } from "../nav";
import { EditorConsent } from "../screens/editor/EditorConsent";
import type { DaemonEvent } from "../state";
import { ConnectionOverlay, useConnection } from "./ConnectionOverlay";

let current: UpdateRun | null = null;
const listeners = new Set<() => void>();
const setRun = (run: UpdateRun | null): void => {
  current = run;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The update running now, if any. */
export const useRun = (): UpdateRun | null => useSyncExternalStore(subscribe, () => current);

/** For tests: forget the run. */
export const resetRunForTests = (): void => setRun(null);

/** How long a restart may take before the panel says what to do if it never reloads. */
const SLOW_MS = 90_000;

export function UpdateRunner({ streaming, events, onReload }: { streaming: boolean; events: DaemonEvent[]; onReload?: () => void }) {
  const run = useRun();
  const [slow, setSlow] = useState(false);
  // Hide keeps the update running; a new run, or a stop that needs a decision, shows the screen again.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!run || run.error) setHidden(false);
  }, [run === null, !!run?.error]);

  // An Update the editor consent gate holds: the computer keeps it, and the phone can answer it.
  const { api } = useProjectNav();
  const [hold, setHold] = useState<UpdateHold | null>(null);
  useEffect(() => {
    if (streaming) void api.updateHold().then(setHold, () => undefined);
  }, [streaming, api]);

  const last = events[events.length - 1];
  useEffect(() => {
    if (current && last?.type === "studio.update.progress" && typeof last.data.message === "string") setRun({ ...current, detail: last.data.message });
    if (last?.type === "studio.update.run") setRun((last.data.run as UpdateRun | null) ?? null);
    if (last?.type === "studio.update.consent") setHold(holdOf(last.data));
  }, [last?.id]);

  const connection = useConnection(streaming, events, !!run);
  const escalated = ["lost", "starting", "needsYou"].includes(connection.conn.phase);
  const overlay = <ConnectionOverlay c={connection} />;

  const waitingOnRestart = !!run?.steps.some((s) => s.state === "active" && (s.key === "studio" || s.key === "restart"));
  useEffect(() => {
    setSlow(false);
    if (!waitingOnRestart) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [waitingOnRestart]);

  useEffect(() => {
    if (run?.summary === undefined) return;
    const t = setTimeout(() => setRun(null), 5000);
    return () => clearTimeout(t);
  }, [run?.summary]);

  if (hold) return <><UpdateHeld hold={hold} />{overlay}</>;
  if (run && waitingSteps(run).length > 0) return <><UpdateWaiting run={run} />{overlay}</>;
  if (run && !escalated && hidden && !run.error && run.summary === undefined) return <><UpdateHidden run={run} onShow={() => setHidden(false)} onReload={onReload} />{overlay}</>;
  if (run && !escalated) return <UpdateScreen run={run} slow={slow} onClose={() => setRun(null)} onHide={() => setHidden(true)} onReload={onReload} />;
  return overlay;
}

/** The update still runs; this is all that is left of its screen while it is hidden. */
export function UpdateHidden({ run, onShow, onReload }: { run: UpdateRun; onShow: () => void; onReload?: () => void }) {
  const t = useTheme();
  const insets = useInsets();
  const active = run.steps.find((s) => s.state === "active");
  return (
    <Banner kind="warn" role="status" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 0, marginLeft: 6 + insets.left, marginRight: 6 + insets.right, marginBottom: 6 + insets.bottom }}>
      <T style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText }}>
        <T weight={700} lh={t.editor ? 1.5 : 1.55} style={{ color: t.c.warnText }}>Updating.</T> {active ? `${STEP_NAME[active.key]}${run.detail ? `: ${run.detail}` : ""}` : "Still running."} It keeps going in the background.
      </T>
      {onReload ? <Button title="Reload now" variant="ghost" onPress={onReload} /> : null}
      <Button title="Show" variant="primary" onPress={onShow} />
    </Banner>
  );
}

/**
 * An Update the computer is holding for the other sessions using the editor:
 * who and why, with Update anyway (the request approved, behind the PIN) and
 * Cancel (denied). The computer goes on from the answer.
 */
export function UpdateHeld({ hold }: { hold: UpdateHold }) {
  const { api } = useProjectNav();
  const t = useTheme();
  const insets = useInsets();
  const [error, setError] = useState<string | null>(null);
  const answer = (act: (id: string, by: string) => Promise<unknown>) => () => {
    setError(null);
    void act(hold.request.id, STUDIO_REQUESTER).catch((e: Error) => setError(e.message || PENDING_COPY.notSent));
  };
  const copy = holdCopy(hold);
  // Studio's own subagents: stopping them is Studio's answer to the request, not the override.
  const stop = (id: string) => api.stopHeldSubagents(id);
  return (
    <View testID="update-held" style={{ marginLeft: 6 + insets.left, marginRight: 6 + insets.right, marginBottom: 6 + insets.bottom }}>
      <EditorConsent ask={{ op: "update", request: hold.request }} copy={copy} onApprove={answer(copy.stopsSubagents ? stop : api.approveDisruption)} onCancel={answer(api.denyDisruption)} />
      {error ? (
        <Banner kind="bad" role="alert">
          <T size={12} style={{ color: t.c.badText }}>{error}</T>
        </Banner>
      ) : null}
    </View>
  );
}

/** Restart now: the agent ends the turns in progress and runs the waiting steps. */
async function restartNow(run: UpdateRun, api: ReturnType<typeof useProjectNav>["api"]): Promise<void> {
  const first = waitingSteps(run)[0];
  const next = { ...run, steps: run.steps.map((s) => (s.key === first ? { ...s, state: "active" as const } : s)) };
  setRun(next);
  await api.saveUpdateRun(next).catch(() => undefined);
  const r = await api.updatesDeferredNow().then((j) => ({ ok: j.ok !== false, error: j.error }), (e: Error) => ({ ok: false, error: e.message }));
  if (!r.ok) {
    setRun({ ...next, steps: next.steps.map((s) => (s.key === first ? { ...s, state: "failed" as const } : s)), error: r.error ?? "The update did not start." });
    await api.saveUpdateRun(null).catch(() => undefined);
  }
}

/** An update kept until the turn in progress finishes, with a way to install it now. */
export function UpdateWaiting({ run }: { run: UpdateRun }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [sure, setSure] = useState(false);
  const insets = useInsets();
  const steps = waitingSteps(run);
  // At the foot of the shell: above the navigation bar.
  return (
    <Banner kind="warn" role="status" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 0, marginLeft: 6 + insets.left, marginRight: 6 + insets.right, marginBottom: 6 + insets.bottom }}>
      <T style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText }}>
        <T weight={700} lh={t.editor ? 1.5 : 1.55} style={{ color: t.c.warnText }}>Update ready.</T> {waitingWho(steps)} once no turn is in progress.
        {sure ? <T style={{ color: t.c.dim }}> Restarting now stops every turn in progress.</T> : null}
      </T>
      {sure ? <Button title="Cancel" variant="ghost" onPress={() => setSure(false)} /> : null}
      <Button title={sure ? "Restart and stop turns" : "Restart now"} variant={sure ? "primary" : "default"} onPress={() => (sure ? void restartNow(run, api) : setSure(true))} />
    </Banner>
  );
}

export function UpdateScreen({ run, slow, onClose, onHide, onReload }: { run: UpdateRun; slow: boolean; onClose: () => void; onHide?: () => void; onReload?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useInsets();
  const finished = run.summary !== undefined;
  const failed = !!run.error;
  const title = failed ? "Update stopped" : finished ? "Updated" : "Updating";
  return (
    <View style={[s.overlay, edgePadding(insets, 8)]} accessibilityViewIsModal accessibilityLabel={title}>
      <View style={s.card}>
        <View style={s.head}>
          {!finished && !failed ? <Spinner /> : null}
          <T style={s.headText}>{title}</T>
        </View>
        <View style={s.steps}>
          {run.steps.map((step) => {
            const on = step.state === "active" || step.state === "done";
            const color = step.state === "failed" ? t.c.bad : on ? t.c.text : t.c.dim;
            return (
              <View key={step.key} style={s.step}>
                <View style={s.markCell}>
                  {step.state === "active" ? (
                    <Spinner small />
                  ) : (
                    <T style={[s.mark, { color: step.state === "done" ? t.c.ok : color }]}>{step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "○"}</T>
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={{ color }}>
                    {STEP_NAME[step.key]}
                    {step.key === "ueMcp" && run.target ? ` ${run.target}` : ""}
                  </T>
                  {step.state === "active" ? <T style={s.note}>{run.detail ?? STEP_NOTE[step.key] ?? ""}</T> : null}
                </View>
              </View>
            );
          })}
        </View>
        {slow && !failed ? <T style={[s.small, { color: t.c.dim }]}>Taking longer than it should. If Studio does not reload, close Studio and open it again.</T> : null}
        {failed ? (
          // .banner { margin-bottom: 10px } stays in the card's flex column, on top of its 12 px gap.
          <Banner kind="bad" style={{ marginBottom: 10 }}>
            <T style={[s.smallFlat, { color: t.c.badText }]}>{run.error}</T>
          </Banner>
        ) : null}
        {finished && run.summary ? <T style={[s.small, { color: t.c.muted }]}>{run.summary}</T> : null}
        {/* The way on from a phone: the update runs again from Studio on the computer. */}
        {failed ? <T style={[s.smallFlat, { color: t.c.dim }]}>{UPDATE_RETRY_ON_COMPUTER}</T> : null}
        {!finished && !failed && (onHide || onReload) ? (
          <Row style={{ marginVertical: 6 }}>
            <Spacer />
            {onReload ? <Button title="Reload now" variant="ghost" onPress={onReload} /> : null}
            {onHide ? <Button title="Hide" variant="default" onPress={onHide} /> : null}
          </Row>
        ) : null}
        {finished || failed ? (
          <Row style={{ marginVertical: 6 }}>
            <Spacer />
            <Button title={failed ? "Close" : "Done"} variant={failed ? "default" : "primary"} onPress={onClose} />
          </Row>
        ) : null}
      </View>
    </View>
  );
}

const styles = (t: Theme) => ({
  overlay: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 60, alignItems: "center" as const, justifyContent: "center" as const, padding: 8, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  card: {
    width: "100%" as const,
    maxWidth: 460,
    gap: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: t.c.line,
    borderRadius: 10,
    backgroundColor: t.c.panel,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 18 },
    elevation: 12,
  },
  head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  headText: { ...font(t, "sans", 600, 15, 1.2), color: t.c.text },
  steps: { gap: 8 },
  step: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10 },
  markCell: { width: 16, height: t.base.lineHeight, alignItems: "center" as const, justifyContent: "center" as const },
  mark: { fontSize: 12, textAlign: "center" as const },
  note: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim },
  small: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), marginVertical: 12 },
  smallFlat: font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55),
});
