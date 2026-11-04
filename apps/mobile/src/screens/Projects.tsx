/**
 * The projects this phone can open, as the relay's project list draws them:
 * a row per project with whether it is online, the one opened last on the
 * accent wash, the paired ones opening on a press. Projects on a computer
 * this phone has not paired with say how to reach them.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl } from "react-native";
import { account, NotPairedError, selected, trusted, type Device } from "../relay";
import { Banner, Button, Dot, font, Loading, Panel, T, useTheme } from "../ui";
import { Chevron, ListCard, ListRow, Page, PageHead } from "./StudioPage";

/** "Offline, last seen 5 min ago": how long ago, in the largest whole unit. */
export function lastSeen(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "Offline";
  const ago = s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} ${Math.floor(s / 86_400) === 1 ? "day" : "days"} ago`;
  return `Offline, last seen ${ago}`;
}

export function Projects({ onOpen, onPair, onSettings, onUnpaired }: { onOpen: (d: Device) => void; onPair: () => void; onSettings: () => void; onUnpaired: (message: string) => void }) {
  const t = useTheme();
  const [list, setList] = useState<Device[] | null>(null);
  const [keys, setKeys] = useState<Record<string, unknown>>({});
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setKeys(await trusted());
      setLast((await selected().catch(() => null))?.id ?? null);
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

  // Online and paired first, then online elsewhere, then offline; the order the relay gave within each.
  const rank = (d: Device) => (d.online ? (d.computerKey in keys ? 0 : 1) : 2);
  const rows = list ? [...list].sort((a, b) => rank(a) - rank(b)) : null;

  return (
    <Page
      refreshControl={<RefreshControl refreshing={busy && list !== null} onRefresh={() => void load()} tintColor={t.c.accent} colors={[t.c.accent]} progressBackgroundColor={t.c.panel} />}
      actions={<Button title="Devices" variant="ghost" label="Paired devices" onPress={onSettings} />}
      footer={<Button title="Pair another computer" onPress={onPair} />}
    >
      <PageHead eyebrow="Projects" lead="Choose the project to open in Studio." />
      {error ? (
        <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </Banner>
      ) : null}
      {rows === null && !error ? <Loading>Loading your projects</Loading> : null}
      {rows?.length === 0 ? <Panel head="No projects yet" text="Turn on Remote in a project in Studio on your computer. It shows here once it connects." note="Pull down to check again." /> : null}
      {rows?.length ? (
        <ListCard>
          {rows.map((d) => {
            const paired = d.computerKey in keys;
            const sub = !d.online ? lastSeen(d.lastSeen) : !paired ? "On a computer this phone has not paired with. Scan its pairing code to open it here." : d.id === last ? "Opened last" : undefined;
            return (
              <ListRow
                key={d.id}
                current={paired && d.online && d.id === last}
                lead={<Dot kind={d.online ? "ok" : undefined} />}
                title={d.name}
                sub={sub}
                disabled={!paired}
                label={paired ? `Open ${d.name}` : d.name}
                onPress={() => onOpen(d)}
                right={paired ? <Chevron /> : null}
              />
            );
          })}
        </ListCard>
      ) : null}
      {rows?.length ? <T style={{ ...font(t, "sans", 400, 12, 1.3), color: t.c.dim, textAlign: "center" }}>Pull down to check again.</T> : null}
    </Page>
  );
}
