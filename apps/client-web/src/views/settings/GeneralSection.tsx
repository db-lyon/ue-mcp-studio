import { useEffect, useState } from "react";
import type { StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import { THEME_CHOICES } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { UpdatesCard } from "../Updates";
import { Head } from "../SettingsHub";
import { Card, Row, Switch, useMessage } from "./controls";
import { announceExperiments } from "../hub/state";
import { AccountCard } from "./AccountCard";

export const THEMES = THEME_CHOICES;

/** General: the ue-mcp account, how Studio looks, its updates, and experiments to switch on. */
export function GeneralSection({ onTheme }: { onTheme: (t: StudioTheme) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
  }, []);
  // A theme applies as soon as it is picked.
  const pick = (theme: StudioTheme) => {
    onTheme(theme);
    api.saveSettings({ theme }).then(setSettings, msg.fail);
  };
  // The tabs follow at once: the app hears the change rather than waiting for a reload.
  const setHub = (playtestHub: boolean) => {
    api.saveSettings({ experiments: { playtestHub } }).then((s) => {
      setSettings(s);
      announceExperiments(s.experiments ?? { playtestHub });
    }, msg.fail);
  };
  return (
    <>
      <Head title="General" lead="Your ue-mcp account, theme, and updates for Studio and the editor plugin." />
      {msg.node}
      <Card label="Appearance">
        <div className="themes">
          {THEMES.map((t) => (
            <button key={t.id} className={`theme-option ${settings?.theme === t.id ? "selected" : ""}`} aria-pressed={settings?.theme === t.id} onClick={() => pick(t.id)}>
              <span className={`swatch swatch-${t.id}`}><i /><i /><i /></span>
              <strong>{t.name}</strong>
              <span className="muted small">{t.about}</span>
            </button>
          ))}
        </div>
      </Card>
      <UpdatesCard />
      <Card label="Experiments">
        <Row title="Playtest Hub" help="Adds a Playtests tab for goals, the playtests that prove them, run history and the run queue. Goals are saved as files in the project's QA/Goals folder.">
          <Switch on={settings?.experiments?.playtestHub === true} onChange={setHub} label="Playtest Hub" disabled={!settings} />
        </Row>
      </Card>
      <AccountCard />
    </>
  );
}
