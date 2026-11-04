/**
 * Studio on a ue-mcp older than it needs (apps/client-web views/Refused.tsx):
 * one screen. The daemon names the refusal in /v1/health when it checks the
 * floor itself; an older daemon loads Studio, which then answers only its
 * refusal route. Updating runs from Studio on the computer, so a phone only
 * says so.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { REMOTE_UPDATES } from "@ue-mcp-studio/client-core";
import { refusalInHealth, type RefusedExtension, type StudioRefusal } from "@ue-mcp-studio/shared";
import { font, T, useStyles, type Theme } from "../ui";
import { useProjectNav } from "../nav";

/** Studio's refusal, null when Studio runs, undefined until the agent has answered. */
export function useRefusal(health: { version: string; refusedExtensions?: RefusedExtension[] } | null): StudioRefusal | null | undefined {
  const { api } = useProjectNav();
  const [own, setOwn] = useState<StudioRefusal | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.refusal().then(
      (r) => live && setOwn(r && typeof r.needs === "string" ? r : null),
      () => live && setOwn(null),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return refusalInHealth(health) ?? own;
}

/** `remote`: a paired client, which says the update runs on the computer instead of offering it. A phone always is. */
export function RefusedScreen({ refusal }: { refusal: StudioRefusal; remote?: boolean }) {
  const s = useStyles(styles);
  return (
    <View style={s.app}>
      <View style={s.main}>
        <View style={s.empty}>
          <T style={s.head} accessibilityRole="header">
            Studio needs ue-mcp {refusal.needs}. You have {refusal.have}.
          </T>
          <T style={s.lead}>{REMOTE_UPDATES}</T>
        </View>
      </View>
    </View>
  );
}

const styles = (t: Theme) => ({
  app: { flex: 1, backgroundColor: t.c.bg },
  main: { flex: 1, padding: 6 },
  empty: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, paddingVertical: 28, paddingHorizontal: 14, gap: 18 },
  head: { ...font(t, "sans", 600, 18, 1.35), color: t.c.text, maxWidth: 460, textAlign: "center" as const },
  lead: { ...font(t, "sans", 400, 13.5, t.editor ? 1.5 : 1.55), color: t.c.muted, textAlign: "center" as const },
});
