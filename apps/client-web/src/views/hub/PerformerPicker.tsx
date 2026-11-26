/**
 * The performer picker a track header opens: the players, then the actors
 * of the level the editor has open (pawns first, each with its class), read
 * from GET /hub/performers when it opens. The players stay listed when the
 * actors cannot be read, with the reason, so a track can always be given
 * one. It floats over the timelines at the opener, since the narrow header
 * clips what overflows it.
 */
import { useEffect, useRef, useState } from "react";
import { PERFORMER_COPY, performerGroups, performerId } from "@ue-mcp-studio/client-core";
import type { Performer, PerformerCandidate, PerformersView } from "@ue-mcp-studio/shared";

export interface PickerAt { left: number; top: number }

/** Where a picker opens under its opener, kept inside the window. */
export function pickerAt(el: HTMLElement): PickerAt {
  const r = el.getBoundingClientRect();
  const width = 300;
  return { left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 };
}

export function PerformerPicker({ at, title, current, load, onPick, onClose }: {
  at: PickerAt;
  title: string;
  current: Performer | null;
  load: () => Promise<PerformersView>;
  onPick: (c: PerformerCandidate) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PerformersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then((v) => live && setView(v), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest?.("[data-picker-opener]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    ref.current?.querySelector<HTMLButtonElement>("[aria-selected=true], button")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  const { players, actors } = performerGroups(view, current);
  const on = current ? performerId(current) : null;
  const item = (c: PerformerCandidate) => {
    const selected = performerId(c.performer) === on;
    return (
      <li key={performerId(c.performer)}>
        <button role="option" aria-selected={selected} className={`hub-perf-item ${selected ? "on" : ""}`} title={PERFORMER_COPY.takes(c.capabilities)} onClick={() => onPick(c)}>
          <span className={`hub-perf-kind kind-${c.performer.kind}`} aria-hidden="true">{PERFORMER_COPY.marker(c.performer)}</span>
          <span className="hub-perf-name">{c.performer.kind === "player" ? PERFORMER_COPY.name(c.performer) : c.label}</span>
          {c.performer.kind === "actor" && <span className="hub-perf-class dim">{[c.className, c.pawn ? PERFORMER_COPY.pawn : null].filter(Boolean).join(" · ")}</span>}
        </button>
      </li>
    );
  };
  return (
    <div ref={ref} className="hub-perf-pop" role="dialog" aria-label={title} style={{ left: at.left, top: at.top }}>
      <div className="hub-perf-group">{PERFORMER_COPY.players}</div>
      <ul role="listbox" aria-label={PERFORMER_COPY.players}>{players.map(item)}</ul>
      <div className="hub-perf-group">{PERFORMER_COPY.actors(view?.level ?? null)}</div>
      {actors.length > 0 && <ul role="listbox" aria-label={PERFORMER_COPY.actors(view?.level ?? null)}>{actors.map(item)}</ul>}
      {!view && !error && <p className="hub-perf-note dim small" role="status">{PERFORMER_COPY.loading}</p>}
      {error && <p className="hub-perf-note small" role="alert">{PERFORMER_COPY.failed(error)}</p>}
      {view?.reason && <p className="hub-perf-note dim small">{actors.length ? view.reason[0].toUpperCase() + view.reason.slice(1) : PERFORMER_COPY.noActors(view.reason)}</p>}
    </div>
  );
}
