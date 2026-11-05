import "./src/native/system";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { PanelLocation } from "@ue-mcp-studio/client-core";
import { THEMES, ThemeProvider, useStudioFonts, type ThemeName } from "./src/ui";
import { account, isPairLink, pair, PairError, select, selected, trusted, forget, type Device, type PairStep } from "./src/relay";
import { applySystemTheme, hideSplash } from "./src/native/system";
import { KeyboardProvider } from "./src/native/keyboard";
import { ShareProvider, useSharedFiles } from "./src/native/share";
import { useShortcutTarget, type ShortcutTarget } from "./src/native/shortcuts";
import { OfflineBanner } from "./src/views/OfflineBanner";
import { haptic } from "./src/native/haptics";
import { Welcome, Pairing, Paired, PairFailed, type PairFailure } from "./src/screens/Pairing";
import { Scanner } from "./src/screens/Scanner";
import { Projects } from "./src/screens/Projects";
import { Settings } from "./src/screens/Settings";
import { About } from "./src/screens/About";
import { ProjectScreen } from "./src/screens/Project";
import { BackLayer, BackToast, useBack, useBackExit } from "./src/back";
import { ErrorBoundary } from "./src/views/ErrorBoundary";
import { keepAliveOnErrors } from "./src/native/keep-alive";
import { onTap as onNotificationTap } from "./src/native/notify";
import { pendingLatest } from "./src/notifications/state";

keepAliveOnErrors();

type Screen =
  | { name: "loading" }
  | { name: "welcome"; error?: string }
  | { name: "scan"; from: "welcome" | "projects" }
  | { name: "pairing"; step: PairStep }
  | { name: "paired" }
  | { name: "pair-failed"; failure: PairFailure; link: string }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "about" }
  /** from: the projects list, or straight in at start (then its sessions list is the root). */
  | { name: "project"; device: Device; initial?: PanelLocation; n: number; from: "projects" | "start" };

/** How long Paired stays up before the projects open. */
const PAIRED_MS = 1200;

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
          {/* The window's insets from the first frame, so nothing is laid out once under the navigation bar and then moves. */}
          <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
            <StatusBar style="light" />
            <View style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
              {/* Last line: a render error anywhere shows here with Reload, never closes the app. */}
              {fonts ? (
                <ErrorBoundary what="Studio">
                  <Root />
                </ErrorBoundary>
              ) : null}
            </View>
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

  const openProject = useCallback((device: Device, initial?: PanelLocation, from: "projects" | "start" = "projects") => {
    void select(device).then(() => setScreen({ name: "project", device, initial, n: ++opened.current, from }));
  }, []);

  const startPairing = useCallback((scanned: string) => {
    if (pairing.current) return;
    pairing.current = true;
    setScreen({ name: "pairing", step: { kind: "status", text: "Reading the code" } });
    pair(scanned, (step) => setScreen({ name: "pairing", step }))
      .then(async () => {
        haptic.success();
        // A moment on the tick, as the relay's page holds Paired before it opens Studio.
        setScreen({ name: "paired" });
        await new Promise((done) => setTimeout(done, PAIRED_MS));
        setScreen({ name: "projects" });
      })
      .catch((e) => {
        haptic.error();
        const failure: PairFailure = e instanceof PairError ? { kind: e.kind, message: e.message } : { kind: "failed", message: String(e?.message ?? e) };
        setScreen({ name: "pair-failed", failure, link: scanned });
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
      if (last && last.computerKey in t) openProject(last, undefined, "start");
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

  // A tap on a notification: open its project on its session, or on the latest notice's when a push named only the project.
  useEffect(
    () =>
      onNotificationTap((d) => {
        void (async () => {
          const t = await trusted();
          const device = (await account().catch(() => null))?.devices.find((x) => x.id === d.deviceId);
          if (!device || !(device.computerKey in t)) return;
          if (!d.sessionId) pendingLatest.set(device.id, d.kind);
          openProject(device, { tab: "Chat", session: d.sessionId ?? null, section: null });
        })();
      }),
    [openProject],
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

  // After a pairing that stopped: the projects when a computer is already paired, else the welcome.
  const startOver = useCallback(() => {
    void trusted().then(
      (t) => setScreen(Object.keys(t).length ? { name: "projects" } : { name: "welcome" }),
      () => setScreen({ name: "welcome" }),
    );
  }, []);

  // System back (and the predictive back gesture): up one level; the screens inside a project go first.
  const root = screen.name === "welcome" || screen.name === "projects" || (screen.name === "project" && screen.from === "start");
  useBack(
    root
      ? null
      : () => {
          if (screen.name === "pair-failed") return startOver();
          if (screen.name === "project" || screen.name === "settings") return setScreen({ name: "projects" });
          if (screen.name === "about") return setScreen({ name: "settings" });
          if (screen.name === "scan") return setScreen(screen.from === "welcome" ? { name: "welcome" } : { name: "projects" });
          // Loading, pairing and the moment on Paired: nothing to go back to yet, and not a way out.
        },
  );
  useBackExit(root);

  return (
    <View style={{ flex: 1 }}>
      {screen.name === "welcome" && <Welcome error={screen.error} onScan={() => setScreen({ name: "scan", from: "welcome" })} onLink={startPairing} />}
      {screen.name === "scan" && <Scanner onCode={startPairing} onCancel={() => setScreen(screen.from === "welcome" ? { name: "welcome" } : { name: "projects" })} />}
      {screen.name === "pairing" && <Pairing step={screen.step} />}
      {screen.name === "paired" && <Paired />}
      {screen.name === "pair-failed" && <PairFailed failure={screen.failure} onScan={() => setScreen({ name: "scan", from: "welcome" })} onStart={startOver} onRetry={() => startPairing(screen.link)} />}
      {screen.name === "projects" && <Projects onOpen={(d) => openProject(d)} onPair={() => setScreen({ name: "scan", from: "projects" })} onSettings={() => setScreen({ name: "settings" })} onUnpaired={unpaired} />}
      {screen.name === "settings" && <Settings onBack={() => setScreen({ name: "projects" })} onRemoved={() => setScreen({ name: "welcome" })} onAbout={() => setScreen({ name: "about" })} />}
      {screen.name === "about" && <About onBack={() => setScreen({ name: "settings" })} />}
      {screen.name === "project" && (
        <BackLayer>
          <ProjectScreen key={screen.n} device={screen.device} initial={screen.initial} onBack={() => setScreen({ name: "projects" })} onUnpaired={unpaired} />
        </BackLayer>
      )}
      <OfflineBanner />
      <BackToast />
    </View>
  );
}
