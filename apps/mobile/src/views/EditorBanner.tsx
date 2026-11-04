/**
 * The editor's state (apps/client-web views/EditorBanner.tsx): stopping,
 * building or starting for a restart or rebuild, step by step with a timer;
 * busy with a ue-mcp call, with a timer and a Stop for the turns waiting on
 * it; or not running, with a Start. On a phone the top bar shows it as a chip,
 * a dot and a word or two, whose press opens the full banner under the bar.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, useWindowDimensions, View } from "react-native";
import type { BusyCall, BusyState, EditorOperation, EditorOperationFailure } from "@ue-mcp-studio/shared";
import { Banner, Button, font, Spinner, T, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import type { DaemonState } from "../state";

/** A call shorter than this is the editor working normally, not busy. */
export const BUSY_AFTER_MS = 1000;

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export const callLabel = (c: Pick<BusyCall, "category" | "action">): string => `${c.category}(${c.action})`;

const OPERATION: Record<EditorOperation["op"], string> = {
  rebuild: "Rebuilding the project",
  restart: "Restarting the editor",
  start: "Starting the editor",
  stop: "Stopping the editor",
};
const STEP: Record<string, string> = {
  "editor.stop_editor": "closing the editor",
  "project.build": "building the C++",
  "editor.start_editor": "starting the editor",
  "editor.restart_editor": "restarting the editor",
  connect: "waiting for the editor to connect",
};

export function operationLine(o: Pick<EditorOperation, "op" | "step">): { title: string; step: string } {
  const steps = o.op === "rebuild" ? ["editor.stop_editor", "project.build", "editor.start_editor"] : [];
  const n = steps.indexOf(o.step);
  return { title: OPERATION[o.op], step: `${STEP[o.step] ?? o.step}${n >= 0 ? ` (step ${n + 1} of ${steps.length})` : ""}` };
}

const FAILED: Record<EditorOperation["op"], string> = {
  rebuild: "The rebuild did not bring the editor back",
  restart: "The restart did not bring the editor back",
  start: "The editor did not start",
  stop: "The editor did not stop",
};

export function failureLine(f: Pick<EditorOperationFailure, "op" | "step">): string {
  return `${FAILED[f.op]} (${STEP[f.step] ?? f.step})`;
}

export function stepFailed(s: { ok: boolean; result?: string }): boolean {
  return !s.ok;
}

function useBusy(daemon: DaemonState): { calls: BusyCall[]; operation: EditorOperation | null; failure: EditorOperationFailure | null; now: () => number } {
  const { api } = useProjectNav();
  const [state, setState] = useState<{ calls: BusyCall[]; operation: EditorOperation | null; failure: EditorOperationFailure | null; offset: number }>({ calls: [], operation: null, failure: null, offset: 0 });
  const [, tick] = useState(0);
  const take = (s: BusyState) => setState({ calls: s.calls ?? [], operation: s.operation ?? null, failure: s.failure ?? null, offset: (s.now ?? Date.now()) - Date.now() });

  useEffect(() => {
    if (!daemon.streaming) return;
    api.busy().then(take, () => {});
  }, [daemon.streaming, api]);

  const last = [...daemon.events].reverse().find((e) => e.type === "studio.busy.changed");
  useEffect(() => {
    if (last) take(last.data as unknown as BusyState);
  }, [last?.id]);

  const running = state.calls.length > 0 || !!state.operation;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  return { calls: state.calls, operation: state.operation, failure: state.failure, now: () => Date.now() + state.offset };
}

/** .chip.editor-chip: its dot, warn or pulsing busy. */
function EditorChip({ label, tone, open, onPress }: { label: string; tone: "warn" | "busy"; open: boolean; onPress: () => void }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (tone !== "busy") return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }), Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [tone, pulse]);
  const warn = tone === "warn";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1, borderRadius: t.editor ? 4 : 999, borderColor: warn ? t.c.warnLine.replace(/[\d.]+\)$/, "0.4)") : t.c.lineStrong }}
    >
      <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.warn, opacity: tone === "busy" ? pulse : 1 }} />
      <T numberOfLines={1} style={[t.editor ? font(t, "sans", 400, 11, 1.4) : { ...font(t, "mono", 500, 10.5, 1.4), letterSpacing: 0.63, textTransform: "uppercase" }, { color: warn ? t.c.warnText : t.c.muted }]}>
        {label}
      </T>
    </Pressable>
  );
}

