// STUB: owned by composer
/** The model chip in the composer bar and the catalog behind it, as far as the chat needs them before the composer's port lands. */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { EFFORT_NAMES, type ModelCatalog, type StudioSettings } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { Button, T, useTheme } from "../ui";

export function useCatalog(settings: StudioSettings | null): ModelCatalog | null {
  const { api } = useProjectNav();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    if (settings) api.models().then(setCatalog, () => setCatalog(null));
  }, [settings?.connected, settings?.provider, settings?.model, api]);
  return catalog;
}

const modelName = (catalog: ModelCatalog | null, s: StudioSettings): string =>
  catalog?.providers.find((p) => p.id === s.provider)?.models.find((m) => m.id === s.model)?.name ?? s.model;

export function ModelPicker({ settings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; up?: boolean; merged?: boolean }) {
  const catalog = useCatalog(settings);
  return <Button title={modelName(catalog, settings)} label="Model" />;
}

export function ModelAndEffort({ settings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const t = useTheme();
  const catalog = useCatalog(settings);
  return (
    <Button label="Model and effort">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T size={12} weight={500} lh={1}>{`${modelName(catalog, settings)} · ${EFFORT_NAMES[settings.effort] ?? settings.effort}`}</T>
        <T size={10} style={{ color: t.c.dim }}>{"▾"}</T>
      </View>
    </Button>
  );
}

export function ConnectModel(_props: { catalog: ModelCatalog; vendor: string; model: string; onConnected: () => void }) {
  return null;
}
