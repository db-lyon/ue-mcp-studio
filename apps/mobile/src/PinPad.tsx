/**
 * The native PIN keypad for the remote lock: the whole-app lock screen, or a
 * sheet for one sensitive action. It submits on the last digit when the
 * computer says how long the PIN is, and with a button otherwise.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Lock, LockView } from "@ue-mcp-studio/client-core";
import { Button, s as ui, Spinner } from "./legacy-ui";
import { colors } from "./theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
const MAX_DIGITS = 12;

export function PinPad({ lock, view, onRemoved }: { lock: Lock; view: LockView; onRemoved: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, tick] = useState(0);
  const length = view.state?.pinLength;
  const sheet = !view.screen && view.prompt;

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [waitUntil]);
  const waitLeft = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));

  const submit = async (value: string) => {
    if (busy || !value) return;
    setBusy(true);
    const r = await lock.unlock(value);
    setBusy(false);
    setPin("");
    if (r.ok) return setError(null);
    if (r.removed) return onRemoved();
    if (r.retryAfterMs) setWaitUntil(Date.now() + r.retryAfterMs);
    setError(r.remaining !== undefined ? `${r.error} ${r.remaining} ${r.remaining === 1 ? "try" : "tries"} left.` : r.error);
  };

  const press = (k: string) => {
    if (busy || waitLeft > 0) return;
    if (k === "del") return setPin((p) => p.slice(0, -1));
    if (!k || pin.length >= MAX_DIGITS) return;
    const next = pin + k;
    setPin(next);
    if (length && next.length === length) void submit(next);
  };

  if (view.removed)
    return (
      <View style={[ui.page, ui.center]}>
        <Text style={ui.title}>Removed</Text>
        <Text style={[ui.body, { textAlign: "center" }]}>This phone was removed after too many wrong PINs. Pair it again from your computer.</Text>
        <Button title="Pair again" primary onPress={onRemoved} />
      </View>
    );

  return (
    <View style={[StyleSheet.absoluteFill, p.cover, sheet && p.sheetBg]}>
      <View style={[p.panel, sheet && p.sheet]}>
        <Text style={[ui.title, { textAlign: "center" }]}>{sheet ? "Enter your PIN" : "Studio is locked"}</Text>
        <Text style={[ui.sub, { textAlign: "center", marginTop: 6 }]}>{sheet ? "This action needs your remote PIN." : "Enter the PIN you set in Studio on your computer."}</Text>
        <View style={p.dots}>
          {Array.from({ length: Math.max(length ?? 0, pin.length, 4) }, (_, i) => (
            <View key={i} style={[p.dot, i < pin.length && p.dotOn]} />
          ))}
        </View>
        <View style={{ minHeight: 22, alignItems: "center" }}>
          {busy ? <Spinner /> : waitLeft > 0 ? <Text style={ui.sub}>Try again in {waitLeft} s</Text> : error ? <Text style={[ui.error, { marginBottom: 0 }]}>{error}</Text> : null}
        </View>
        <View style={p.grid}>
          {KEYS.map((k, i) => (
            <Pressable key={i} accessibilityRole="button" accessibilityLabel={k === "del" ? "Delete" : k || undefined} disabled={!k} onPress={() => press(k)} style={({ pressed }) => [p.key, !k && { opacity: 0 }, pressed && p.keyDown]}>
              <Text style={p.keyText}>{k === "del" ? "⌫" : k}</Text>
            </Pressable>
          ))}
        </View>
        {!length ? <Button title="Unlock" primary disabled={!pin || busy || waitLeft > 0} onPress={() => void submit(pin)} /> : null}
        {sheet ? <Button title="Cancel" onPress={() => lock.cancelPrompt()} /> : null}
      </View>
    </View>
  );
}

const p = StyleSheet.create({
  cover: { backgroundColor: colors.bg, justifyContent: "center", paddingHorizontal: 24 },
  sheetBg: { backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end", paddingHorizontal: 0 },
  panel: { paddingVertical: 24 },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 24, paddingBottom: 32 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 14, marginTop: 24, marginBottom: 12 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.muted },
  dotOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: 8, alignSelf: "center", width: 276 },
  key: { width: 72, height: 72, margin: 10, borderRadius: 36, alignItems: "center", justifyContent: "center", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  keyDown: { backgroundColor: colors.border },
  keyText: { color: colors.text, fontSize: 26, fontWeight: "500" },
});
