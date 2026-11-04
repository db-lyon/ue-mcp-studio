import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import { formatPairingCode } from "@ue-mcp-studio/remote";
import { callJson, devices, forget, NotPairedError, pair, select, selected, trusted, type Device, type PairStep } from "./src/relay";
import { colors } from "./src/theme";

type Screen = { name: "loading" } | { name: "welcome"; error?: string } | { name: "scan" } | { name: "pairing"; step: PairStep } | { name: "projects" } | { name: "project"; device: Device };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });

  useEffect(() => {
    void (async () => {
      const t = await trusted();
      if (!Object.keys(t).length) return setScreen({ name: "welcome" });
      const last = await selected();
      setScreen(last && last.computerKey in t ? { name: "project", device: last } : { name: "projects" });
    })().catch((e) => setScreen({ name: "welcome", error: String(e?.message ?? e) }));
  }, []);

  const startPairing = useCallback((scanned: string) => {
    setScreen({ name: "pairing", step: { kind: "status", text: "Reading the code" } });
    pair(scanned, (step) => setScreen({ name: "pairing", step }))
      .then(() => setScreen({ name: "projects" }))
      .catch((e) => setScreen({ name: "welcome", error: String(e?.message ?? e) }));
  }, []);

  const unpaired = useCallback((message: string) => {
    void forget().then(() => setScreen({ name: "welcome", error: message }));
  }, []);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {screen.name === "loading" && <Center><ActivityIndicator color={colors.accent} /></Center>}
      {screen.name === "welcome" && <Welcome error={screen.error} onScan={() => setScreen({ name: "scan" })} onLink={startPairing} />}
      {screen.name === "scan" && <Scanner onCode={startPairing} onCancel={() => setScreen({ name: "welcome" })} />}
      {screen.name === "pairing" && <Pairing step={screen.step} />}
      {screen.name === "projects" && <Projects onOpen={(d) => void select(d).then(() => setScreen({ name: "project", device: d }))} onPair={() => setScreen({ name: "scan" })} onUnpaired={unpaired} />}
      {screen.name === "project" && <Project device={screen.device} onBack={() => setScreen({ name: "projects" })} onUnpaired={unpaired} />}
    </View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={s.center}>{children}</View>;
}

function Button({ title, onPress, primary, disabled }: { title: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.button, primary && s.primary, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.buttonText, primary && s.primaryText]}>{title}</Text>
    </Pressable>
  );
}

function Welcome({ error, onScan, onLink }: { error?: string; onScan: () => void; onLink: (link: string) => void }) {
  const [link, setLink] = useState("");
  return (
    <View style={s.page}>
      <Text style={s.title}>UE-MCP Studio</Text>
      <Text style={s.body}>Pair this phone with Studio on your computer. In Studio, open Remote and show the pairing code, then scan it here.</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Button title="Scan pairing code" primary onPress={onScan} />
      <Text style={[s.sub, { marginTop: 24 }]}>Or paste the pairing link</Text>
      <TextInput value={link} onChangeText={setLink} placeholder="https://remote.ue-mcp.com/pair#..." placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={s.input} />
      <Button title="Pair with link" disabled={!link.trim()} onPress={() => onLink(link)} />
    </View>
  );
}

