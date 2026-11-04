/**
 * About: this app's version and build, the Studio and ue-mcp the last opened
 * project's computer runs, whether they fit together, and where the app talks.
 */
import { useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import * as Application from "expo-application";
import { studioApi } from "@ue-mcp-studio/client-core";
import { APP_VERSION, MIN_STUDIO, studioTooOld, versionsOf, type Versions } from "../native/compat";
import { RELAY, selected, transportFor, type Device } from "../relay";
import { Banner, Button, Card, Label, T, font, useInsets, useTheme } from "../ui";

function Line({ name, value }: { name: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 16, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.c.line }}>
      <T style={{ ...font(t, "mono", 500, 11, 1.6), color: t.c.dim, textTransform: "uppercase", letterSpacing: 0.88, width: 120 }}>{name}</T>
      <T style={{ flex: 1 }} selectable>
        {value}
      </T>
    </View>
  );
}

export function About({ onBack }: { onBack: () => void }) {
  const insets = useInsets();
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
        const h = await studioApi(transportFor(d)).health();
        if (!live) return;
        setVersions(versionsOf(h));
        setReach("ok");
      } catch {
        if (live) setReach("unreachable");
      }
    })();
    return () => void (live = false);
  }, []);

  const tooOld = studioTooOld(versions?.studio ?? null);
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 18, paddingLeft: 12 + insets.left, paddingRight: 12 + insets.right, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Button title={"‹ Devices"} variant="ghost" onPress={onBack} />
      </View>
      <Card>
        <Label>About</Label>
        <View style={{ marginTop: 10 }}>
          <Line name="App" value={`UE-MCP Studio ${APP_VERSION}`} />
          <Line name="Build" value={`${Application.nativeApplicationVersion ?? APP_VERSION} (${Application.nativeBuildVersion ?? "?"})`} />
          <Line name="Package" value={Application.applicationId ?? "com.uemcp.studio.remote"} />
          <Line name="System" value={`${Platform.OS === "ios" ? "iOS" : "Android"} ${String(Platform.Version)}`} />
          <Line name="Needs Studio" value={`${MIN_STUDIO} or newer`} />
          <Line name="Relay" value={RELAY} />
        </View>
      </Card>
      <Card>
        <Label>{device ? device.name : "Project"}</Label>
        <View style={{ marginTop: 10 }}>
          {reach === "none" ? <T tone="muted">Open a project to see what its computer runs.</T> : null}
          {reach === "checking" ? <T tone="muted">Asking the computer</T> : null}
          {reach === "unreachable" ? <T tone="muted">The computer did not answer. It may be offline or locked.</T> : null}
          {versions ? (
            <>
              <Line name="Studio" value={versions.studio ?? "unknown"} />
              <Line name="ue-mcp" value={versions.ueMcp ?? "unknown"} />
            </>
          ) : null}
        </View>
        {tooOld ? (
          <Banner kind="warn" style={{ marginTop: 12, marginBottom: 0 }}>
            {tooOld}
          </Banner>
        ) : versions ? (
          <Banner kind="ok" style={{ marginTop: 12, marginBottom: 0 }}>
            This app and the Studio on that computer work together.
          </Banner>
        ) : null}
      </Card>
      <T tone="dim" size={12}>
        UE-MCP Studio is open source under the MIT licence. Requests to your computer are sealed end to end; the relay carries only what it cannot read.
      </T>
    </ScrollView>
  );
}
