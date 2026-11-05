/**
 * Notifications on the phone (client-web views/settings/NotificationsSection.tsx):
 * this phone's own choices, kept on the phone, with its sound and vibration;
 * the project's events, shared by every device; and the sessions muted.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { NOTIFY_KINDS, type DeviceNotifyPrefs, type NotifyKind } from "@ue-mcp-studio/shared";
import { NOTIFY_COPY as C, PRIVACY_CHOICES, SOUND_CHOICES, VIBRATE_CHOICES, testResultText } from "@ue-mcp-studio/client-core";
import { Button, Card, Input, useTheme } from "../../ui";
import { CardLabel, Head, Seg, SettingRow, Switch, Txt, useMessage } from "./controls";
import { Message } from "./GeneralSection";
import { useSettingsApi } from "./hooks";
import { saveProjectNotify, useDevicePrefs, useProjectNotify } from "../../notifications/state";
import { askPermission, permission as readPermission, type NotifyPermission } from "../../native/notify";
import { sendTestNotification } from "../../notifications/useNotifications";
import { useProjectNav } from "../../nav";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A time typed as HH:MM, kept when it is one. */
function TimeField({ value, onSave, label, disabled }: { value: string; onSave: (v: string) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const ok = HHMM.test(text);
  return (
    <View style={{ gap: 4 }}>
      <Txt size={12} tone="muted">{label}</Txt>
      <Input
        accessibilityLabel={`Quiet hours ${label.toLowerCase()}`}
        value={text}
        editable={!disabled}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        placeholder="22:00"
        onChangeText={setText}
        onBlur={() => (ok ? text !== value && onSave(text) : setText(value))}
        onSubmitEditing={() => ok && onSave(text)}
        style={{ width: 96 }}
      />
    </View>
  );
}

export function NotificationsSection() {
  const api = useSettingsApi();
  const t = useTheme();
  const { project: open } = useProjectNav();
  const [device, setDevice] = useDevicePrefs();
  const project = useProjectNotify(api);
  const msg = useMessage();
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    void readPermission().then(setPerm);
  }, []);
  const set = (u: Partial<DeviceNotifyPrefs>) => setDevice({ ...device, ...u });
  const projectName = project?.project ?? "";
  // The phone mutes a project by its relay id, so two computers' projects of one name stay apart.
  const key = open.device.id;
  const muted = !!key && device.mutedProjects.includes(key);
  const off = !device.enabled;
  const toggleEvent = (kind: NotifyKind, on: boolean) => void saveProjectNotify(api, { events: { [kind]: on } }).catch(msg.fail);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const test = () => {
    setTesting(true);
    setTested(null);
    void sendTestNotification(api, open.device)
      .then((d) => setTested(testResultText(d)), (e: unknown) => setTested({ ok: false, text: `Could not send: ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => setTesting(false));
  };

  return (
    <>
      <Head title="Notifications" lead={C.lead} />
      <Message msg={msg} />
      <Card>
        <CardLabel>This device</CardLabel>
        {perm && perm !== "granted" ? (
          <SettingRow first title={C.permission.title} help={perm === "denied" ? C.permission.denied : C.permission.ask}>
            {perm === "undetermined" ? <Button variant="primary" title={C.permission.button} onPress={() => void askPermission().then(setPerm)} style={{ alignSelf: "flex-start" }} /> : null}
          </SettingRow>
        ) : null}
        <SettingRow first={!perm || perm === "granted"} title={C.enabled.title} help={C.enabled.help} inline>
          <Switch on={device.enabled} onChange={(v) => set({ enabled: v })} label={C.enabled.title} />
        </SettingRow>
        <View style={{ opacity: off ? 0.45 : 1 }} accessibilityState={{ disabled: off }}>
          <SettingRow title={C.away.title} help={C.away.help} inline>
            <Switch on={device.onlyWhenAway} onChange={(v) => set({ onlyWhenAway: v })} label={C.away.title} disabled={off} />
          </SettingRow>
          <SettingRow title={C.privacy.title} help={C.privacy.help}>
            <Seg value={device.privacy} options={PRIVACY_CHOICES} onChange={(v) => set({ privacy: v })} label={C.privacy.title} disabled={off} />
          </SettingRow>
          <SettingRow title={C.sound.title} help={C.sound.help}>
            <Seg value={device.sound} options={SOUND_CHOICES} onChange={(v) => set({ sound: v })} label={C.sound.title} disabled={off} />
          </SettingRow>
          <SettingRow title={C.vibrate.title} help={C.vibrate.help}>
            <Seg value={device.vibrate} options={VIBRATE_CHOICES} onChange={(v) => set({ vibrate: v })} label={C.vibrate.title} disabled={off} />
          </SettingRow>
          <SettingRow title={C.quiet.title} help={C.quiet.help} inline>
            <Switch on={device.quiet.on} onChange={(v) => set({ quiet: { ...device.quiet, on: v } })} label={C.quiet.title} disabled={off} />
          </SettingRow>
          {device.quiet.on ? (
            <View style={{ flexDirection: "row", gap: 12, paddingBottom: 11 }}>
              <TimeField label="From" value={device.quiet.from} disabled={off} onSave={(v) => set({ quiet: { ...device.quiet, from: v } })} />
              <TimeField label="To" value={device.quiet.to} disabled={off} onSave={(v) => set({ quiet: { ...device.quiet, to: v } })} />
            </View>
          ) : null}
          {projectName ? (
            <SettingRow title={C.mute(projectName).title} help={C.mute(projectName).help} inline>
              <Switch on={muted} onChange={(v) => set({ mutedProjects: v ? [...device.mutedProjects, key] : device.mutedProjects.filter((p) => p !== key) })} label={`Mute ${projectName} on this device`} disabled={off} />
            </SettingRow>
          ) : null}
        </View>
        <SettingRow title={C.test.title} help={C.test.help}>
          <Button title={testing ? C.test.sending : C.test.button} onPress={test} disabled={testing} style={{ alignSelf: "flex-start" }} />
        </SettingRow>
        {tested ? (
          <Txt size={12} tone={tested.ok ? "dim" : "badText"} style={{ paddingBottom: 11 }} testID="notify-test-result">{tested.text}</Txt>
        ) : null}
      </Card>
      <Card>
        <CardLabel>Events</CardLabel>
        <Txt size={12} tone="dim">{C.events(projectName)}</Txt>
        {NOTIFY_KINDS.map((k) => (
          <SettingRow key={k.kind} title={k.name} help={k.help} inline>
            <Switch on={project?.prefs.events[k.kind] ?? k.on} onChange={(v) => toggleEvent(k.kind, v)} label={k.name} disabled={!project} />
          </SettingRow>
        ))}
      </Card>
      <Card>
        <CardLabel>Muted sessions</CardLabel>
        {project && project.prefs.mutedSessions.length > 0 ? (
          project.prefs.mutedSessions.map((id, i) => (
            <SettingRow key={id} first={i === 0} title={project.titles[id] ?? C.deletedSession} inline style={{ alignItems: "center" }}>
              <Button title="Unmute" onPress={() => void saveProjectNotify(api, { unmute: [id] }).catch(msg.fail)} />
            </SettingRow>
          ))
        ) : (
          <Txt size={12} tone="dim" style={{ marginTop: t.base.size * 0.25 }}>{C.noMuted}</Txt>
        )}
      </Card>
    </>
  );
}
