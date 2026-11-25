/**
 * Timeline playtests: every playtest clip in the project with its newest
 * run, and a new one by name. A row opens the clip on its timeline.
 */
import { useEffect, useState } from "react";
import type { ClipListEntry } from "@ue-mcp-studio/shared";
import { CLIP_COPY, HUB_COPY, hubHash } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { Empty, HubField, HubIcon, HubLink, Placeholder, ScreenHead } from "./parts";

export function ClipsScreen() {
  const { go } = useHub();
  const [clips, setClips] = useState<ClipListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    api.clips.list().then((r) => setClips(r.clips), (e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const create = async () => {
    const n = name.trim();
    if (!/^[A-Za-z0-9_]+$/.test(n)) return setNameError(CLIP_COPY.badName);
    setBusy(true);
    try {
      const { path } = await api.clips.create(n);
      go({ screen: "clip", path });
    } catch (e) {
      setNameError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const form = adding && (
    <form className="hub-clip-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <HubField id="clip-name" label={CLIP_COPY.nameLabel} error={nameError}>
        {(a) => <input {...a} autoFocus spellCheck={false} autoComplete="off" placeholder={CLIP_COPY.namePlaceholder} value={name} onChange={(e) => { setName(e.target.value); setNameError(undefined); }} />}
      </HubField>
      <button className="primary" type="submit" disabled={busy}>{busy ? CLIP_COPY.creating : CLIP_COPY.create}</button>
    </form>
  );

  return (
    <div className="hub-screen hub-clips">
      <ScreenHead
        back={{ label: HUB_COPY.library, route: { screen: "library" } }}
        title={CLIP_COPY.clips}
        sub={<span>{CLIP_COPY.lead}</span>}
        actions={!adding && <button className="primary" onClick={() => setAdding(true)}><HubIcon name="plus" size={12} /> {CLIP_COPY.newClip}</button>}
      />
      {form}
      {error && <div className="banner bad" role="alert">{error} <button className="small-button" onClick={load}>{CLIP_COPY.tryAgain}</button></div>}
      {!error && clips === null && <Placeholder rows={4} />}
      {clips && clips.length === 0 && !adding && (
        <Empty title={CLIP_COPY.empty} actions={<button className="primary" onClick={() => setAdding(true)}>{CLIP_COPY.newClip}</button>}>{CLIP_COPY.emptyBody}</Empty>
      )}
      {clips && clips.length > 0 && (
        <div className="hub-list">
          {clips.map((c) => {
            const last = c.last_run;
            const outcome = !last ? CLIP_COPY.neverRun : last.passed ? CLIP_COPY.passed : last.state === "running" ? CLIP_COPY.running : CLIP_COPY.failed;
            return (
              <HubLink key={c.path} className="hub-row" href={hubHash({ screen: "clip", path: c.path })} onGo={() => go({ screen: "clip", path: c.path })}>
                <span className="hub-row-main">
                  <strong>{c.name}</strong>
                  <span className="mono small dim">{c.path}</span>
                </span>
                <span className={`small hub-clip-outcome ${!last ? "dim" : last.passed ? "ok" : "bad"}`}>{outcome}</span>
              </HubLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