function Scanner({ onCode, onCancel }: { onCode: (data: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);
  if (!permission) return <Center><ActivityIndicator color={colors.accent} /></Center>;
  if (!permission.granted)
    return (
      <View style={s.page}>
        <Text style={s.title}>Camera</Text>
        <Text style={s.body}>Studio needs the camera to read the pairing code on your computer's screen.</Text>
        <Button title={permission.canAskAgain ? "Allow camera" : "Camera blocked in system settings"} primary disabled={!permission.canAskAgain} onPress={() => void requestPermission()} />
        <Button title="Back" onPress={onCancel} />
      </View>
    );
  return (
    <View style={{ flex: 1 }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          done.current = true;
          onCode(data);
        }}
      />
      <View style={s.scanBar}>
        <Text style={s.body}>Point the camera at the pairing code.</Text>
        <Button title="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function Pairing({ step }: { step: PairStep }) {
  if (step.kind === "code")
    return (
      <View style={s.page}>
        <Text style={s.title}>Approve on your computer</Text>
        <Text style={s.body}>Studio on your computer shows the same code:</Text>
        <Text style={s.code}>{formatPairingCode(step.code)}</Text>
        <Text style={s.sub}>If the code on your computer is different, choose Deny there.</Text>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />
      </View>
    );
  return (
    <Center>
      <ActivityIndicator color={colors.accent} />
      <Text style={[s.body, { marginTop: 16 }]}>{step.text}</Text>
    </Center>
  );
}

function Projects({ onOpen, onPair, onUnpaired }: { onOpen: (d: Device) => void; onPair: () => void; onUnpaired: (message: string) => void }) {
  const [list, setList] = useState<Device[] | null>(null);
  const [keys, setKeys] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setKeys(await trusted());
      setList(await devices());
      setError(null);
    } catch (e) {
      if (e instanceof NotPairedError) return onUnpaired("The relay no longer knows this phone. Pair it again.");
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [onUnpaired]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <View style={s.page}>
      <Text style={s.title}>Projects</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <FlatList
        data={list ?? []}
        keyExtractor={(d) => d.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={colors.accent} />}
        ListEmptyComponent={list ? <Text style={s.sub}>No project has connected yet. Turn on Remote in a project on your computer.</Text> : undefined}
        renderItem={({ item }) => {
          const paired = item.computerKey in keys;
          const status = !item.online ? `Last seen ${new Date(item.lastSeen).toLocaleString()}` : paired ? "Online" : "Online. Scan this computer's pairing code to open it here.";
          return (
            <Pressable style={s.row} disabled={!paired} onPress={() => onOpen(item)}>
              <View style={[s.dot, item.online && s.dotOn]} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.sub}>{status}</Text>
              </View>
            </Pressable>
          );
        }}
      />
      <Button title="Pair another computer" onPress={onPair} />
    </View>
  );
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  archived: boolean;
  awaiting: number;
}

function Project({ device, onBack, onUnpaired }: { device: Device; onBack: () => void; onUnpaired: (message: string) => void }) {
  const [health, setHealth] = useState<{ state: "checking" | "ok" | "error"; text: string }>({ state: "checking", text: "Connecting" });
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const h = await callJson<{ version?: string; ok?: boolean }>(device, "GET", "/v1/health");
      setHealth({ state: "ok", text: h?.version ? `Connected. ue-mcp ${h.version}` : "Connected" });
      try {
        const r = await callJson<{ sessions: SessionRow[] }>(device, "GET", "/v1/ext/studio/sessions");
        setSessions(r.sessions.filter((x) => !x.archived));
        setError(null);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    } catch (e) {
      if (e instanceof NotPairedError) return onUnpaired("The relay no longer knows this phone. Pair it again.");
      setHealth({ state: "error", text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  }, [device, onUnpaired]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <View style={s.page}>
      <Pressable onPress={onBack}>
        <Text style={s.link}>Projects</Text>
      </Pressable>
      <Text style={s.title}>{device.name}</Text>
      <View style={[s.row, { marginBottom: 12 }]}>
        <View style={[s.dot, health.state === "ok" && s.dotOn, health.state === "error" && s.dotErr]} />
        <Text style={[s.body, { flex: 1, marginBottom: 0 }]}>{health.text}</Text>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Text style={s.section}>Sessions</Text>
      <FlatList
        data={sessions ?? []}
        keyExtractor={(x) => x.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={colors.accent} />}
        ListEmptyComponent={sessions ? <Text style={s.sub}>No sessions yet.</Text> : undefined}
        renderItem={({ item }) => (
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{item.title || "New session"}</Text>
              <Text style={s.sub}>
                {item.status}
                {item.awaiting ? ` - ${item.awaiting} waiting for approval` : ""} - {new Date(item.updatedAt).toLocaleString()}
              </Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  page: { flex: 1, paddingHorizontal: 20, paddingTop: 56, paddingBottom: 24 },
  title: { color: colors.text, fontSize: 24, fontWeight: "600", marginBottom: 12 },
  section: { color: colors.muted, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 8, marginBottom: 8 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21, marginBottom: 16 },
  sub: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 14, marginBottom: 12 },
  link: { color: colors.accent, fontSize: 15, marginBottom: 8 },
  code: { color: colors.text, fontSize: 40, fontWeight: "700", letterSpacing: 4, marginVertical: 16, fontVariant: ["tabular-nums"] },
  input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 8 },
  button: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, borderRadius: 8, paddingVertical: 12, alignItems: "center", marginTop: 8 },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  primaryText: { color: colors.onAccent },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.faint },
  dotOn: { backgroundColor: colors.ok },
  dotErr: { backgroundColor: colors.danger },
  scanBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 32, backgroundColor: "rgba(12,12,11,0.85)" },
});