const BANNER_ROW = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 10, marginBottom: 0 };

export function EditorBanner({ daemon, compact = false }: { daemon: DaemonState; compact?: boolean }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const { width } = useWindowDimensions();
  const { calls, operation, failure, now } = useBusy(daemon);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const textStyle = { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText };
  const strong = { color: t.c.warnText };
  const dim = { color: t.c.dim };
  const mono = { ...font(t, "mono", 400, (t.editor ? 12.5 : 13.5) * 0.92), color: t.c.warnText };

  /** The banner, or in compact form a chip that opens it under the bar. */
  const frame = (chip: string, tone: "warn" | "busy", banner: ReactNode) => {
    if (!compact) return banner;
    return (
      <View style={{ flexShrink: 0 }}>
        <EditorChip label={chip} tone={tone} open={open} onPress={() => setOpen(!open)} />
        {open ? (
          <View style={{ position: "absolute", zIndex: 45, top: 46, right: -6, width: width - 12, borderRadius: 8, backgroundColor: t.c.panel, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 12 }, elevation: 10 }}>
            {banner}
          </View>
        ) : null}
      </View>
    );
  };

  if (operation) {
    const line = operationLine(operation);
    return frame(`${OPERATION[operation.op].split(" ")[0]} ${formatElapsed(now() - operation.startedAt)}`, "busy",
      <Banner kind="warn" role="status" style={BANNER_ROW}>
        <Spinner small />
        <T style={textStyle}>
          <T weight={700} style={strong}>{line.title}:</T> {line.step}
          <T style={mono}>{"  "}{formatElapsed(now() - operation.startedAt)}</T>
        </T>
      </Banner>,
    );
  }

  const oldest = calls[0];
  if (oldest && now() - oldest.startedAt >= BUSY_AFTER_MS) {
    const ours = calls.filter((c) => c.source === "studio");
    const stoppable = ours.some((c) => !c.stopped);
    const stopped = ours.length > 0 && !stoppable;
    const more = calls.length - 1;
    const stop = () => {
      setStopping(true);
      api.stopBusy().then(() => setError(null), (e: Error) => setError(e.message)).finally(() => setStopping(false));
    };
    return frame(`${stopped ? "Stopping" : "Editor busy"} ${formatElapsed(now() - oldest.startedAt)}`, "busy",
      <Banner kind="warn" role="status" style={BANNER_ROW}>
        <T style={textStyle}>
          <T weight={700} style={strong}>{stopped ? "Stopped." : "Editor busy:"}</T>{" "}
          {stopped ? `The editor is finishing ${callLabel(oldest)}.` : callLabel(oldest)}
          {more > 0 ? <T style={dim}> and {more} more</T> : null}
          {oldest.source === "client" && oldest.client ? <T style={dim}> from {oldest.client}</T> : null}
          <T style={mono}>{"  "}{formatElapsed(now() - oldest.startedAt)}</T>
        </T>
        {stoppable ? <Button title={stopping ? "Stopping" : "Stop"} disabled={stopping} onPress={stop} /> : null}
        {error ? <T style={dim}>{error}</T> : null}
      </Banner>,
    );
  }

  const editor = daemon.health?.editors[0];
  if (daemon.streaming && daemon.health && !editor?.connected) {
    const start = () => {
      setStarting(true);
      setError(null);
      api.editor("start").then(
        (r) => {
          const failed = ((r.steps as Array<{ ok: boolean; result?: string }> | undefined) ?? []).find(stepFailed);
          if (failed) setError(failed.result ?? "The editor did not start.");
        },
        (e: Error) => setError(e.message),
      ).finally(() => setStarting(false));
    };
    return frame(starting ? "Starting" : "Editor off", "warn",
      <Banner kind="warn" role="status" style={BANNER_ROW}>
        <T style={textStyle}>
          <T weight={700} style={strong}>{failure ? `${failureLine(failure)}.` : "Editor not running"}</T>
          {failure && !error ? <T style={dim}> {failure.reason}</T> : null}
          {error ? <T style={dim}> {error}</T> : null}
        </T>
        <Button title={starting ? "Starting" : "Start"} variant="primary" disabled={starting} onPress={start} />
      </Banner>,
    );
  }
  return null;
}
