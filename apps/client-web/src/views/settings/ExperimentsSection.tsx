import { useEffect, useState } from "react";
import type { StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Head } from "../SettingsHub";
import { Card, Row, Switch, useMessage } from "./controls";
import { announceExperiments } from "../hub/state";

/** Experiments: unfinished features, each off until switched on. */
export function ExperimentsSection() {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
  }, []);
  // The tabs follow at once: the app hears the change rather than waiting for a reload.
  const setHub = (playtestHub: boolean) => {
    api.saveSettings({ experiments: { playtestHub } }).then((s) => {
      setSettings(s);
      announceExperiments(s.experiments ?? { playtestHub });
    }, msg.fail);
  };
  return (
    <>
      <Head title="Experiments" lead="Features still in progress, each off until you switch it on." />
      {msg.node}
      <Card>
        <Row title="Playtest Hub" help="Adds a Playtests tab for tracks, the clips that prove them and their runs. Studio keeps tracks on this computer, not in the project.">
          <Switch on={settings?.experiments?.playtestHub === true} onChange={setHub} label="Playtest Hub" disabled={!settings} />
        </Row>
      </Card>
    </>
  );
}
