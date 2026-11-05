/**
 * Another project installed a newer Studio than this project uses
 * (apps/client-web views/VersionNotice.tsx, ue-mcp#1619). Moving versions runs
 * from Studio on the computer, so a phone says what changed, with no buttons.
 */
import { useEffect, useState } from "react";
import { HttpError, REMOTE_UPDATES, type StudioVersionNotice } from "@ue-mcp-studio/client-core";
import { Banner, Button, T, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import type { DaemonState } from "../state";

/** How often the notice is read again: another project can install a version at any time. */
export const NOTICE_POLL_MS = 5 * 60_000;

/** The banner under the bar: `.app > .banner` at phone width. */
export const SHELL_BANNER = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 10, marginTop: 6, marginHorizontal: 6, marginBottom: 0 };

export function VersionNoticeLine({ notice, onUpdate, onKeep, busy, error, remote = true }: {
  notice: StudioVersionNotice;
  /** A paired client: says what changed, with no buttons, since moving versions runs on the computer. */
  remote?: boolean;
  onUpdate: () => void;
  onKeep: () => void;
  busy: "update" | "keep" | null;
  error: string | null;
}) {
  const t = useTheme();
  return (
    <Banner kind="warn" role="status" style={SHELL_BANNER}>
      <T style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, color: t.c.warnText }}>
        Studio {notice.installed} is installed on this computer. This project uses {notice.current}.
        {error ? <T style={{ color: t.c.dim }}> {error}</T> : null}
        {remote ? <T style={{ color: t.c.dim }}> {REMOTE_UPDATES}</T> : null}
      </T>
      {!remote ? (
        <>
          <Button title={busy === "update" ? "Updating" : "Update this project"} variant="primary" disabled={busy !== null} onPress={onUpdate} />
          <Button title={`Keep ${notice.current}`} disabled={busy !== null} onPress={onKeep} />
        </>
      ) : null}
    </Banner>
  );
}

export function VersionNotice({ daemon }: { daemon: DaemonState }) {
  const { api } = useProjectNav();
  const [notice, setNotice] = useState<StudioVersionNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!daemon.streaming) return;
    let live = true;
    const read = () =>
      api.versionNotice().then(
        (r) => live && setNotice(r.notice),
        (e) => {
          if (live && !(e instanceof HttpError && e.status === 404)) setError((e as Error).message);
        },
      );
    void read();
    const t = setInterval(read, NOTICE_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [daemon.streaming, api]);

  if (!notice) return null;
  return <VersionNoticeLine notice={notice} onUpdate={() => undefined} onKeep={() => undefined} busy={null} error={error} remote />;
}
