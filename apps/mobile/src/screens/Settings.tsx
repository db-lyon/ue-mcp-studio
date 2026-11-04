/**
 * Paired devices: the account's paired phones and browsers, each removable,
 * and the computers this phone trusts, each forgettable. Removing this phone
 * signs it out of the relay and forgets every computer here.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { account, forgetComputer, removeViewer, trusted, type Device, type Viewer } from "../relay";
import { Header, s, Spinner } from "../ui";
import { colors } from "../theme";

export function Settings({ onBack, onRemoved }: { onBack: () => void; onRemoved: () => void }) {
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [keys, setKeys] = useState<Record<string, { pairedAt: string }>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await trusted());
      const a = await account();
      setViewers(a.viewers);
      setDevices(a.devices);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setViewers([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const remove = (v: Viewer) =>
    Alert.alert(v.current ? "Remove this phone?" : `Remove ${v.label}?`, v.current ? "It stops reaching your projects until you pair it again." : "It stops reaching your projects until it is paired again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void removeViewer(v).then(
            () => (v.current ? onRemoved() : void load()),
            (e) => setError(String(e?.message ?? e)),
          ),
      },
    ]);

  const forgetKey = (key: string, name: string) =>
    Alert.alert(`Forget ${name}?`, "This phone stops trusting that computer until you scan its pairing code again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => void forgetComputer(key).then(load) },
    ]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.page}>
      <Header title="Devices" back="Projects" onBack={onBack} />
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Text style={s.section}>Paired phones and browsers</Text>
      {viewers === null ? <Spinner /> : null}
      {viewers?.map((v) => (
        <View key={v.id} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>
              {v.label}
              {v.current ? " (this phone)" : ""}
            </Text>
            <Text style={s.sub}>Paired {new Date(v.createdAt).toLocaleDateString()}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => remove(v)} hitSlop={8}>
            <Text style={{ color: colors.danger, fontSize: 15 }}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <Text style={s.section}>Computers this phone trusts</Text>
      {Object.keys(keys).length === 0 ? <Text style={s.sub}>None.</Text> : null}
      {Object.entries(keys).map(([key, info]) => {
        const names = devices.filter((d) => d.computerKey === key).map((d) => d.name);
        const name = names.length ? names.join(", ") : "A computer";
        return (
          <View key={key} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{name}</Text>
              <Text style={s.sub}>Paired {new Date(info.pairedAt).toLocaleDateString()}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => forgetKey(key, name)} hitSlop={8}>
              <Text style={{ color: colors.danger, fontSize: 15 }}>Forget</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
