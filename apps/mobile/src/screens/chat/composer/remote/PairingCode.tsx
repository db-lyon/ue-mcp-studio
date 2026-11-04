/**
 * The web client's views/remote/PairingCode.tsx: the QR to scan, the link to
 * open on the device, and how long it has left. Once it runs out the QR goes
 * and onRenew offers a new one.
 */
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { RemotePairing } from "@ue-mcp-studio/shared";
import { pairingExpired, timeLeft } from "@ue-mcp-studio/client-core";
import { Button, T, useTheme } from "../../../../ui";
import { small } from "../styles";
import { QrSvg } from "./QrSvg";

export { pairingExpired, timeLeft };

export function PairingCode({ pairing, onRenew, busy }: { pairing: RemotePairing; onRenew: () => void; busy?: boolean }) {
  const t = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pairing.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing.expiresAt]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(pairing.url).then(() => setCopied(true), () => undefined);
  };
  // .remote-qr: a centred column, 10 px apart, 12 px under what is above it.
  const column = { flexDirection: "column" as const, alignItems: "center" as const, gap: 10, marginTop: 12 };
  if (pairingExpired(pairing, now)) {
    return (
      <View accessibilityLiveRegion="polite" style={[column, { paddingVertical: 12 }]}>
        <T style={[small(t), { color: t.c.muted }]}>This code has expired.</T>
        <Button title={busy ? "Making a code" : "New code"} variant="primary" disabled={busy} onPress={onRenew} />
      </View>
    );
  }
  const left = timeLeft(pairing, now);
  return (
    <View style={column}>
      {/* .qr: white, 8 px in, 220 px wide, the QR filling it. */}
      <View accessibilityRole="image" accessibilityLabel="Pairing QR code" style={{ backgroundColor: "#fff", padding: 8, borderRadius: 8, width: 220, maxWidth: "100%" }}>
        <QrSvg xml={pairing.svg} size={204} />
      </View>
      {/* a.path at a phone's 44 pixel target. */}
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(pairing.url)} style={{ minHeight: 44, paddingVertical: 4, maxWidth: "100%", justifyContent: "center" }}>
        <T style={{ ...small(t), fontSize: 12, color: t.c.accent, textAlign: "center" }}>{pairing.url}</T>
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        {left ? <T style={[small(t), { color: t.c.muted }]}>{`Works once, for ${left} more.`}</T> : null}
        {/* .remote-qr button.ghost draws as a plain button on a phone. */}
        <Button title={copied ? "Copied" : "Copy link"} size="small" onPress={copy} />
      </View>
    </View>
  );
}
