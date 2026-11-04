import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { formatPairingCode } from "@ue-mcp-studio/remote";
import type { PairStep } from "../relay";
import { Button, Center, s, Spinner } from "../legacy-ui";
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
