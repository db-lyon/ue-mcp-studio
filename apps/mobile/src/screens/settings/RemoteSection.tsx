/**
 * Remote control as a paired client sees it: the computer refuses a paired
 * client its routes (remote control is turned on and paired on the computer),
 * so after its first read the section says so. Until that answer comes back
 * it shows the section loading, as the web page does.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { HttpError } from "@ue-mcp-studio/client-core";
import { REMOTE_ON_COMPUTER } from "@ue-mcp-studio/shared";
import { Banner, Button, Card, Dot, bannerText, useTheme } from "../../ui";
import { CardLabel, Head, SettingRow, Switch, Txt } from "./controls";
import { useSettingsApi } from "./hooks";

/** How often the section asks again while it is open, as the web page does. */
const REMOTE_POLL_MS = 3000;

export function RemoteSection() {
  const api = useSettingsApi();
  const t = useTheme();
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.remoteStatus().then(
        () => alive && setError(null),
        (e) => {
          if (!alive) return;
          if (e instanceof HttpError && e.status === 403) setRefused(true);
          else setError(e instanceof Error ? e.message : String(e));
        },
      );
    void load();
    const timer = setInterval(() => void load(), REMOTE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  const head = <Head title="Remote control" lead="Use this project from a phone or another computer. Requests and answers between a paired device and this computer are encrypted end to end, so the relay cannot read them." />;
  if (refused) {
    return (
      <>
        {head}
        <Banner kind="warn" role="status">
          <Txt style={{ color: bannerText(t, "warn") }}>{REMOTE_ON_COMPUTER}</Txt>
        </Banner>
      </>
    );
  }
  return (
    <>
      {head}
      {error ? (
        <Banner kind="bad" role="alert">
          <Txt style={{ color: bannerText(t, "bad") }}>{error}</Txt>
        </Banner>
      ) : null}
      <Card>
        <CardLabel>Connection</CardLabel>
        <SettingRow first title="Remote control" help="While it is on and connected, devices paired with this computer can reach this project, and the daemon does not stop for being idle.">
          <Switch on={false} onChange={() => undefined} label="Remote control" disabled />
        </SettingRow>
        <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start", paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.c.line }}>
          <Dot style={{ marginTop: 6 }} />
          <Txt weight={500}>Loading</Txt>
        </View>
      </Card>
      <Card>
        <CardLabel actions={<Button variant="primary" title="New code" disabled />}>Pair a phone or browser</CardLabel>
        <Txt size={12} tone="muted">
          Scan the code on the device or open the link there, then allow the device when Studio here asks. A code works once, for 10 minutes. The device is paired with every project on this computer. Turn remote control on and wait for it to connect first.
        </Txt>
      </Card>
      <Card>
        <CardLabel>Paired devices</CardLabel>
        <Txt size={12} tone="muted">
          Loading
        </Txt>
      </Card>
    </>
  );
}
