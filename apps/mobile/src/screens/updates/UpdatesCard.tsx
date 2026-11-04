/**
 * The Updates card as a paired browser shows it (client-web views/Updates.tsx
 * with `remote`): what is installed and what is newer, with no Update button
 * and the channel read only, since updates run on the computer.
 */
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { REMOTE_UPDATES, fabUpdate, failureLine, readUpdatesWith, readyLine, updateRows, updateSteps, waitingSteps, type Updates } from "@ue-mcp-studio/client-core";
import { Banner, Button, Card, Pill, Spacer, bannerText, labelFont, T, useTheme } from "../../ui";
import { Details } from "../settings/Details";
import { Radio, Txt } from "../settings/controls";
import { useProjectEvents, useSettingsApi } from "../settings/hooks";
import { useUpdateRun } from "./run";

export function UpdatesCard() {
  const api = useSettingsApi();
  const t = useTheme();
  const [u, setU] = useState<Updates | null>(null);
  const run = useUpdateRun();
  const working = !!run && run.summary === undefined && !run.error;
  const waits = !!run && waitingSteps(run).length > 0;
  const [stopped, setStopped] = useState<string | null>(null);
  useEffect(() => {
    if (run?.error) setStopped(run.error);
    else if (working) setStopped(null);
  }, [run?.error, working]);
  const load = useCallback(() => void readUpdatesWith((p) => api.maybe(p)).then(setU, () => setU({ studio: null, ueMcp: null })), [api]);
  useEffect(load, [load]);
  // Read again once a run the computer is doing finishes or stops.
  useEffect(() => {
    if (run && !working) load();
  }, [working]);
  useProjectEvents(() => undefined);

  const steps = u ? updateSteps(u) : [];
  const ready = u ? readyLine(u) : "";
  const fab = fabUpdate(u?.studio);
  const engineOnly = u?.studio?.plugin.location === "engine" && u.studio?.plugin.source !== "fab" && !!u.studio?.plugin.latest;
  const failure = failureLine(u?.studio);

  return (
    <Card testID="updates">
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
        <T accessibilityRole="header" style={labelFont(t)}>
          Updates
        </T>
        <Spacer />
        {!working && steps.length === 0 ? <Button title="Check again" onPress={load} /> : null}
      </View>
      {!u ? <Txt tone="muted" style={{ marginVertical: t.base.size }}>Checking</Txt> : null}
      {u ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
          <Pill kind={steps.length ? "warn" : "ok"} style={{ alignSelf: "center" }}>
            {steps.length ? "Update available" : "Up to date"}
          </Pill>
          <Txt tone="muted">{waits ? "Update ready. Restarts after the current turn." : working ? "Updating" : steps.length ? ready : "Up to date."}</Txt>
        </View>
      ) : null}
      <Txt size={12} tone="dim" style={{ marginVertical: 12 }}>
        {REMOTE_UPDATES}
      </Txt>
      {stopped && !working ? (
        <Banner kind="bad" role="alert">
          <Txt size={12} style={{ color: bannerText(t, "bad") }}>
            The last update stopped: {stopped}
          </Txt>
        </Banner>
      ) : null}
      {!stopped && !working && failure ? (
        <Banner kind="bad" role="alert">
          <Txt size={12} style={{ color: bannerText(t, "bad") }}>
            {failure}
          </Txt>
        </Banner>
      ) : null}
      {u?.studio ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Release channel" style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 14, marginTop: 8, marginBottom: 6 }}>
          <Txt size={12} tone="dim">
            Channel
          </Txt>
          {(["stable", "beta"] as const).map((c) => (
            <View key={c} accessibilityRole="radio" accessibilityLabel={c === "stable" ? "Stable" : "Beta"} accessibilityState={{ checked: (u.studio?.channel ?? "stable") === c, disabled: true }} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, marginRight: 14 }}>
              <Radio on={(u.studio?.channel ?? "stable") === c} disabled />
              <Txt size={12} tone="muted">
                {c === "stable" ? "Stable" : "Beta"}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {u?.studio?.plugin.required ? (
        <Banner kind="warn">
          <Txt size={12} style={{ color: bannerText(t, "warn") }}>
            {u.studio.plugin.source === "fab" ? "Editor plugin too old. Update it from your Fab Library." : u.studio.plugin.location === "project" ? "Editor plugin too old. Update installs it and restarts the editor." : "Editor plugin too old. Update it where it was installed."}
          </Txt>
        </Banner>
      ) : null}
      {fab ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
          <Txt size={12} tone="muted" style={{ flexShrink: 1 }}>
            {fab.version ? `Editor plugin ${fab.version} is available. ` : ""}Update the editor plugin from your Fab Library.
          </Txt>
          <Spacer />
          <Button title="Open Fab Library" onPress={() => void Linking.openURL(fab.url)} />
        </View>
      ) : null}
      {engineOnly ? (
        <Txt size={12} tone="dim" style={{ marginVertical: 12 }}>
          Installed with the engine. The Epic launcher updates it.
        </Txt>
      ) : null}
      {u ? (
        <Details summary={<Txt size={12} tone="dim">Details</Txt>} style={{ marginTop: 8 }}>
          {updateRows(u).map(([name, installed, latest, available]) => (
            <Txt key={name} size={12} tone="dim">
              {name}: {installed ?? "not installed"}
              {available && latest ? ` → ${latest}` : ""}
            </Txt>
          ))}
        </Details>
      ) : null}
    </Card>
  );
}
