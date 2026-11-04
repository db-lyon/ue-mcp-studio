/**
 * The pairing code scanner: the camera full screen behind a viewfinder, the
 * torch for a dim room, and Scan from a picture for a code saved or
 * screenshotted. The first code read goes to pairing, with a haptic tick; a
 * picture without one says so. The camera permission is asked in place, and
 * once refused for good the system settings are one press away.
 */
import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Camera, CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../native/haptics";
import { Button, Label, T, useTheme } from "../ui";

const FRAME = 248;

export function Scanner({ onCode, onCancel }: { onCode: (data: string) => void; onCancel: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const done = useRef(false);

  const take = (data: string) => {
    if (done.current) return;
    done.current = true;
    haptic.success();
    onCode(data);
  };

  const fromPicture = async () => {
    setNote(null);
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 }).catch(() => null);
    const uri = picked && !picked.canceled ? picked.assets[0]?.uri : null;
    if (!uri) return;
    const found = await Camera.scanFromURLAsync(uri, ["qr"]).catch(() => []);
    if (found[0]?.data) return take(found[0].data);
    haptic.error();
    setNote("No pairing code in that picture. Pick one that shows the whole code.");
  };

  const page = { flex: 1, backgroundColor: t.c.bg, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18, paddingHorizontal: 18 };

  if (!permission) return <View style={page} />;
  if (!permission.granted)
    return (
      <View style={[page, { gap: 14 }]}>
        <Label>Camera</Label>
        <T size={18} weight={600} lh={1.35}>
          Studio needs the camera to read the pairing code on your computer's screen.
        </T>
        <T tone="muted">It is used only while this screen is open. You can also scan a picture of the code instead.</T>
        <View style={{ gap: 8, marginTop: 6 }}>
          {permission.canAskAgain ? <Button title="Allow camera" variant="primary" onPress={() => void requestPermission()} /> : <Button title="Open settings" variant="primary" onPress={() => void Linking.openSettings()} />}
          <Button title="Scan from a picture" onPress={() => void fromPicture()} />
          <Button title="Back" variant="ghost" onPress={onCancel} />
        </View>
        {note ? <T tone="warnText">{note}</T> : null}
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => take(data)} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: FRAME, height: FRAME }}>
          {(["tl", "tr", "bl", "br"] as const).map((c) => (
            <View
              key={c}
              style={{
                position: "absolute",
                width: 34,
                height: 34,
                borderColor: t.c.accent,
                ...(c[0] === "t" ? { top: 0, borderTopWidth: 3 } : { bottom: 0, borderBottomWidth: 3 }),
                ...(c[1] === "l" ? { left: 0, borderLeftWidth: 3 } : { right: 0, borderRightWidth: 3 }),
                borderRadius: 4,
              }}
            />
          ))}
        </View>
      </View>
      <View style={{ position: "absolute", top: insets.top + 6, left: 6, right: 6, flexDirection: "row", justifyContent: "space-between" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onCancel} style={round(t.c.bg)}>
          <T size={22} lh={1}>
            {"×"}
          </T>
        </Pressable>
        <Pressable accessibilityRole="switch" accessibilityLabel="Torch" accessibilityState={{ checked: torch }} aria-checked={torch} onPress={() => (haptic.select(), setTorch((v) => !v))} style={[round(torch ? t.c.accent : t.c.bg)]}>
          <T size={18} lh={1} style={{ color: torch ? t.c.onAccent : t.c.text }}>
            {"⚡"}
          </T>
        </Pressable>
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 16, paddingBottom: insets.bottom + 18, backgroundColor: t.c.barBg, borderTopWidth: 1, borderTopColor: t.c.line, gap: 10 }}>
        <T tone="text" style={{ textAlign: "center" }}>
          Point the camera at the pairing code Studio shows on your computer.
        </T>
        {note ? (
          <T tone="warnText" style={{ textAlign: "center" }}>
            {note}
          </T>
        ) : null}
        <Button title="Scan from a picture" onPress={() => void fromPicture()} />
      </View>
    </View>
  );
}

const round = (bg: string) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: bg, alignItems: "center" as const, justifyContent: "center" as const, opacity: 0.92 });
