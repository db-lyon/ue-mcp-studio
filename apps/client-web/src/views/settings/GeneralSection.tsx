import { useEffect, useState } from "react";
import type { StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { UpdatesCard } from "../Updates";
import { Head } from "../SettingsHub";
import { Card, useMessage } from "./controls";

export const THEMES: { id: StudioTheme; name: string; about: string }[] = [
  { id: "ue-mcp", name: "ue-mcp", about: "Dark, ue-mcp orange." },
  { id: "editor-orange", name: "Editor orange", about: "Unreal colors and type, ue-mcp orange." },
  { id: "editor", name: "Editor", about: "Unreal colors and type." },
];

/** General: how Studio looks, and its updates. */
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
  return (
    <>
      <Head title="General" lead="Theme, and updates for Studio and the editor plugin." />
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
    </>
  );
}
