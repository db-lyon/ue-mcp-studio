import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Linking, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { isPairLink, pair, select, selected, trusted, forget, type Device, type PairStep } from "./src/relay";
import { Center, Spinner, s } from "./src/ui";
import { Welcome, Scanner, Pairing } from "./src/screens/Pairing";
import { Projects } from "./src/screens/Projects";
import { Settings } from "./src/screens/Settings";
import { ProjectScreen } from "./src/screens/Project";

type Screen =
  | { name: "loading" }
  | { name: "welcome"; error?: string }
  | { name: "scan" }
  | { name: "pairing"; step: PairStep }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "project"; device: Device };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const pairing = useRef(false);

  const startPairing = useCallback((scanned: string) => {
    if (pairing.current) return;
    pairing.current = true;
    setScreen({ name: "pairing", step: { kind: "status", text: "Reading the code" } });
    pair(scanned, (step) => setScreen({ name: "pairing", step }))
      .then(() => setScreen({ name: "projects" }))
      .catch((e) => setScreen({ name: "welcome", error: String(e?.message ?? e) }))
      .finally(() => (pairing.current = false));
  }, []);

  useEffect(() => {
    void (async () => {
      // Opened from a pairing link (the system camera, or a tap on the link): pair first.
      const initial = await Linking.getInitialURL().catch(() => null);
      if (initial && isPairLink(initial)) return startPairing(initial);
      const t = await trusted();
      if (!Object.keys(t).length) return setScreen({ name: "welcome" });
      const last = await selected();
      setScreen(last && last.computerKey in t ? { name: "project", device: last } : { name: "projects" });
    })().catch((e) => setScreen({ name: "welcome", error: String(e?.message ?? e) }));
    const sub = Linking.addEventListener("url", ({ url }) => {
      if (isPairLink(url)) startPairing(url);
    });
    return () => sub.remove();
  }, [startPairing]);

  const unpaired = useCallback((message: string) => {
    void forget().then(() => setScreen({ name: "welcome", error: message }));
  }, []);

  // Android back: up one level rather than out of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen.name === "project" || screen.name === "settings") return setScreen({ name: "projects" }), true;
      if (screen.name === "scan") return setScreen({ name: "welcome" }), true;
      return false;
    });
    return () => sub.remove();
  }, [screen.name]);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {screen.name === "loading" && (
        <Center>
          <Spinner />
        </Center>
      )}
      {screen.name === "welcome" && <Welcome error={screen.error} onScan={() => setScreen({ name: "scan" })} onLink={startPairing} />}
      {screen.name === "scan" && <Scanner onCode={startPairing} onCancel={() => setScreen({ name: "welcome" })} />}
      {screen.name === "pairing" && <Pairing step={screen.step} />}
      {screen.name === "projects" && (
        <Projects
          onOpen={(d) => void select(d).then(() => setScreen({ name: "project", device: d }))}
          onPair={() => setScreen({ name: "scan" })}
          onSettings={() => setScreen({ name: "settings" })}
          onUnpaired={unpaired}
        />
      )}
      {screen.name === "settings" && <Settings onBack={() => setScreen({ name: "projects" })} onRemoved={() => setScreen({ name: "welcome" })} />}
      {screen.name === "project" && <ProjectScreen device={screen.device} onBack={() => setScreen({ name: "projects" })} onUnpaired={unpaired} />}
    </View>
  );
}
