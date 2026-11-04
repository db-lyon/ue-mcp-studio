/**
 * The projects this phone can open, in Studio's design language: each
 * computer's project with whether it is online, the paired ones opening on a
 * press. The relay's own projects page is its counterpart in a browser.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl } from "react-native";
import { account, NotPairedError, trusted, type Device } from "../relay";
import { Banner, Button, Dot, T, useTheme } from "../ui";
import { Chevron, ListCard, ListRow, Page, PageHead } from "./StudioPage";

export function Projects({ onOpen, onPair, onSettings, onUnpaired }: { onOpen: (d: Device) => void; onPair: () => void; onSettings: () => void; onUnpaired: (message: string) => void }) {
  const t = useTheme();
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
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Page
      refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={t.c.accent} colors={[t.c.accent]} progressBackgroundColor={t.c.panel} />}
      footer={<Button title="Pair another computer" onPress={onPair} />}
    >
      <PageHead title="Your projects" lead="The projects on your paired computers that have Remote on." actions={<Button title="Devices" variant="ghost" onPress={onSettings} />} />
      {error ? (
        <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </Banner>
      ) : null}
      <ListCard>
        {list === null ? <ListRow first title="Loading" /> : null}
        {list?.length === 0 ? (
          <ListRow first title="No projects yet" sub="No project has connected yet. Turn on Remote in a project on your computer." />
        ) : null}
        {list?.map((d, i) => {
          const paired = d.computerKey in keys;
          const status = !d.online ? `Last seen ${new Date(d.lastSeen).toLocaleString()}` : paired ? "Online" : "Online. Scan this computer's pairing code to open it here.";
          return (
            <ListRow
              key={d.id}
              first={i === 0}
              lead={<Dot kind={d.online ? "ok" : undefined} />}
              title={d.name}
              sub={status}
              disabled={!paired}
              onPress={() => onOpen(d)}
              right={paired ? <Chevron /> : null}
            />
          );
        })}
      </ListCard>
      {list?.length ? <T style={{ color: t.c.dim, fontSize: 12 }}>Pull down to check again.</T> : null}
    </Page>
  );
}
