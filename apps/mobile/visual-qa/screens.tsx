/**
 * The app's own screens outside a project, one per ?screen=<name>, for the
 * safe-area pass (scripts/parity-mobile.mjs --screens): pairing, the projects
 * and devices pages, the scanner, the fingerprint offer and a sheet. The web
 * client has no counterpart, so these are shot without a reference.
 */
import type { ReactElement } from "react";
import { View } from "react-native";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RELAY } from "../src/relay";
import { store } from "../ui-test/mocks/secure-store";
import { Welcome, Pairing } from "../src/screens/Pairing";
import { Projects } from "../src/screens/Projects";
import { Settings } from "../src/screens/Settings";
import { About } from "../src/screens/About";
import { Scanner } from "../src/screens/Scanner";
import { RememberOffer } from "../src/views/remote/RemoteLock";
import { Button, Sheet, T, THEMES, ThemeProvider, useStudioFonts } from "../src/ui";

const none = () => undefined;

export const APP_SCREENS: Record<string, () => ReactElement> = {
  welcome: () => <Welcome onScan={none} onLink={none} />,
  "pairing-code": () => <Pairing step={{ kind: "code", code: "482913" }} />,
  "pairing-status": () => <Pairing step={{ kind: "status", text: "Waiting for your computer" }} />,
  projects: () => <Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} />,
  devices: () => <Settings onBack={none} onRemoved={none} onAbout={none} />,
  about: () => <About onBack={none} />,
  scanner: () => <Scanner onCode={none} onCancel={none} />,
  "fingerprint-offer": () => (
    <View style={{ flex: 1 }}>
      <RememberOffer onYes={none} onNo={none} />
    </View>
  ),
  sheet: () => (
    <Sheet open title="Checkpoints" onClose={none}>
      <View style={{ gap: 10, padding: 4 }}>
        {Array.from({ length: 14 }, (_, i) => (
          <T key={i}>Checkpoint {i + 1}: the door opens on overlap.</T>
        ))}
        <Button title="Restore the last checkpoint" variant="primary" onPress={none} />
      </View>
    </Sheet>
  ),
};

// The relay answers the projects and devices pages from fixtures; the phone trusts the first computer.
const lastSeen = "2026-11-04T12:00:00Z";
store.set("trusted", JSON.stringify({ k1: { pairedAt: lastSeen } }));
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${RELAY}/api/devices`)
    return new Response(
      JSON.stringify({
        devices: [
          { id: "d1", name: "Lyra", online: true, computerKey: "k1", lastSeen },
          { id: "d2", name: "StudioE2E", online: false, computerKey: "k2", lastSeen },
        ],
        viewers: [
          { id: "v1", label: "Pixel 9", createdAt: lastSeen, current: true },
          { id: "v2", label: "Chrome on Windows", createdAt: lastSeen, current: false },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return realFetch(input, init);
};

export function AppScreenHarness({ name, theme }: { name: string; theme: StudioTheme }) {
  const fonts = useStudioFonts();
  const Screen = APP_SCREENS[name] ?? APP_SCREENS.welcome;
  return (
    <ThemeProvider name={theme}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
        <View style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>{fonts ? <Screen /> : null}</View>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
