// STUB: owned by the integrator (mobile/m1 moves the scanner here with torch, gallery and permission flow); replaced at merge.
import { useRef } from "react";
import { Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button, Center, s, Spinner } from "../legacy-ui";

export function Scanner({ onCode, onCancel }: { onCode: (data: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);
  if (!permission)
    return (
      <Center>
        <Spinner />
      </Center>
    );
  if (!permission.granted)
    return (
      <View style={s.page}>
        <Text style={[s.title, { marginBottom: 12 }]}>Camera</Text>
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
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 32, backgroundColor: "rgba(12,12,11,0.85)" }}>
        <Text style={s.body}>Point the camera at the pairing code.</Text>
        <Button title="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
