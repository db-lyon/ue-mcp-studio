/**
 * About: this app's version and build, the Studio and ue-mcp the last opened
 * project's computer runs, whether they fit together, and where the app talks.
 */
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import * as Application from "expo-application";
import { studioApi, type Transport } from "@ue-mcp-studio/client-core";
import { APP_VERSION, MIN_STUDIO, studioTooOld, versionsOf, type Versions } from "../native/compat";
import { RELAY, selected, transportFor, type Device } from "../relay";
import { Banner, Card, font, labelFont, Loading, T, useTheme } from "../ui";
import { Page, SectionLabel } from "./StudioPage";

/** One fact: its name in the label face, its value beside it; a hairline under every one but the last. */
function Line({ name, value, last, mono }: { name: string; value: string; last?: boolean; mono?: boolean }) {
  const t = useTheme();
  return (
    <View accessibilityRole="text" accessibilityLabel={`${name}: ${value}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 16, paddingVertical: 9, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.c.line }}>
      <T style={{ ...labelFont(t, t.c.dim), width: 104 }}>{name}</T>
      <T style={[{ flex: 1, color: t.c.text }, mono ? font(t, "mono", 500, 12.5, 1.55) : null]} selectable>
        {value}
      </T>
    </View>
  );
}

export function About({ onBack, transport }: { onBack: () => void; transport?: (d: Device) => Transport }) {
  const t = useTheme();
  const [device, setDevice] = useState<Device | null>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [reach, setReach] = useState<"checking" | "ok" | "unreachable" | "none">("checking");

  useEffect(() => {
    let live = true;
    void (async () => {
      const d = await selected().catch(() => null);
      if (!live) return;
      setDevice(d);
      if (!d) return setReach("none");
      try {
        const h = await studioApi((transport ?? transportFor)(d)).health();
        if (!live) return;
        setVersions(versionsOf(h));
        setReach("ok");
      } catch {
        if (live) setReach("unreachable");
      }
    })();
    return () => void (live = false);
  }, [transport]);

  const tooOld = studioTooOld(versions?.studio ?? null);
  return (
    <Page title="About" back="Paired devices" onBack={onBack}>
      <SectionLabel>This app</SectionLabel>
      <Card style={{ paddingVertical: 4, paddingHorizontal: 14 }}>
        <Line name="App" value="UE-MCP Studio" />
        <Line name="Version" mono value={`${Application.nativeApplicationVersion ?? APP_VERSION} (build ${Application.nativeBuildVersion ?? "?"})`} />
        <Line name="Package" mono value={Application.applicationId ?? "com.uemcp.studio.remote"} />
        <Line name="System" value={`${Platform.OS === "ios" ? "iOS" : "Android"} ${String(Platform.Version)}`} />
        <Line name="Needs Studio" value={`${MIN_STUDIO} or newer`} />
        <Line name="Relay" mono value={RELAY} last />
      </Card>
      <SectionLabel>{device ? `The computer running ${device.name}` : "Project"}</SectionLabel>
      <Card style={{ paddingVertical: versions ? 4 : 14, paddingHorizontal: 14, gap: 10 }}>
        {reach === "none" ? <T style={{ color: t.c.dim }}>Open a project to see what its computer runs.</T> : null}
        {reach === "checking" ? <Loading>Asking the computer</Loading> : null}
        {reach === "unreachable" ? (
          <Banner kind="warn" style={{ marginBottom: 0 }}>
            The computer did not answer. It may be offline, asleep or locked; open the project to wake it, then come back.
          </Banner>
        ) : null}
        {versions ? (
          <View>
            <Line name="Studio" mono value={versions.studio ?? "unknown"} />
            <Line name="ue-mcp" mono value={versions.ueMcp ?? "unknown"} last />
          </View>
        ) : null}
        {tooOld ? (
          <Banner kind="warn" style={{ marginBottom: 10 }}>
            {tooOld}
          </Banner>
        ) : versions ? (
          <Banner kind="ok" style={{ marginBottom: 10 }}>
            This app and the Studio on that computer work together.
          </Banner>
        ) : null}
      </Card>
      <T style={{ ...font(t, "sans", 400, 12, t.base.lineHeight / t.base.size), color: t.c.dim }}>
        UE-MCP Studio is open source under the MIT license. Requests to your computer are sealed end to end; the relay carries only what it cannot read.
      </T>
    </Page>
  );
}
