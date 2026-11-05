/**
 * Paired devices: the account's paired phones and browsers, each removable,
 * and the computers this phone trusts, each forgettable. Removing this phone
 * signs it out of the relay and forgets every computer here.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { account, forgetComputer, removeViewer, trusted, type Device, type Viewer } from "../relay";
import { Button, font, Loading, T, useTheme } from "../ui";
import { Chevron, ListCard, ListRow, Page, RelayProblem, SectionLabel } from "./StudioPage";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Paired 4 Nov 2026", the same on every phone whatever its language. */
export const paired = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Paired" : `Paired ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

export function Settings({ onBack, onRemoved, onAbout }: { onBack: () => void; onRemoved: () => void; onAbout?: () => void }) {
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
      // What was last read stays; nothing is said to be empty that only failed to load.
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const remove = (v: Viewer) =>
    Alert.alert(v.current ? "Unpair this phone?" : `Remove ${v.label}?`, v.current ? "It stops reaching your projects until you pair it again." : "It stops reaching your projects until it is paired again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: v.current ? "Unpair" : "Remove",
        style: "destructive",
        onPress: () =>
          void removeViewer(v).then(
            () => (v.current ? onRemoved() : void load()),
            (e) => setError(String(e?.message ?? e)),
          ),
      },
    ]);

  const forgetKey = (key: string, name: string) =>
    Alert.alert(`Forget ${name.charAt(0).toLowerCase()}${name.slice(1)}?`,"This phone stops trusting that computer until you scan its pairing code again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => void forgetComputer(key).then(load) },
    ]);

  // A ghost button in the bad colour: removing is the one thing on these rows.
  const danger = (title: string, onPress: () => void, label: string) => (
    <Button variant="ghost" label={label} onPress={onPress}>
      <T style={t.editor ? { ...font(t, "sans", 400, 12, 1.2), color: t.c.bad } : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23, color: t.c.bad }}>{title}</T>
    </Button>
  );
  const trustedKeys = Object.entries(keys);

  return (
    <Page title="Paired devices" back="Projects" onBack={onBack}>
      <T style={{ color: t.c.dim }}>The phones and browsers that reach your projects, and the computers this phone trusts.</T>
      {error ? <RelayProblem error={error} note={viewers ? "The lists below are what this phone last read." : "The computers this phone trusts are below; the rest shows once the relay answers."} onRetry={() => void load()} /> : null}
      {viewers || !error ? <SectionLabel>Phones and browsers</SectionLabel> : null}
      {viewers === null && !error ? (
        <View style={{ alignItems: "center", paddingVertical: 12 }}>
          <Loading>Loading paired devices</Loading>
        </View>
      ) : null}
      {viewers ? (
        <ListCard>
          {viewers.length === 0 ? <ListRow title="None yet" sub="Phones and browsers you pair show here." /> : null}
          {viewers.map((v) => (
            <ListRow key={v.id} title={v.label} sub={v.current ? `This phone. ${paired(v.createdAt)}` : paired(v.createdAt)} right={v.current ? danger("Unpair", () => remove(v), "Unpair this phone") : danger("Remove", () => remove(v), `Remove ${v.label}`)} />
          ))}
        </ListCard>
      ) : null}
      <SectionLabel>Computers this phone trusts</SectionLabel>
      <ListCard>
        {trustedKeys.length === 0 ? <ListRow title="None yet" sub="A computer shows here once this phone has scanned its pairing code." /> : null}
        {trustedKeys.map(([key, info], i) => {
          // A computer has no name of its own at the relay: it is numbered, and its projects say which it is once the relay has answered.
          const name = trustedKeys.length > 1 ? `Computer ${i + 1}` : "Your computer";
          const names = devices.filter((d) => d.computerKey === key).map((d) => d.name);
          const line = { ...font(t, "sans", 400, 12, 1.3), color: t.c.dim };
          const sub = (
            <View>
              {names.length ? <T style={line}>{names.join(", ")}</T> : null}
              <T style={line}>{paired(info.pairedAt)}</T>
            </View>
          );
          return <ListRow key={key} title={name} sub={sub} right={danger("Forget", () => forgetKey(key, name), `Forget ${name}`)} />;
        })}
      </ListCard>
      {onAbout ? (
        <>
          <SectionLabel>This app</SectionLabel>
          <ListCard>
            <ListRow title="About" sub="Versions and compatibility" onPress={onAbout} right={<Chevron />} />
          </ListCard>
        </>
      ) : null}
    </Page>
  );
}
