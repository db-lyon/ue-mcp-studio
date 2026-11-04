/**
 * Paired devices: the account's paired phones and browsers, each removable,
 * and the computers this phone trusts, each forgettable. Removing this phone
 * signs it out of the relay and forgets every computer here.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { account, forgetComputer, removeViewer, trusted, type Device, type Viewer } from "../relay";
import { Banner, Button, font, Spinner, T, useTheme } from "../ui";
import { ListCard, ListRow, Page, PageHead, SectionLabel } from "./StudioPage";

export function Settings({ onBack, onRemoved }: { onBack: () => void; onRemoved: () => void }) {
  const t = useTheme();
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

  const danger = (title: string, onPress: () => void, label: string) => (
    <Button variant="ghost" size="small" label={label} onPress={onPress}>
      <T style={{ ...font(t, t.editor ? "sans" : "mono", 500, t.editor ? 12 : 11.5, 1.2), color: t.c.bad }}>{title}</T>
    </Button>
  );
  const trustedKeys = Object.entries(keys);

  return (
    <Page>
      <PageHead title="Paired devices" lead="The phones and browsers that reach your projects, and the computers this phone trusts." back="Projects" onBack={onBack} />
      {error ? (
        <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </Banner>
      ) : null}
      <SectionLabel>Paired phones and browsers</SectionLabel>
      <ListCard>
        {viewers === null ? (
          <View style={{ padding: 14 }}>
            <Spinner />
          </View>
        ) : null}
        {viewers?.length === 0 ? <ListRow first title="None" /> : null}
        {viewers?.map((v, i) => (
          <ListRow key={v.id} first={i === 0} title={`${v.label}${v.current ? " (this phone)" : ""}`} sub={`Paired ${new Date(v.createdAt).toLocaleDateString()}`} right={danger("Remove", () => remove(v), v.current ? "Remove this phone" : `Remove ${v.label}`)} />
        ))}
      </ListCard>
      <SectionLabel>Computers this phone trusts</SectionLabel>
      <ListCard>
        {trustedKeys.length === 0 ? <ListRow first title="None" /> : null}
        {trustedKeys.map(([key, info], i) => {
          const names = devices.filter((d) => d.computerKey === key).map((d) => d.name);
          const name = names.length ? names.join(", ") : "A computer";
          return <ListRow key={key} first={i === 0} title={name} sub={`Paired ${new Date(info.pairedAt).toLocaleDateString()}`} right={danger("Forget", () => forgetKey(key, name), `Forget ${name}`)} />;
        })}
      </ListCard>
    </Page>
  );
}
