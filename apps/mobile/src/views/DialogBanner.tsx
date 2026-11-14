/**
 * A dialog holding the editor, above every view, so a stalled turn is never
 * silent (apps/client-web views/DialogBanner.tsx and its DialogBannerLine).
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { dialogBannerLead, statusLine } from "@ue-mcp-studio/client-core";
import { DialogCard } from "../screens/chat/items";
import type { DialogsState, EditorDialog } from "@ue-mcp-studio/shared";
import { Banner, T, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import type { DaemonState } from "../state";
import { SHELL_BANNER } from "./VersionNotice";

/** The daemon's open dialogs, with the clock offset to its own; ticks while one is open. */
export function useDialogs(daemon: DaemonState): { state: DialogsState | null; now: () => number } {
  const { api } = useProjectNav();
  const [state, setState] = useState<{ s: DialogsState | null; offset: number }>({ s: null, offset: 0 });
  const [, tick] = useState(0);
  const take = (s: DialogsState) => setState({ s, offset: s.now - Date.now() });

  useEffect(() => {
    if (!daemon.streaming) return;
    api.dialogs().then(take, () => {});
  }, [daemon.streaming, api]);

  const last = [...daemon.events].reverse().find((e) => e.type === "studio.dialog.changed");
  useEffect(() => {
    if (last) take(last.data as unknown as DialogsState);
  }, [last?.id]);

  const open = (state.s?.dialogs.length ?? 0) > 0;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [open]);

  return { state: state.s, now: () => Date.now() + state.offset };
}

export function DialogBannerLine({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const t = useTheme();
  return (
    <Banner kind="warn" role="status" style={SHELL_BANNER}>
      <T style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText }}>
        <T weight={700} style={{ color: t.c.warnText }}>{dialogBannerLead(d)}</T> {d.title || "(untitled dialog)"}
        <T style={{ color: t.c.dim }}> {statusLine(d, now)}</T>
      </T>
    </Banner>
  );
}

export function DialogBanner({ daemon }: { daemon: DaemonState }) {
  const { state, now } = useDialogs(daemon);
  // A native Windows dialog (a GPU device loss, an assert box) is its whole card here, with its
  // buttons: it may belong to no session, and it holds the editor whatever is open.
  const native = (state?.dialogs ?? []).filter((d) => d.native);
  if (native.length > 0) {
    return (
      <View accessibilityLabel="Windows dialog in the editor" testID="native-dialogs" style={{ gap: 8, paddingHorizontal: 16, paddingTop: 8 }}>
        {native.map((d) => <DialogCard key={d.id} dialog={d} now={now()} />)}
      </View>
    );
  }
  const first = state?.dialogs[0];
  return first ? <DialogBannerLine dialog={first} now={now()} /> : null;
}
