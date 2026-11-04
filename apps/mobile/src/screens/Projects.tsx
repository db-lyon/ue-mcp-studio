import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { account, NotPairedError, trusted, type Device } from "../relay";
import { Button, Dot, Header, s, tap } from "../legacy-ui";
import { colors } from "../theme";

export function Projects({ onOpen, onPair, onSettings, onUnpaired }: { onOpen: (d: Device) => void; onPair: () => void; onSettings: () => void; onUnpaired: (message: string) => void }) {
  const [list, setList] = useState<Device[] | null>(null);
  const [keys, setKeys] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setKeys(await trusted());
      setList((await account()).devices);
      setError(null);
    } catch (e) {
      if (e instanceof NotPairedError) return onUnpaired("The relay no longer knows this phone. Pair it again.");
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [onUnpaired]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <View style={s.page}>
      <Header
        title="Projects"
        right={
          <Pressable accessibilityRole="button" onPress={onSettings} hitSlop={8} style={tap}>
            <Text style={s.link}>Devices</Text>
          </Pressable>
        }
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
      <FlatList
        data={list ?? []}
        keyExtractor={(d) => d.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.panel} />}
        ListEmptyComponent={list ? <Text style={s.sub}>No project has connected yet. Turn on Remote in a project on your computer.</Text> : undefined}
        renderItem={({ item }) => {
          const paired = item.computerKey in keys;
          const status = !item.online ? `Last seen ${new Date(item.lastSeen).toLocaleString()}` : paired ? "Online" : "Online. Scan this computer's pairing code to open it here.";
          return (
            <Pressable style={s.row} disabled={!paired} onPress={() => onOpen(item)} accessibilityRole="button">
              <Dot state={item.online ? "on" : "off"} />
              <View style={{ flex: 1 }}>
                <Text style={[s.name, !paired && { color: colors.muted }]}>{item.name}</Text>
                <Text style={s.sub}>{status}</Text>
              </View>
              {paired ? <Text style={s.sub}>{"›"}</Text> : null}
            </Pressable>
          );
        }}
      />
      <Button title="Pair another computer" onPress={onPair} />
    </View>
  );
}
