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
import { Banner, bannerText, Button, Card, font, labelFont, Loading, Panel, T, useTheme } from "../ui";
import { Page, SectionLabel } from "./StudioPage";

/** One fact: its name in the label face, its value in mono beside it (versions read alike); a hairline under every one but the last. */
function Line({ name, value, last, warn }: { name: string; value: string; last?: boolean; warn?: boolean }) {
  const t = useTheme();
  return (
    <View accessibilityRole="text" accessibilityLabel={`${name}: ${value}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 16, paddingVertical: 9, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.c.line }}>
      <T style={{ ...labelFont(t, t.c.dim), width: 104 }}>{name}</T>
      <T style={{ ...font(t, "mono", 500, 12.5, 1.55), flex: 1, color: warn ? t.c.warn : t.c.text }} selectable>
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
  const [attempt, setTry] = useState(0);
  const small = font(t, "sans", 400, 12, t.base.lineHeight / t.base.size);

  useEffect(() => {
    let live = true;
    setReach("checking");
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
  }, [transport, attempt]);

  const tooOld = studioTooOld(versions?.studio ?? null);
  return (
    <Page title="About" back="Paired devices" onBack={onBack}>
      <SectionLabel>This app</SectionLabel>
      <Card style={{ paddingVertical: 4, paddingHorizontal: 14 }}>
        <Line name="App" value="UE-MCP Studio" />
        <Line name="Version" value={`${Application.nativeApplicationVersion ?? APP_VERSION} (build ${Application.nativeBuildVersion ?? "?"})`} />
        <Line name="Package" value={Application.applicationId ?? "com.uemcp.studio.remote"} />
        <Line name="System" value={`${Platform.OS === "ios" ? "iOS" : "Android"} ${String(Platform.Version)}`} />
        <Line name="Needs Studio" value={`${MIN_STUDIO} or newer`} />
        <Line name="Relay" value={RELAY.replace(/^https:\/\//, "")} last />
      </Card>
      <SectionLabel>{device ? `${device.name}'s computer` : "Your computer"}</SectionLabel>
      {versions ? (
        <Card style={{ paddingVertical: 4, paddingHorizontal: 14 }}>
          <Line name="Studio" value={versions.studio ?? "unknown"} warn={!!tooOld} />
          <Line name="ue-mcp" value={versions.ueMcp ?? "unknown"} last />
        </Card>
      ) : null}
      {reach === "none" || reach === "checking" ? (
        <Card style={{ padding: 14 }}>{reach === "none" ? <T style={{ ...small, color: t.c.dim }}>Open a project to see what its computer runs.</T> : <Loading>Asking the computer</Loading>}</Card>
      ) : null}
      {reach === "unreachable" ? (
        <Panel bad head="The computer did not answer" text="It may be offline, asleep or locked." actions={<View style={{ flex: 1 }}><Button title="Try again" variant="primary" size="large" onPress={() => setTry((n) => n + 1)} /></View>} />
      ) : null}
      {tooOld ? (
        <Banner kind="warn" style={{ marginBottom: 0 }}>
          <T style={{ ...small, color: bannerText(t, "warn") }}>{tooOld}</T>
        </Banner>
      ) : versions ? (
        <Banner kind="ok" style={{ marginBottom: 0 }}>
          <T style={{ ...small, color: bannerText(t, "ok") }}>This app and the Studio on that computer work together.</T>
        </Banner>
      ) : null}
      <T style={{ ...font(t, "sans", 400, 12, t.base.lineHeight / t.base.size), color: t.c.dim }}>
        UE-MCP Studio is open source under the MIT license. Requests to your computer are sealed end to end; the relay carries only what it cannot read.
      </T>
    </Page>
  );
}
