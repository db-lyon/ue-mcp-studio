/**
 * General, as a paired browser shows it: the theme (which switches this app
 * at once and is saved on the computer), the Updates card read only, and the
 * ue-mcp account without its sign-in or sign-out, which run on the computer.
 */
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { HttpError, REMOTE_CHANGE_NOTE, THEME_CHOICES } from "@ue-mcp-studio/client-core";
import type { StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import { Banner, Button, Card, Dot, bannerText, useTheme } from "../../ui";
import { CardLabel, Head, Span, Txt, useMessage } from "./controls";
import { useProjectEvents, useSettingsApi } from "./hooks";
import { UpdatesCard } from "../updates/UpdatesCard";

const SWATCH: Record<StudioTheme, [string, string, string]> = {
  "ue-mcp": ["#0c0c0b", "#1a1a18", "#e8720c"],
  "editor-orange": ["#151515", "#242424", "#e8720c"],
  editor: ["#151515", "#242424", "#0070e0"],
};

export function GeneralSection({ onTheme }: { onTheme: (t: StudioTheme) => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
  }, [api]);
  // A theme applies as soon as it is picked; the computer keeps it for every client.
  const pick = (theme: StudioTheme) => {
    onTheme(theme);
    api.saveSettings({ theme }).then(setSettings, msg.fail);
  };
  return (
    <>
      <Head title="General" lead="Your ue-mcp account, theme, and updates for Studio and the editor plugin." />
      <Message msg={msg} />
      <Card>
        <CardLabel>Appearance</CardLabel>
        <View style={{ gap: 10 }}>
          {THEME_CHOICES.map((c) => {
            const on = settings?.theme === c.id;
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                accessibilityLabel={c.name}
                accessibilityState={{ selected: on }}
                onPress={() => pick(c.id)}
                style={{ alignItems: "flex-start", gap: 4, padding: 12, minHeight: 44, borderWidth: 1, borderRadius: t.radius, borderColor: on ? t.c.accent : t.c.line, backgroundColor: on ? t.c.accentWash : t.c.panel2 }}
              >
                <View style={{ flexDirection: "row", alignSelf: "stretch", height: 34, borderRadius: t.radius, overflow: "hidden", marginBottom: 6, borderWidth: 1, borderColor: t.c.line }}>
                  <View style={{ flex: 3, backgroundColor: SWATCH[c.id][0] }} />
                  <View style={{ flex: 2, backgroundColor: SWATCH[c.id][1] }} />
                  <View style={{ flex: 1, backgroundColor: SWATCH[c.id][2] }} />
                </View>
                {/* The editor themes set every button's type to 12px/1.2, over the option's own base font. */}
                <Txt weight={600} size={t.editor ? 12 : undefined} style={t.editor ? { lineHeight: 14.4 } : undefined}>
                  {c.name}
                </Txt>
                <Txt size={12} tone="muted" style={t.editor ? { lineHeight: 14.4 } : undefined}>
                  {c.about}
                </Txt>
              </Pressable>
            );
          })}
        </View>
      </Card>
      <UpdatesCard />
      <AccountCard />
    </>
  );
}

/** useMessage's banner: green when saved, red with what went wrong; a tap clears it. */
export function Message({ msg }: { msg: ReturnType<typeof useMessage> }) {
  const t = useTheme();
  if (!msg.message) return null;
  const kind = msg.message.ok ? "ok" : "bad";
  return (
    <Pressable accessibilityRole={msg.message.ok ? undefined : "alert"} onPress={msg.clear}>
      <Banner kind={kind}>
        <Txt style={{ color: bannerText(t, kind) }}>{msg.message.text}</Txt>
      </Banner>
    </Pressable>
  );
}

/**
 * The ue-mcp account on the computer: who is signed in. Signing in or out
 * runs on the computer, so a paired client shows the note in their place;
 * a paid account keeps Manage plan, its customer portal.
 */
export function AccountCard() {
  const api = useSettingsApi();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [paid, setPaid] = useState(false);
  const msg = useMessage();
  const load = () => void api.settings().then(setSettings, msg.fail);
  useEffect(() => {
    load();
    // A paid plan is what remote control checks for; a paired client is refused that route, which reads as paid.
    api.remoteAvailable(false).then((a) => setPaid(a.available === true), (e) => setPaid(e instanceof HttpError && e.status === 403));
  }, [api]);
  useProjectEvents((e) => {
    if (e.type === "studio.settings.changed") load();
  });
  const account = settings?.account ?? null;
  return (
    <Card>
      <CardLabel>Account</CardLabel>
      <Message msg={msg} />
      {/* .account-row at phone width: the dot and the account fill the first line (.grow's calc(100% - 24px)), and
          Manage plan and the login note wrap to the next, 14 px under it. Laid out as two explicit lines, since
          Yoga shrinks a percentage basis to share one line instead of wrapping as a browser does. */}
      <View style={{ gap: 14, paddingVertical: 11 }}>
      <View testID="account-line" style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <Dot kind={account ? "ok" : undefined} style={{ marginTop: 6 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt weight={500}>
            <Span weight={700}>ue-mcp account</Span> <Span size={12} tone="muted">{!settings ? "Loading" : account ? `Signed in as @${account.login}` : "Not signed in"}</Span>
          </Txt>
          {settings && !account ? (
            <Txt size={12} tone="dim" style={{ marginBottom: 8 }}>
              {REMOTE_CHANGE_NOTE}
            </Txt>
          ) : null}
        </View>
      </View>
      {account && (paid || account.via !== "studio") ? (
        <View testID="account-actions" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
          {paid ? <ManagePlan /> : null}
          {account.via !== "studio" ? (
            <Txt size={12} tone="dim" numberOfLines={1}>
              from ue-mcp login
            </Txt>
          ) : null}
        </View>
      ) : null}
      </View>
    </Card>
  );
}

/** Manage plan: the payment provider's customer portal, in the phone's browser. */
function ManagePlan() {
  const api = useSettingsApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTheme();
  const manage = () => {
    setBusy(true);
    setError(null);
    api.billingPortal().then((l) => void Linking.openURL(l.url), (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <Button title={busy ? "Opening" : "Manage plan"} disabled={busy} onPress={manage} />
      {error ? (
        <Banner kind="bad">
          <Txt size={12} style={{ color: bannerText(t, "bad") }}>
            {error}
          </Txt>
        </Banner>
      ) : null}
    </>
  );
}

