/**
 * A diagnostic strip for the open session: what the transcript holds, what the
 * list measured and the last error, drawn outside the transcript's own box so
 * it shows even when that box draws nothing.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, useWindowDimensions } from "react-native";
import { Banner, font, useTheme } from "../ui";

export interface Diag {
  entries: number;
  rows: number;
  listH: number;
  contentH: number;
  seen: number;
  offset: number;
  boxH: number;
  composerH: number;
  undrawn: string | null;
  error: string | null;
  /** The first rows' measured heights, newest first. */
  rowH: string;
  /** "list": the FlatList; "plain": the newest rows in a plain View, no scroller. */
  mode: "list" | "plain";
}

const state: Diag = { entries: -1, rows: -1, listH: -1, contentH: -1, seen: 0, offset: 0, boxH: -1, composerH: -1, undrawn: null, error: null, rowH: "", mode: "list" };
const rowHeights = new Map<number, number>();
export function noteRow(i: number, h: number): void {
  if (i > 5) return;
  rowHeights.set(i, h);
  setDiag({ rowH: [...rowHeights.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${Math.round(v)}`).join(" ") });
}
const listeners = new Set<() => void>();
let queued = false;

export function setDiag(patch: Partial<Diag>): void {
  let changed = false;
  for (const k of Object.keys(patch) as Array<keyof Diag>) {
    if (state[k] !== patch[k]) {
      (state as unknown as Record<string, unknown>)[k] = patch[k];
      changed = true;
    }
  }
  if (!changed || queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    for (const l of listeners) l();
  }, 100);
}

export function noteError(e: unknown): void {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  setDiag({ error: text.slice(0, 300) });
}

let hooked = false;
function hookConsole(): void {
  if (hooked) return;
  hooked = true;
  const prev = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      noteError(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    } catch {
      // A value that cannot be shown is left out.
    }
    prev(...args);
  };
}

export function useDiag(): Diag {
  const [, setN] = useState(0);
  useEffect(() => {
    hookConsole();
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

const r = (n: number) => Math.round(n);

export function DiagStrip() {
  const t = useTheme();
  const d = useDiag();
  const win = useWindowDimensions();
  const style = { ...font(t, "mono", 400, 10), lineHeight: 13, color: t.c.muted };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Diagnostics: tap to switch how the thread is drawn" onPress={() => setDiag({ mode: d.mode === "list" ? "plain" : "list" })} testID="diag-strip" style={{ paddingHorizontal: 8, paddingVertical: 3, backgroundColor: t.c.panel2, borderBottomWidth: 1, borderBottomColor: t.c.line }}>
      <Text style={style}>{`entries ${d.entries} rows ${d.rows} list ${r(d.listH)} content ${r(d.contentH)} seen ${d.seen} off ${r(d.offset)}`}</Text>
      <Text style={style}>{`box ${r(d.boxH)} composer ${r(d.composerH)} window ${r(win.height)}x${r(win.width)} mode ${d.mode} (tap)`}</Text>
      <Text style={style}>{`row h ${d.rowH || "-"}`}</Text>
      {d.error ? <Text style={[style, { color: t.c.badText }]} numberOfLines={3}>{`error ${d.error}`}</Text> : null}
      {d.undrawn ? <Banner kind="bad" role="alert" style={{ marginTop: 4 }}>{d.undrawn}</Banner> : null}
    </Pressable>
  );
}
