/**
 * Experiments, as a paired browser shows it: the same switches, saved on the
 * computer. The Playtest Hub's tab is drawn only by Studio on the computer
 * for now (apps/mobile/visual-qa/parity.ts, HUB), so its help says so.
 */
import { useEffect, useState } from "react";
import type { StudioSettings } from "@ue-mcp-studio/shared";
import { Card } from "../../ui";
import { Head, SettingRow, Switch, useMessage } from "./controls";
import { useSettingsApi } from "./hooks";
import { Message } from "./GeneralSection";

export function ExperimentsSection() {
  const api = useSettingsApi();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
  }, [api]);
  const setHub = (playtestHub: boolean) => {
    api.saveSettings({ experiments: { playtestHub } }).then(setSettings, msg.fail);
  };
  return (
    <>
      <Head title="Experiments" lead="Features still in progress, each off until you switch it on." />
      <Message msg={msg} />
      <Card>
        <SettingRow first inline title="Playtest Hub" help="Adds a Playtests tab to Studio on the computer for goals, the playtests that prove them and their runs. The phone does not show it yet.">
          <Switch on={settings?.experiments?.playtestHub === true} onChange={setHub} label="Playtest Hub" disabled={!settings} />
        </SettingRow>
      </Card>
    </>
  );
}
