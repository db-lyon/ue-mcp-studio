import "./src/native/system";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { PanelLocation } from "@ue-mcp-studio/client-core";
import { THEMES, ThemeProvider, useStudioFonts, type ThemeName } from "./src/ui";
import { account, dropPairingsWithoutKey, forgetComputer, isPairLink, pair, pairListed, PairError, select, selected, trusted, forget, type Device, type PairStep } from "./src/relay";
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
import { noteInput } from "./src/notifications/useNotifications";

keepAliveOnErrors();

type Screen =
  | { name: "loading" }
  | { name: "welcome"; error?: string }
  | { name: "scan"; from: "welcome" | "projects" }
  | { name: "pairing"; step: PairStep }
  | { name: "paired" }
  /** `link` retries a code; `device` retries a pairing from the list. */
  | { name: "pair-failed"; failure: PairFailure; link?: string; device?: Device }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "about" }
  /** from: the projects list, or straight in at start (then its sessions list is the root). */
  | { name: "project"; device: Device; initial?: PanelLocation; n: number; from: "projects" | "start" };

/** How long Paired stays up before the projects open. */
const PAIRED_MS = 1200;
/** How long startup waits for the relay's list to say whether the last project is online before opening Projects. */
const STARTUP_LIST_MS = 4000;

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
            {/* Every touch is input for "Only when I'm away" (phoneInUse). */}
            <View style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }} onTouchStart={noteInput}>
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
  /** A notification tap has chosen the project; startup does not override it. */
  const tapped = useRef(false);
  const shared = useSharedFiles();

  const openProject = useCallback((device: Device, initial?: PanelLocation, from: "projects" | "start" = "projects") => {
    void select(device).then(() => setScreen({ name: "project", device, initial, n: ++opened.current, from }));
  }, []);

  const runPairing = useCallback((run: (onStep: (s: PairStep) => void) => Promise<void>, retry: { link?: string; device?: Device }, first: string) => {
    if (pairing.current) return;
    pairing.current = true;
    setScreen({ name: "pairing", step: { kind: "status", text: first } });
    run((step) => setScreen({ name: "pairing", step }))
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
        setScreen({ name: "pair-failed", failure, ...retry });
      })
      .finally(() => (pairing.current = false));
  }, []);
  const startPairing = useCallback((scanned: string) => runPairing((onStep) => pair(scanned, onStep), { link: scanned }, "Reading the code"), [runPairing]);
  // A computer already on the account's list pairs without a code: both screens show six digits to compare.
  const pairWith = useCallback((device: Device) => runPairing((onStep) => pairListed(device, onStep), { device }, "Asking your computer"), [runPairing]);

  useEffect(() => {
    void (async () => {
      // Opened through the app's own uemcpstudio://pair link (an explicit Open in app): pair first.
      const initial = await Linking.getInitialURL().catch(() => null);
      if (initial && isPairLink(initial)) return startPairing(initial);
      // Pairings remembered without their key (a reinstall restored from a backup) can never work: pair again.
      if (await dropPairingsWithoutKey()) return setScreen({ name: "welcome", error: "This phone's pairing was lost when the app was reinstalled. Pair it again." });
      const t = await trusted();
      if (!Object.keys(t).length) return setScreen({ name: "welcome" });
      // The last project when the relay says it is online; otherwise Projects, the app's home. A notification tap that opened the app wins.
      const last = await selected();
      if (tapped.current) return;
      if (!last || !(last.computerKey in t)) return setScreen({ name: "projects" });
      const listed = await Promise.race([account().then((a) => a.devices, () => null), new Promise<null>((done) => setTimeout(() => done(null), STARTUP_LIST_MS))]);
      if (tapped.current) return;
      const now = listed?.find((d) => d.id === last.id);
      if (now?.online) openProject({ ...last, ...now }, undefined, "start");
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
          // The tap decides where the app opens: startup's own choice (the last project) gives way to it.
          tapped.current = true;
          const t = await trusted();
          const listed = (await account().catch(() => null))?.devices.find((x) => x.id === d.deviceId);
          // Without the relay's list, the project this phone last had open is the notified one if the ids match.
          const last = listed ? null : await selected().catch(() => null);
          const device = listed ?? (last?.id === d.deviceId ? last : null);
          if (!device || !(device.computerKey in t)) return setScreen(Object.keys(t).length ? { name: "projects" } : { name: "welcome" });
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

  // One computer no longer knows this phone: drop that pairing only, and pair again.
  const unpairedFrom = useCallback((device: Device, message: string) => {
    void forgetComputer(device.computerKey)
      .catch(() => undefined)
      .then(() => setScreen({ name: "welcome", error: `${message.replace(/\s*Pair it again.*$/i, "")} Pair it again with a new code from that computer.`.trim() }));
  }, []);

  // After a pairing that stopped: the projects when a computer is already paired, else the welcome.
  const startOver = useCallback(() => {
    void trusted().then(
      (t) => setScreen(Object.keys(t).length ? { name: "projects" } : { name: "welcome" }),
      () => setScreen({ name: "welcome" }),
    );
  }, []);

  // System back (and the predictive back gesture): up one level; the screens inside a project go first.
  // Projects is the home: back from a project's sessions list goes there, and only there (or on Welcome) does back leave the app.
  const root = screen.name === "welcome" || screen.name === "projects";
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
      {screen.name === "pair-failed" && <PairFailed failure={screen.failure} onScan={() => setScreen({ name: "scan", from: "welcome" })} onStart={startOver} onRetry={() => (screen.device ? pairWith(screen.device) : screen.link ? startPairing(screen.link) : undefined)} />}
      {screen.name === "projects" && <Projects onOpen={(d) => openProject(d)} onPairWith={pairWith} onPair={() => setScreen({ name: "scan", from: "projects" })} onSettings={() => setScreen({ name: "settings" })} onUnpaired={unpaired} />}
      {screen.name === "settings" && <Settings onBack={() => setScreen({ name: "projects" })} onRemoved={() => setScreen({ name: "welcome" })} onAbout={() => setScreen({ name: "about" })} />}
      {screen.name === "about" && <About onBack={() => setScreen({ name: "settings" })} />}
      {screen.name === "project" && (
        <BackLayer>
          <ProjectScreen
            key={screen.n}
            device={screen.device}
            initial={screen.initial}
            onBack={() => setScreen({ name: "projects" })}
            onUnpaired={(m) => unpairedFrom(screen.device, m)}
            onPair={() => setScreen({ name: "scan", from: "projects" })}
          />
        </BackLayer>
      )}
      <OfflineBanner />
      <BackToast />
    </View>
  );
}
