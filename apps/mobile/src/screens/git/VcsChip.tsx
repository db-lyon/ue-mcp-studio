/**
 * The project's source control, as the narrow web client shows it at the
 * foot of its navigation drawer: the kind and the branch with its changes,
 * warn-coloured while files are changed. Read when shown, every half minute,
 * and whenever a session changes, since a turn may have changed files. A
 * press opens the changes sheet.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { VcsStatus } from "@ue-mcp-studio/shared";
import { vcsLine } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../nav";
import { css, fonts } from "../../ui/css";
import { ChangesSheet } from "./ChangesSheet";

export const VCS_POLL_MS = 30_000;

export function VcsChip({ onOpen }: { onOpen?: () => void }) {
  const { api, project } = useProjectNav();
  const [vcs, setVcs] = useState<VcsStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api.vcs().then((r) => setVcs(r.vcs), () => setVcs(null)), [api]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), VCS_POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => project.onEvent((e) => void (e.type === "studio.session.changed" && load())), [project, load]);
  if (!vcs) return null;
  const dirty = (vcs.changes ?? 0) > 0;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${vcs.name} ${vcsLine(vcs)}. Show the changes.`}
        testID="vcs-chip"
        onPress={() => {
          onOpen?.();
          setOpen(true);
        }}
        style={s.chip}
      >
        <View style={s.dot} />
        <Text style={[s.text, s.kind]}>{vcs.name}</Text>
        <Text style={[s.text, s.line, dirty && { color: css.warn }]}>{vcsLine(vcs)}</Text>
      </Pressable>
      {open ? (
        <ChangesSheet
          vcs={vcs}
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingVertical: 8, paddingHorizontal: 10, marginTop: 4, borderRadius: 10 },
  dot: { width: 3.65625, height: 6, borderRadius: 3, backgroundColor: css.dim },
  kind: { flexShrink: 0 },
  line: { flex: 1, minWidth: 0 },
  text: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 16.8, fontWeight: "500", color: css.muted, textTransform: "uppercase" },
});

/**
 * The changes sheet opened from a control of its own (a header link): reads
 * the source control when asked, then shows the sheet. `error` says why it
 * could not open.
 */
export function useChangesSheet(): { open: () => void; sheet: ReactNode; error: string | null } {
  const { api } = useProjectNav();
  const [vcs, setVcs] = useState<VcsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(() => {
    setError(null);
    api.vcs().then(
      (r) => (r.vcs ? setVcs(r.vcs) : setError("This project has no source control Studio can read.")),
      (e: Error) => setError(e.message),
    );
  }, [api]);
  return { open, error, sheet: vcs ? <ChangesSheet vcs={vcs} onClose={() => setVcs(null)} /> : null };
}
