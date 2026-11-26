/**
 * Clips: both kinds, searched by the daemon. Drawn in the Arrangement's
 * drawer and in the Clips window it pops out. A clip is dragged onto a
 * timeline, picked with a click (for I and R), added to the selected track at
 * the playhead with a double-click or its Add button, as a DAW's browser
 * loads a clip, and opened from its Open button.
 */
import { useEffect, useState } from "react";
import { INSTANCE_STATUS_LOOK, SET_COPY, arrangeSeconds } from "@ue-mcp-studio/client-core";
import type { HubClipEntry, InstanceKind } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { HubIcon, StatusMark } from "./parts";
import type { ClipRef } from "./arrangement-sync";

/** What a clip dragged from Clips carries. */
export const CLIP_MIME = "application/x-ue-mcp-clip";

export function ClipBrowser({ picked, onPick, onOpen, onAdd, addsTo, version = 0, variant }: {
  picked: ClipRef | null;
  onPick: (c: HubClipEntry | null) => void;
  onOpen: (c: HubClipEntry) => void;
  onAdd: (c: HubClipEntry) => void;
  /** Where Add puts a clip, for its tooltip. */
  addsTo: string;
  /** Read Clips again when this changes: a run or an edit may have changed them. */
  version?: number;
  variant: "drawer" | "window";
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<InstanceKind | undefined>(undefined);
  const [clips, setClips] = useState<HubClipEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.set.clips(q.trim(), kind).then((a) => {
        if (!live) return;
        setClips(a.clips);
        setError(null);
      }, (e: Error) => live && setError(e.message));
    }, q ? 200 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, kind, version]);
  const kinds: Array<[InstanceKind | undefined, string]> = [[undefined, SET_COPY.kindAll], ["clip", SET_COPY.kindClip], ["script", SET_COPY.kindScript]];
  return (
    <section className={`hub-set-browser in-${variant}`} aria-label={SET_COPY.clips}>
      <div className="hub-set-browser-find">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={SET_COPY.search} aria-label={SET_COPY.search} />
        <div className="seg" role="group" aria-label={SET_COPY.clipType}>
          {kinds.map(([k, label]) => <button key={label} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
        </div>
        <p className="hub-set-browser-hint dim small">{SET_COPY.browserHint}</p>
      </div>
      <div className="hub-set-browser-list">
        {error && <p className="banner warn small" role="alert">{error}</p>}
        {clips && !clips.length && <p className="dim small">{SET_COPY.noClips}</p>}
        <ul className="hub-set-clips">
          {(clips ?? []).map((c) => {
            const on = picked?.target === c.target && picked.kind === c.kind;
            return (
              <li key={`${c.kind}:${c.target}`} className={`hub-set-clip-row kind-${c.kind} ${on ? "on" : ""}`}>
                <button className="hub-set-clip" aria-pressed={on} draggable title={c.target}
                  onClick={() => onPick(on ? null : c)}
                  onDoubleClick={() => onAdd(c)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(CLIP_MIME, JSON.stringify({ kind: c.kind, target: c.target }));
                    e.dataTransfer.setData("text/plain", c.target);
                    e.dataTransfer.effectAllowed = "copy";
                  }}>
                  <span className="hub-set-clip-kind" aria-hidden="true" />
                  <span className="hub-set-clip-name">{c.name}</span>
                  <span className="hub-set-clip-meta dim small">{c.kind === "clip" ? SET_COPY.kindClip : SET_COPY.kindScript}{c.length ? `, ${arrangeSeconds(c.length, c.rate || 60)}` : ""}</span>
                  {c.lastRun && <StatusMark look={INSTANCE_STATUS_LOOK[c.lastRun.outcome === "passed" ? "passed" : c.lastRun.outcome === "failed" ? "failed" : "skipped"]} size={10} />}
                </button>
                <button className="hub-set-clip-act ghost icon-button" aria-label={SET_COPY.add(c.name)} title={addsTo} onClick={() => onAdd(c)}><HubIcon name="plus" size={11} /></button>
                <button className="hub-set-clip-act ghost icon-button" aria-label={SET_COPY.openClip(c.name)} title={SET_COPY.openClip(c.name)} onClick={() => onOpen(c)}><HubIcon name="external" size={11} /></button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
