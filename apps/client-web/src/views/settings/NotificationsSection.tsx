import { useState } from "react";
import { NOTIFY_KINDS, type DeviceNotifyPrefs, type NotifyKind, type NotifyPrivacy } from "@ue-mcp-studio/shared";
import { Head } from "../SettingsHub";
import { Card, Row, Seg, Switch, useMessage } from "./controls";
import { browserPermission, saveProjectNotify, useDevicePrefs, useProjectNotify } from "../../notify";
import { native } from "../../native";
import { onRemotePage } from "../../connection";

const PRIVACY: ReadonlyArray<{ id: NotifyPrivacy; name: string }> = [
  { id: "full", name: "Full text" },
  { id: "minimal", name: "Event and project" },
];

/** How this device shows notifications, said plainly. */
function deliveryNote(): string {
  if (native().notify && window.ue?.studioWindow) return "Studio's window shows Windows notifications. Clicking one opens its session.";
  if (window.ue?.studio) return "The editor tab flashes the editor's taskbar button. Studio's own window shows Windows notifications.";
  if (onRemotePage()) return "This browser shows notifications while a Studio tab is open. Allow them here to get them while it is closed too.";
  return "This browser shows notifications while a Studio tab is open.";
}

/** Settings > Notifications: this device's own choices, then the project's events, shared by every device. */
export function NotificationsSection() {
  const [device, setDevice] = useDevicePrefs();
  const project = useProjectNotify();
  const msg = useMessage();
  const [permission, setPermission] = useState(browserPermission);
  const set = (u: Partial<DeviceNotifyPrefs>) => setDevice({ ...device, ...u });
  const projectName = project?.project ?? "";
  const muted = !!projectName && device.mutedProjects.includes(projectName);
  const needsPermission = !native().notify && !window.ue?.studio && permission !== "granted";
  const ask = () => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then(setPermission, () => setPermission(browserPermission()));
  };
  const toggleEvent = (kind: NotifyKind, on: boolean) => saveProjectNotify({ events: { [kind]: on } }).catch(msg.fail);
  const unmute = (id: string) => saveProjectNotify({ unmute: [id] }).catch(msg.fail);

  return (
    <>
      <Head title="Notifications" lead="When Studio tells you something happened, and what it shows." />
      {msg.node}
      <Card label="This device">
        <p className="cfg-note">{deliveryNote()}</p>
        {needsPermission && (
          <Row
            title="Browser permission"
            help={permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings." : permission === "unsupported" ? "This browser cannot show notifications." : "The browser asks once before it shows any."}
          >
            {permission === "default" && <button className="primary" onClick={ask}>Allow notifications</button>}
          </Row>
        )}
        <Row title="Notifications on this device" help="Off: this device shows none, whatever the events below say." inline>
          <Switch on={device.enabled} onChange={(v) => set({ enabled: v })} label="Notifications on this device" />
        </Row>
        <div className={device.enabled ? "" : "notify-dim"} aria-disabled={!device.enabled || undefined}>
        <Row title="Only when I'm away" help="Not while you are using this device. Phones and other browsers also stay quiet while you use Studio on the computer." inline>
          <Switch on={device.onlyWhenAway} onChange={(v) => set({ onlyWhenAway: v })} label="Only when I'm away" disabled={!device.enabled} />
        </Row>
        <Row title="What a notification shows" help="Event and project keeps your messages and file names off the lock screen.">
          <Seg value={device.privacy} options={PRIVACY} onChange={(v) => set({ privacy: v })} label="What a notification shows" disabled={!device.enabled} compact />
        </Row>
        <Row title="Quiet hours" help="No notifications between these times, on this device's clock." inline>
          <Switch on={device.quiet.on} onChange={(v) => set({ quiet: { ...device.quiet, on: v } })} label="Quiet hours" disabled={!device.enabled} />
        </Row>
        {device.quiet.on && (
          <div className="notify-quiet">
            <label>
              <span className="muted small">From</span>
              <input type="time" value={device.quiet.from} aria-label="Quiet hours from" disabled={!device.enabled} onChange={(e) => e.target.value && set({ quiet: { ...device.quiet, from: e.target.value } })} />
            </label>
            <label>
              <span className="muted small">To</span>
              <input type="time" value={device.quiet.to} aria-label="Quiet hours to" disabled={!device.enabled} onChange={(e) => e.target.value && set({ quiet: { ...device.quiet, to: e.target.value } })} />
            </label>
          </div>
        )}
        {projectName && (
          <Row title={`Mute ${projectName} here`} help="This project's notifications stay off on this device. Other devices keep theirs." inline>
            <Switch
              on={muted}
              onChange={(v) => set({ mutedProjects: v ? [...device.mutedProjects, projectName] : device.mutedProjects.filter((p) => p !== projectName) })}
              label={`Mute ${projectName} on this device`}
              disabled={!device.enabled}
            />
          </Row>
        )}
        </div>
      </Card>
      <Card label="Events">
        <p className="cfg-note">Shared by every device paired with {projectName || "this project"}.</p>
        {NOTIFY_KINDS.map((k) => (
          <Row key={k.kind} title={k.name} help={k.help} inline>
            <Switch on={project?.prefs.events[k.kind] ?? k.on} onChange={(v) => void toggleEvent(k.kind, v)} label={k.name} disabled={!project} />
          </Row>
        ))}
      </Card>
      <Card label="Muted sessions" className="notify-muted">
        {project && project.prefs.mutedSessions.length > 0 ? (
          project.prefs.mutedSessions.map((id) => (
            <Row key={id} title={project.titles[id] ?? "A session that was deleted"} inline>
              <button onClick={() => void unmute(id)}>Unmute</button>
            </Row>
          ))
        ) : (
          <p className="cfg-note">None. Mute a session from its menu in the session list.</p>
        )}
      </Card>
    </>
  );
}
