import "./src/native/system";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Linking, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { PanelLocation } from "@ue-mcp-studio/client-core";
import { Banner, THEMES, ThemeProvider, useStudioFonts, useTheme, type ThemeName } from "./src/ui";
import { account, isPairLink, pair, select, selected, trusted, forget, type Device, type PairStep } from "./src/relay";
import { applySystemTheme, hideSplash } from "./src/native/system";
import { KeyboardProvider } from "./src/native/keyboard";
import { ShareProvider, useSharedFiles } from "./src/native/share";
import { useShortcutTarget, type ShortcutTarget } from "./src/native/shortcuts";
import { useDeviceOnline } from "./src/native/online";
import { haptic } from "./src/native/haptics";
import { Welcome, Pairing } from "./src/screens/Pairing";
import { Scanner } from "./src/screens/Scanner";
import { Projects } from "./src/screens/Projects";
import { Settings } from "./src/screens/Settings";
import { About } from "./src/screens/About";
import { ProjectScreen } from "./src/screens/Project";

type Screen =
  | { name: "loading" }
  | { name: "welcome"; error?: string }
  | { name: "scan"; from: "welcome" | "projects" }
  | { name: "pairing"; step: PairStep }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "about" }
  | { name: "project"; device: Device; initial?: PanelLocation; n: number };

/**
 * The fonts and the theme around everything; the theme last used is drawn
 * until the project says otherwise. The splash stays up until the fonts are
 * in, so the first frame is already Studio's.
 */
export default function App() {
  const fonts = useStudioFonts();
  const [theme, setTheme] = useState<ThemeName>("ue-mcp");
  useEffect(() => {
    SecureStore.getItemAsync("theme").then((v) => v && v in THEMES && setTheme(v as ThemeName), () => undefined);
  }, []);
  useEffect(() => applySystemTheme(THEMES[theme]), [theme]);
  useEffect(() => {
    if (fonts) hideSplash();
  }, [fonts]);
  const choose = useCallback((name: ThemeName) => {
    setTheme(name);
    void SecureStore.setItemAsync("theme", name).catch(() => undefined);
  }, []);
  return (
    <ShareProvider>
      <ThemeProvider name={theme} onChange={choose}>
        <KeyboardProvider>
          <SafeAreaProvider style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
            <StatusBar style="light" />
            <View style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>{fonts ? <Root /> : null}</View>
          </SafeAreaProvider>
        </KeyboardProvider>
      </ThemeProvider>
    </ShareProvider>
  );
}

function Root() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const pairing = useRef(false);
  const opened = useRef(0);
  const shared = useSharedFiles();

  const openProject = useCallback((device: Device, initial?: PanelLocation) => {
    void select(device).then(() => setScreen({ name: "project", device, initial, n: ++opened.current }));
  }, []);

  const startPairing = useCallback((scanned: string) => {
    if (pairing.current) return;
    pairing.current = true;
    setScreen({ name: "pairing", step: { kind: "status", text: "Reading the code" } });
    pair(scanned, (step) => setScreen({ name: "pairing", step }))
      .then(() => {
        haptic.success();
        setScreen({ name: "projects" });
      })
      .catch((e) => {
        haptic.error();
        setScreen({ name: "welcome", error: String(e?.message ?? e) });
      })
      .finally(() => (pairing.current = false));
  }, []);

  useEffect(() => {
    void (async () => {
      // Opened through the app's own uemcpstudio://pair link (an explicit Open in app): pair first.
      const initial = await Linking.getInitialURL().catch(() => null);
      if (initial && isPairLink(initial)) return startPairing(initial);
      const t = await trusted();
      if (!Object.keys(t).length) return setScreen({ name: "welcome" });
      const last = await selected();
      if (last && last.computerKey in t) openProject(last);
      else setScreen({ name: "projects" });
    })().catch((e) => setScreen({ name: "welcome", error: String(e?.message ?? e) }));
    const sub = Linking.addEventListener("url", ({ url }) => {
      if (isPairLink(url)) startPairing(url);
    });
    return () => sub.remove();
  }, [startPairing, openProject]);

  // A long press on the icon picked a recent session: open its project on it.
  useShortcutTarget(
    useCallback(
      (target: ShortcutTarget) => {
        void (async () => {
          const t = await trusted();
          const device = (await account().catch(() => null))?.devices.find((d) => d.id === target.deviceId);
          if (device && device.computerKey in t) openProject(device, { tab: "Chat", session: target.sessionId, section: null });
        })();
      },
      [openProject],
    ),
  );

  // Something shared into Studio from another app while no project is open: open the last one, whose chat takes it.
  useEffect(() => {
    if (!shared.files.length && !shared.text) return;
    if (screen.name !== "projects" && screen.name !== "settings" && screen.name !== "about") return;
    void selected().then((last) => last && openProject(last, { tab: "Chat", session: null, section: null }));
  }, [shared, screen.name, openProject]);

  const unpaired = useCallback((message: string) => {
    void forget().then(() => setScreen({ name: "welcome", error: message }));
  }, []);

  // System back (and the predictive back gesture): up one level rather than out of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen.name === "project" || screen.name === "settings") return setScreen({ name: "projects" }), true;
      if (screen.name === "about") return setScreen({ name: "settings" }), true;
      if (screen.name === "scan") return setScreen(screen.from === "welcome" ? { name: "welcome" } : { name: "projects" }), true;
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  return (
    <View style={{ flex: 1 }}>
      {screen.name === "welcome" && <Welcome error={screen.error} onScan={() => setScreen({ name: "scan", from: "welcome" })} onLink={startPairing} />}
      {screen.name === "scan" && <Scanner onCode={startPairing} onCancel={() => setScreen(screen.from === "welcome" ? { name: "welcome" } : { name: "projects" })} />}
      {screen.name === "pairing" && <Pairing step={screen.step} />}
      {screen.name === "projects" && <Projects onOpen={(d) => openProject(d)} onPair={() => setScreen({ name: "scan", from: "projects" })} onSettings={() => setScreen({ name: "settings" })} onUnpaired={unpaired} />}
      {screen.name === "settings" && <Settings onBack={() => setScreen({ name: "projects" })} onRemoved={() => setScreen({ name: "welcome" })} onAbout={() => setScreen({ name: "about" })} />}
      {screen.name === "about" && <About onBack={() => setScreen({ name: "settings" })} />}
      {screen.name === "project" && <ProjectScreen key={screen.n} device={screen.device} initial={screen.initial} onBack={() => setScreen({ name: "projects" })} onUnpaired={unpaired} />}
      <OfflineBanner />
    </View>
  );
}

/** Over everything while this phone has no network: nothing can reach the relay, whatever the computer does. */
function OfflineBanner() {
  const online = useDeviceOnline();
  const insets = useSafeAreaInsets();
  const t = useTheme();
  if (online) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, paddingTop: insets.top + 6, paddingHorizontal: 6, backgroundColor: t.c.barBg }}>
      <Banner kind="warn" role="status" style={{ marginBottom: 6 }}>
        This phone is offline. Studio reconnects when it is back.
      </Banner>
    </View>
  );
}
