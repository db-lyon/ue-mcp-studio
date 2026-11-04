/**
 * The whole-panel states (apps/client-web views/UpdateOverlay.tsx): an update
 * Studio on the computer is running, followed through its studio.update.run
 * and studio.update.progress events, and the connection to ue-mcp. A phone
 * never starts or resumes an update itself; installing runs on the computer.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { STEP_NAME, STEP_NOTE, waitingSteps, waitingWho, type UpdateRun } from "@ue-mcp-studio/client-core";
import { Banner, Button, font, Row, Spacer, Spinner, T, useStyles, useTheme, type Theme } from "../ui";
import { useProjectNav } from "../nav";
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

export function UpdateRunner({ streaming, events }: { streaming: boolean; events: DaemonEvent[] }) {
  const run = useRun();
  const [slow, setSlow] = useState(false);

  const last = events[events.length - 1];
  useEffect(() => {
    if (current && last?.type === "studio.update.progress" && typeof last.data.message === "string") setRun({ ...current, detail: last.data.message });
    if (last?.type === "studio.update.run") setRun((last.data.run as UpdateRun | null) ?? null);
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

  if (run && waitingSteps(run).length > 0) return <><UpdateWaiting run={run} />{overlay}</>;
  if (run && !escalated) return <UpdateScreen run={run} slow={slow} onClose={() => setRun(null)} />;
  return overlay;
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
  const steps = waitingSteps(run);
  return (
    <Banner kind="warn" role="status" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 0, marginHorizontal: 6, marginBottom: 6 }}>
      <T style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText }}>
        <T weight={700} lh={t.editor ? 1.5 : 1.55} style={{ color: t.c.warnText }}>Update ready.</T> {waitingWho(steps)} once no turn is in progress.
        {sure ? <T style={{ color: t.c.dim }}> Restarting now stops every turn in progress.</T> : null}
      </T>
      {sure ? <Button title="Cancel" variant="ghost" onPress={() => setSure(false)} /> : null}
      <Button title={sure ? "Restart and stop turns" : "Restart now"} variant={sure ? "primary" : "default"} onPress={() => (sure ? void restartNow(run, api) : setSure(true))} />
    </Banner>
  );
}

export function UpdateScreen({ run, slow, onClose }: { run: UpdateRun; slow: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const finished = run.summary !== undefined;
  const failed = !!run.error;
  const title = failed ? "Update stopped" : finished ? "Updated" : "Updating";
  return (
    <View style={s.overlay} accessibilityViewIsModal accessibilityLabel={title}>
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
