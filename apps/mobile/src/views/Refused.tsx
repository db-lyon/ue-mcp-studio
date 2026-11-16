/**
 * Studio on a ue-mcp older than it needs (apps/client-web views/Refused.tsx):
 * one screen. The daemon names the refusal in /v1/health when it checks the
 * floor itself; an older daemon loads Studio, which then answers only its
 * refusal route. Updating runs from Studio on the computer, so a phone only
 * says so.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AskComputer } from "./AskComputer";
import { REFUSAL_BACK, REFUSAL_CHECK_AGAIN, REFUSAL_OPEN_ANYWAY, REFUSAL_PENDING, REFUSAL_SLOW, REFUSAL_WAIT_MS, REMOTE_UPDATES, refusalStill } from "@ue-mcp-studio/client-core";
import { refusalInHealth, type RefusedExtension, type StudioRefusal } from "@ue-mcp-studio/shared";
import { Button, edgePadding, font, Spinner, T, useInsets, useStyles, useTheme, type Theme } from "../ui";
import { useProjectNav } from "../nav";

/**
 * Studio's refusal, null when Studio runs, undefined until the agent has
 * answered. Raising `attempt` (Check again) asks again; the last answer
 * stands until the new one arrives.
 */
export function useRefusal(health: { version: string; refusedExtensions?: RefusedExtension[] } | null, attempt = 0): StudioRefusal | null | undefined {
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
  }, [api, attempt]);
  return refusalInHealth(health) ?? own;
}

/**
 * While the check has not answered: a spinner, and once it has taken longer
 * than it should, Check again, Open Studio anyway and Back to projects.
 */
export function RefusalPending({ onCheck, onOpen, onBack }: { onCheck: () => void; onOpen: () => void; onBack?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useInsets();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), REFUSAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={s.app}>
      <View style={[s.main, edgePadding(insets, 6)]}>
        <View style={s.empty}>
          <View accessibilityRole="text" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Spinner />
            <T style={[s.lead, { color: t.c.muted }]}>{slow ? REFUSAL_SLOW : REFUSAL_PENDING}</T>
          </View>
          {slow ? (
            <View style={s.actions}>
              <Button title={REFUSAL_CHECK_AGAIN} onPress={onCheck} />
              <Button title={REFUSAL_OPEN_ANYWAY} variant="ghost" onPress={onOpen} />
              {onBack ? <Button title={REFUSAL_BACK} variant="ghost" onPress={onBack} /> : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * `remote`: a paired client, which says the update runs on the computer instead
 * of offering it. A phone always is. `onCheck` asks the computer again;
 * `onBack` goes to the projects.
 */
export function RefusedScreen({ refusal, onCheck, onBack }: { refusal: StudioRefusal; remote?: boolean; onCheck?: () => void; onBack?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useInsets();
  const [checked, setChecked] = useState(false);
  return (
    <View style={s.app}>
      <View style={[s.main, edgePadding(insets, 6)]}>
        <View style={s.empty}>
          <T style={s.head} accessibilityRole="header">
            Studio needs ue-mcp {refusal.needs} or later. You have {refusal.have}.
          </T>
          <T style={s.lead}>{REMOTE_UPDATES}</T>
          <AskComputer what="update" />
          {onCheck || onBack ? (
            <View style={s.actions}>
              {onCheck ? <Button title={REFUSAL_CHECK_AGAIN} onPress={() => (setChecked(true), onCheck())} /> : null}
              {onBack ? <Button title={REFUSAL_BACK} variant="ghost" onPress={onBack} /> : null}
            </View>
          ) : null}
          {checked ? <T style={[s.lead, { color: t.c.dim, fontSize: 12 }]}>{refusalStill(refusal.needs)}</T> : null}
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
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, justifyContent: "center" as const, gap: 8 },
});
