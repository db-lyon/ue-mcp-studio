/**
 * The playtest cards of a session scenario on their own, laid out as the
 * transcript lays them (12 points in from each edge, 8 above and below), for
 * scripts/parity-cards-mobile.mjs to compare card by card with the web
 * client's while the chat screen that draws them in a session is ported.
 */
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { studioApi } from "@ue-mcp-studio/client-core";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS, scenarioTransport } from "./harness";
import { useProject } from "../src/connection";
import { ProjectContext, useProjectNav, type ProjectNav } from "../src/nav";
import { QaContext, useDaemonEvents } from "../src/screens/playtests/live";
import { QaCard } from "../src/screens/playtests/QaCard";
import { AssetLinksContext, useAssetLinks } from "../src/screens/playtests/StepText";
import { THEMES, ThemeProvider, useStudioFonts } from "../src/ui";

const device = { id: "visual-qa", name: "StudioE2E", online: true, computerKey: "k", lastSeen: new Date().toISOString() };

function Session({ name, theme }: { name: string; theme: StudioTheme }) {
  const scenario = SCENARIOS[name] ?? SCENARIOS["session-empty"];
  const transport = useMemo(() => scenarioTransport(scenario, theme), [scenario, theme]);
  const project = useProject(device, transport);
  const nav = useMemo<ProjectNav>(() => ({ project, api: studioApi(project.transport), push: () => undefined, pop: () => undefined }), [project]);
  return (
    <ProjectContext.Provider value={nav}>
      <Cards sessionId={scenario.session?.id ?? null} name={name} />
    </ProjectContext.Provider>
  );
}

function Cards({ sessionId, name }: { sessionId: string | null; name: string }) {
  const { project } = useProjectNav();
  const { events, streaming } = useDaemonEvents(project);
  const assetLinks = useAssetLinks(sessionId);
  // In a session a subagent's thread opens from its card, so the card offers it.
  const live = useMemo(() => ({ events, streaming, forms: [], sessionId, onThread: () => undefined }), [events, streaming, sessionId]);
  const runs = (SCENARIOS[name]?.session?.transcript ?? []).flatMap((e) => (e.kind === "qa" && !e.run.deleted ? [e.run] : []));
  return (
    <QaContext.Provider value={live}>
      <AssetLinksContext.Provider value={assetLinks}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          {runs.map((r) => (
            <View key={r.runId} style={{ marginVertical: 8 }}>
              <QaCard run={r} />
            </View>
          ))}
        </ScrollView>
      </AssetLinksContext.Provider>
    </QaContext.Provider>
  );
}

export function CardsHarness({ name, theme }: { name: string; theme: StudioTheme }) {
  const fonts = useStudioFonts();
  return (
    <ThemeProvider name={theme}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>{fonts ? <Session name={name} theme={theme} /> : null}</SafeAreaProvider>
    </ThemeProvider>
  );
}
