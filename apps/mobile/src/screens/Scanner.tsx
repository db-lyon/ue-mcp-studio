/**
 * The pairing code scanner: the camera full screen behind a viewfinder, the
 * torch for a dim room, and Scan from a picture for a code saved or
 * screenshotted. The first code read goes to pairing, with a haptic tick; a
 * picture without one says so. The camera permission is asked in place, as a
 * pairing state in the relay's look, and once refused for good the system
 * settings are one press away.
 */
import { useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Camera, CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { haptic } from "../native/haptics";
import { Banner, bannerText, Button, font, T, useTheme, Waiting } from "../ui";
import { Page, StateView } from "./StudioPage";
import { Code } from "./Pairing";

const FRAME = 248;
/** The camera's picture outside the frame. */
const DIM = "rgba(0, 0, 0, 0.5)";
const NO_CODE = "No pairing code in that picture. Pick one that shows the whole code.";

/** The scanner's round buttons over the camera: a dark disc, its glyph, 44 points. */
function Round({ label, onPress, on, children, role = "button" }: { label: string; onPress: () => void; on?: boolean; children: ReactNode; role?: "button" | "switch" }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === "switch" ? { checked: !!on } : undefined}
      aria-checked={role === "switch" ? !!on : undefined}
      onPress={onPress}
      style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: on ? t.c.accent : t.c.lineStrong, backgroundColor: on ? t.c.accent : pressed ? t.c.panel3 : "rgba(12, 12, 11, 0.72)" })}
    >
      {children}
    </Pressable>
  );
}

/** A picture without a code: the warn banner, its text centred in the centred stack it sits in. */
function NoteBanner({ text }: { text: string }) {
  const t = useTheme();
  return (
    <Banner kind="warn" role="alert" style={{ marginBottom: 0 }}>
      <T style={{ color: bannerText(t, "warn"), textAlign: "center" }}>{text}</T>
    </Banner>
  );
}

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
    setNote(NO_CODE);
  };

  if (!permission)
    return (
      <Page stage title="Scan pairing code" onBack={onCancel}>
        <StateView glyph="camera" title="Opening the camera" lead="This app reads the pairing code on your computer's screen with the camera.">
          <Waiting>Asking for the camera</Waiting>
        </StateView>
      </Page>
    );

  if (!permission.granted) {
    const ask = permission.canAskAgain;
    return (
      <Page stage title="Scan pairing code" onBack={onCancel}>
        <StateView
          glyph={ask ? "camera" : "camera-off"}
          title={ask ? "This app needs the camera" : "The camera is off for this app"}
          lead={ask ? "It reads the pairing code on your computer's screen, and only while this screen is open." : "Turn the camera on for UE-MCP Studio in this phone's settings, or scan a picture of the code instead."}
          note={note ? <NoteBanner text={note} /> : null}
          actions={
            <>
              {ask ? <Button title="Allow camera" variant="primary" size="large" onPress={() => void requestPermission()} /> : <Button title="Open settings" variant="primary" size="large" onPress={() => void Linking.openSettings()} />}
              <Button title="Scan from a picture" size="large" onPress={() => void fromPicture()} />
            </>
          }
        />
      </Page>
    );
  }

  const corner = 34;
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => take(data)} />
      {/* The picture dimmed around the frame, so the eye goes to where the code belongs. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={{ flex: 1, backgroundColor: DIM }} />
        <View style={{ flexDirection: "row", height: FRAME }}>
          <View style={{ flex: 1, backgroundColor: DIM }} />
          <View style={{ width: FRAME }} />
          <View style={{ flex: 1, backgroundColor: DIM }} />
        </View>
        <View style={{ flex: 1, backgroundColor: DIM }} />
      </View>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: FRAME, height: FRAME }}>
          {(["tl", "tr", "bl", "br"] as const).map((c) => (
            <View
              key={c}
              style={{
                position: "absolute",
                width: corner,
                height: corner,
                borderColor: t.c.accent,
                ...(c[0] === "t" ? { top: 0, borderTopWidth: 3 } : { bottom: 0, borderBottomWidth: 3 }),
                ...(c[1] === "l" ? { left: 0, borderLeftWidth: 3 } : { right: 0, borderRightWidth: 3 }),
                ...(c === "tl" ? { borderTopLeftRadius: 18 } : c === "tr" ? { borderTopRightRadius: 18 } : c === "bl" ? { borderBottomLeftRadius: 18 } : { borderBottomRightRadius: 18 }),
              }}
            />
          ))}
        </View>
      </View>
      <View style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Round label="Close" onPress={onCancel}>
          <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={t.c.text} strokeWidth={1.8} strokeLinecap="round">
            <Path d="M4 4l8 8M12 4l-8 8" />
          </Svg>
        </Round>
        <View style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: t.c.lineStrong, backgroundColor: "rgba(12, 12, 11, 0.72)" }}>
          <T style={{ ...font(t, "sans", 600, 13, 1.3), color: t.c.text }}>Scan pairing code</T>
        </View>
        <Round label="Torch" role="switch" on={torch} onPress={() => (haptic.select(), setTorch((v) => !v))}>
          <Svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke={torch ? t.c.onAccent : t.c.text} strokeWidth={1.5} strokeLinejoin="round">
            <Path d="M9.5 1.5L4 9h3.5l-1 5.5L12 7H8.5z" />
          </Svg>
        </Round>
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 16, paddingBottom: Math.max(16, insets.bottom), gap: 12, backgroundColor: t.c.panel, borderTopWidth: 1, borderTopColor: t.c.line, borderTopLeftRadius: 14, borderTopRightRadius: 14 }}>
        <T style={{ ...font(t, "sans", 600, 15, 1.3), color: t.c.text, textAlign: "center" }}>Point the camera at the code</T>
        <T style={{ color: t.c.dim, textAlign: "center" }}>
          On the computer running Studio, type <Code>/remote</Code> in a chat, or open <T style={{ ...font(t, "sans", 600, t.base.size), color: t.c.muted }}>{"Settings > Remote control"}</T>.
        </T>
        {note ? <NoteBanner text={note} /> : null}
        <Button title="Scan from a picture" size="large" onPress={() => void fromPicture()} />
      </View>
    </View>
  );
}
