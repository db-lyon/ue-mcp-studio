/**
 * The Arrangement's transport state that is not the arrangement itself: the
 * audition playing on the open editor (POST /v1/hub/play), read again on every
 * hub change and every quarter second while it plays, and Space to start or
 * stop it.
 */
import { useEffect, useRef, useState } from "react";
import type { AuditionState } from "ue-mcp/daemon";
import { auditionLive, auditionOf } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";

/** The audition of this arrangement, live or the last one; null when the last audition was of another. */
export function useAudition(id: string): { play: AuditionState | null; live: boolean; set: (p: AuditionState | null) => void } {
  const { data } = useHub();
  const [play, setPlay] = useState<AuditionState | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = () => {
    api.hub.playState().then((p) => alive.current && setPlay(p), () => undefined);
  };
  useEffect(read, [data.version]);
  const live = auditionLive(play);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(read, 250);
    return () => clearInterval(t);
  }, [live]);
  const mine = auditionOf(play, id) ? play : null;
  return { play: mine, live: live && !!mine, set: setPlay };
}

/** Space anywhere on the page but a text field calls `toggle`, as a DAW's transport does. */
export function useSpaceBar(toggle: () => void): void {
  const f = useRef(toggle);
  f.current = toggle;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      f.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}
