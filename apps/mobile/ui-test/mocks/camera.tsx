/**
 * expo-camera for component tests and the visual QA page: permission granted
 * unless the page or a test sets __qaCamera (null while it is still asked),
 * a view a test can make "scan" a code through, and Scan from a picture
 * finding __scanPicture's code when one is set. On the visual QA page
 * (__qaCameraFeed) the view draws a stand-in for the camera's picture: a
 * computer's screen with a code on it.
 */
import { Pressable, Text, View } from "react-native";

type Permission = { granted: boolean; canAskAgain: boolean; status: string };
export const permission: Permission = { granted: true, canAskAgain: true, status: "granted" };
const g = globalThis as { __qaCamera?: Permission | null; __scan?: string; __scanPicture?: string; __qaCameraFeed?: boolean };

export const useCameraPermissions = () => [g.__qaCamera === undefined ? permission : g.__qaCamera, async () => g.__qaCamera ?? permission] as const;

export const Camera = {
  scanFromURLAsync: async (_uri: string, _types?: string[]) => (g.__scanPicture ? [{ data: g.__scanPicture, type: "qr" }] : []),
};

/** A code's modules, 21 by 21, from a fixed seed: enough to read as a QR code in a picture. */
function modules(): boolean[] {
  let s = 7;
  return Array.from({ length: 21 * 21 }, (_, i) => {
    const x = i % 21;
    const y = Math.floor(i / 21);
    const finder = (fx: number, fy: number) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7 && (x === fx || x === fx + 6 || y === fy || y === fy + 6 || (x >= fx + 2 && x <= fx + 4 && y >= fy + 2 && y <= fy + 4));
    if (finder(0, 0) || finder(14, 0) || finder(0, 14)) return true;
    if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) return false;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % 3 === 0;
  });
}

function Feed() {
  const m = modules();
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#16171a", alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 330, height: 260, borderRadius: 10, backgroundColor: "#24262b", alignItems: "center", justifyContent: "center", transform: [{ rotate: "-3deg" }] }}>
        <View style={{ width: 168, height: 168, padding: 10, backgroundColor: "#e9e7e2", flexDirection: "row", flexWrap: "wrap" }}>
          {m.map((on, i) => (
            <View key={i} style={{ width: 148 / 21, height: 148 / 21, backgroundColor: on ? "#111" : "transparent" }} />
          ))}
        </View>
      </View>
    </View>
  );
}

export function CameraView({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }) {
  if (g.__qaCameraFeed) return <Feed />;
  return (
    <Pressable accessibilityRole="button" onPress={() => onBarcodeScanned?.({ data: g.__scan ?? "" })}>
      <Text>Camera preview</Text>
    </Pressable>
  );
}
