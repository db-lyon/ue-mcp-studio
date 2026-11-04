/**
 * The projects this phone can open, as the relay's project list draws them:
 * a row per project with whether it is online, the one opened last on the
 * accent wash, the paired ones opening on a press. Projects on a computer
 * this phone has not paired with say how to reach them.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, View } from "react-native";
import { account, NotPairedError, selected, trusted, type Device } from "../relay";
import { Button, Dot, font, Loading, Panel, T, useTheme } from "../ui";
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
      footer={rows !== null || error ? <Button title="Pair another computer" onPress={onPair} /> : undefined}
    >
      <PageHead eyebrow="Projects" lead={rows?.length === 0 ? undefined : "Choose the project to open in Studio."} />
      {error ? (
        <Panel
          bad
          head="Could not reach the relay"
          text={error}
          note="This page checks again every 10 seconds."
          actions={<Button title="Try again" variant="primary" onPress={() => void load()} />}
        />
      ) : null}
      {rows === null && !error ? (
        <View style={{ alignItems: "center", paddingTop: 24 }}>
          <Loading>Loading your projects</Loading>
        </View>
      ) : null}
      {rows?.length === 0 ? <Panel head="No projects yet" text="Turn on Remote control for a project in Studio on your computer. It shows here once it connects." note="Pull down to check again." /> : null}
      {rows?.length ? (
        <ListCard>
          {rows.map((d) => {
            const paired = d.computerKey in keys;
            // A project on a computer this phone has not paired with opens the scanner: its code is the way in.
            if (!paired)
              return (
                <ListRow
                  key={d.id}
                  lead={<Dot />}
                  title={d.name}
                  sub={d.online ? "Not paired with this phone. Scan its computer's code to open it." : lastSeen(d.lastSeen)}
                  label={`Scan the code for ${d.name}`}
                  onPress={onPair}
                  right={<T style={t.editor ? { ...font(t, "sans", 400, 12, 1.2), color: t.c.accent } : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23, color: t.c.accentHi }}>Scan code</T>}
                />
              );
            return (
              <ListRow
                key={d.id}
                current={d.online && d.id === last}
                lead={<Dot kind={d.online ? "ok" : undefined} />}
                title={d.name}
                sub={!d.online ? lastSeen(d.lastSeen) : d.id === last ? "Opened last" : undefined}
                label={`Open ${d.name}`}
                onPress={() => onOpen(d)}
                right={<Chevron />}
              />
            );
          })}
        </ListCard>
      ) : null}
      {rows?.length ? <T style={{ ...font(t, "sans", 400, 12, 1.3), color: t.c.dim, textAlign: "center" }}>Pull down to check again.</T> : null}
    </Page>
  );
}
