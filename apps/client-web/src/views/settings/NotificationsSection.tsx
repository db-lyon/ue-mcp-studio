import { useState } from "react";
import { NOTIFY_KINDS, type DeviceNotifyPrefs, type NotifyKind } from "@ue-mcp-studio/shared";
import { NOTIFY_COPY as C, PRIVACY_CHOICES } from "@ue-mcp-studio/client-core";
import { Head } from "../SettingsHub";
import { Card, Row, Seg, Switch, useMessage } from "./controls";
import { browserPermission, saveProjectNotify, useDevicePrefs, useProjectNotify } from "../../notify";
import { native } from "../../native";
import { onRemotePage } from "../../connection";


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
      <Head title="Notifications" lead={C.lead} />
      {msg.node}
      <Card label="This device">
        <p className="cfg-note">{deliveryNote()}</p>
        {needsPermission && (
          <Row
            title={C.permission.title}
            help={permission === "denied" ? C.permission.denied : permission === "unsupported" ? C.permission.unsupported : C.permission.ask}
          >
            {permission === "default" && <button className="primary" onClick={ask}>{C.permission.button}</button>}
          </Row>
        )}
        <Row title={C.enabled.title} help={C.enabled.help} inline>
          <Switch on={device.enabled} onChange={(v) => set({ enabled: v })} label={C.enabled.title} />
        </Row>
        <div className={device.enabled ? "" : "notify-dim"} aria-disabled={!device.enabled || undefined}>
        <Row title={C.away.title} help={C.away.help} inline>
          <Switch on={device.onlyWhenAway} onChange={(v) => set({ onlyWhenAway: v })} label={C.away.title} disabled={!device.enabled} />
        </Row>
        <Row title={C.privacy.title} help={C.privacy.help}>
          <Seg value={device.privacy} options={PRIVACY_CHOICES} onChange={(v) => set({ privacy: v })} label={C.privacy.title} disabled={!device.enabled} compact />
        </Row>
        <Row title={C.quiet.title} help={C.quiet.help} inline>
          <Switch on={device.quiet.on} onChange={(v) => set({ quiet: { ...device.quiet, on: v } })} label={C.quiet.title} disabled={!device.enabled} />
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
          <Row title={C.mute(projectName).title} help={C.mute(projectName).help} inline>
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
        <p className="cfg-note">{C.events(projectName)}</p>
        {NOTIFY_KINDS.map((k) => (
          <Row key={k.kind} title={k.name} help={k.help} inline>
            <Switch on={project?.prefs.events[k.kind] ?? k.on} onChange={(v) => void toggleEvent(k.kind, v)} label={k.name} disabled={!project} />
          </Row>
        ))}
      </Card>
      <Card label="Muted sessions" className="notify-muted">
        {project && project.prefs.mutedSessions.length > 0 ? (
          project.prefs.mutedSessions.map((id) => (
            <Row key={id} title={project.titles[id] ?? C.deletedSession} inline>
              <button onClick={() => void unmute(id)}>Unmute</button>
            </Row>
          ))
        ) : (
          <p className="cfg-note">{C.noMuted}</p>
        )}
      </Card>
    </>
  );
}
