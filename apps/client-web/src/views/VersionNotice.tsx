/**
 * Another project installed a newer Studio than this project uses
 * (ue-mcp#1619). Update this project moves it to that version through the
 * Studio update step; Keep hides the notice until a newer version arrives.
 * Nothing changes on its own.
 */
import { useEffect, useState } from "react";
import { api, notThere, type StudioVersionNotice } from "../api";
import type { DaemonState } from "../state";

/** How often the notice is read again: another project can install a version at any time. */
export const NOTICE_POLL_MS = 5 * 60_000;

export function VersionNoticeLine({ notice, onUpdate, onKeep, busy, error }: {
  notice: StudioVersionNotice;
  onUpdate: () => void;
  onKeep: () => void;
  busy: "update" | "keep" | null;
  error: string | null;
}) {
  return (
    <div className="banner warn editor-banner version-notice" role="status">
      <span className="editor-banner-text">
        Studio {notice.installed} was installed by another project. This project uses {notice.current}.
        {error && <span className="dim"> {error}</span>}
      </span>
      <button className="primary" disabled={busy !== null} onClick={onUpdate}>{busy === "update" ? "Updating" : "Update this project"}</button>
      <button disabled={busy !== null} onClick={onKeep}>Keep {notice.current}</button>
    </div>
  );
}

export function VersionNotice({ daemon }: { daemon: DaemonState }) {
  const [notice, setNotice] = useState<StudioVersionNotice | null>(null);
  const [busy, setBusy] = useState<"update" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!daemon.streaming) return;
    let live = true;
    const read = () => api.versionNotice().then((r) => live && setNotice(r.notice), (e) => { if (!notThere(e) && live) setError((e as Error).message); });
    read();
    const t = setInterval(read, NOTICE_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [daemon.streaming]);

  if (!notice) return null;
  const update = () => {
    setBusy("update");
    setError(null);
    // The daemon restarts on the new version; the page reconnects to it.
    api.useInstalledStudio(notice.installed).catch((e: Error) => {
      setError(e.message);
      setBusy(null);
    });
  };
  const keep = () => {
    setBusy("keep");
    setError(null);
    api.keepStudio(notice.installed).then((r) => setNotice(r.notice), (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  return <VersionNoticeLine notice={notice} onUpdate={update} onKeep={keep} busy={busy} error={error} />;
}
