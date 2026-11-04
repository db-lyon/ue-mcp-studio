import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { formatPairingCode } from "@ue-mcp-studio/remote";
import type { PairStep } from "../relay";
import { Button, Center, s, Spinner } from "../ui";
import { colors } from "../theme";

export function Welcome({ error, onScan, onLink }: { error?: string; onScan: () => void; onLink: (link: string) => void }) {
  const [link, setLink] = useState("");
  return (
    <View style={s.page}>
      <Text style={[s.title, { marginBottom: 12 }]}>UE-MCP Studio</Text>
      <Text style={s.body}>Pair this phone with Studio on your computer. In Studio, open Remote and show the pairing code, then scan it here or with your camera app.</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Button title="Scan pairing code" primary onPress={onScan} />
      <Text style={[s.sub, { marginTop: 24 }]}>Or paste the pairing link</Text>
      <TextInput value={link} onChangeText={setLink} placeholder="https://remote.ue-mcp.com/pair#..." placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={s.input} />
      <Button title="Pair with link" disabled={!link.trim()} onPress={() => onLink(link)} />
    </View>
  );
}

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

export function Pairing({ step }: { step: PairStep }) {
  if (step.kind === "code")
    return (
      <View style={s.page}>
        <Text style={[s.title, { marginBottom: 12 }]}>Approve on your computer</Text>
        <Text style={s.body}>Studio on your computer shows the same code:</Text>
        <Text style={s.code}>{formatPairingCode(step.code)}</Text>
        <Text style={s.sub}>If the code on your computer is different, choose Deny there.</Text>
        <View style={{ marginTop: 24 }}>
          <Spinner />
        </View>
      </View>
    );
  return (
    <Center>
      <Spinner />
      <Text style={[s.body, { marginTop: 16 }]}>{step.text}</Text>
    </Center>
  );
}
