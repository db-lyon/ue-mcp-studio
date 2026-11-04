/**
 * One area's screens on their own, against a web visual QA scenario's daemon:
 * Settings, Plugins, Feedback and the update notices, drawn inside a project
 * as the shell will draw them, below a stand-in for its top bar.
 * scripts/parity-mobile.mjs --page area shoots this page, so these screens are
 * compared with the web client before the shell routes to them.
 */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { studioApi } from "@ue-mcp-studio/client-core";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS, scenarioTransport } from "./harness";
import { PARITY } from "./parity";
import { AREA_SCENES } from "./area-scenes";
import { useProject } from "../src/connection";
import { ProjectContext, type ProjectNav } from "../src/nav";
import { THEMES, ThemeProvider, useStudioFonts } from "../src/ui";

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "settings-list";
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;
const scenario = SCENARIOS[name] ?? SCENARIOS["settings-list"];
document.documentElement.dataset.theme = theme;

function InProject({ children }: { children: React.ReactNode }) {
  const transport = useMemo(() => scenarioTransport(scenario, theme), []);
  const project = useProject({ id: "visual-qa", name: "StudioE2E", online: true, computerKey: "k", lastSeen: new Date().toISOString() }, transport);
  const nav = useMemo<ProjectNav>(() => ({ project, api: studioApi(project.transport), push: () => undefined, pop: () => undefined }), [project]);
  return <ProjectContext.Provider value={nav}>{children}</ProjectContext.Provider>;
}

function Area() {
  const [current, setCurrent] = useState<StudioTheme>(theme);
  const fonts = useStudioFonts();
  const t = THEMES[current];
  const scene = AREA_SCENES[name];
  return (
    <ThemeProvider name={current} onChange={setCurrent}>
      <View style={{ flex: 1 }}>
        <View style={{ height: 50, backgroundColor: t.c.barBg, borderBottomWidth: 1, borderBottomColor: t.c.line }} />
        <View style={{ flex: 1, minHeight: 0 }}>{fonts && scene ? <InProject>{scene()}</InProject> : null}</View>
      </View>
    </ThemeProvider>
  );
}

(window as unknown as { __mobileQa: unknown }).__mobileQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, { title: s.title, height: s.height ?? 860 }])),
  parity: PARITY,
};
createRoot(document.getElementById("root")!).render(<Area />);
