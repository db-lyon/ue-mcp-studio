/** expo-camera for component tests: permission granted, and a view a test can make "scan" a code through. */
import { Pressable, Text } from "react-native";
export const permission = { granted: true, canAskAgain: true, status: "granted" };
export const useCameraPermissions = () => [permission, async () => permission] as const;
export function CameraView({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => onBarcodeScanned?.({ data: (globalThis as { __scan?: string }).__scan ?? "" })}>
      <Text>Camera preview</Text>
    </Pressable>
  );
}
/** Scan from a picture: no code found in the browser. */
export const Camera = { scanFromURLAsync: async (_uri: string, _types?: string[]) => [] as { data: string }[] };
