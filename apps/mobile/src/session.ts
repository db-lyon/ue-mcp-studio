/**
 * One open session, kept in step with the daemon the way the web client keeps
 * it: hashed deltas through client-core's DetailLoader, refetched on the
 * session's events, with the turn's streamed text collected between them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailLoader, type StudioApi } from "@ue-mcp-studio/client-core";
import type { SessionDetail, StudioSettings, StudioSettingsUpdate } from "@ue-mcp-studio/shared";
import type { Project } from "./connection";

export interface SessionApi {
  send(text: string, now?: boolean): Promise<unknown>;
  queue(text: string): Promise<unknown>;
  removeQueued(qid: string): Promise<unknown>;
  sendQueued(): Promise<unknown>;
  stop(): Promise<unknown>;
  saveDraft(draft: string): Promise<unknown>;
}

export function useSession(project: Project, studio: StudioApi, id: string) {
  const { onEvent, live } = project;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamed = useRef("");

  const loader = useMemo(
    () =>
      new DetailLoader(
        (sid, have) => studio.sessionSync(sid, have),
        (d) => {
          setDetail(d);
          setError(null);
        },
        (e) => {
          if (e.name !== "AbortError") setError(e.message);
        },
      ),
    [studio],
  );
  const reload = useCallback(() => loader.load(id), [loader, id]);

  useEffect(() => {
    streamed.current = "";
    setStreaming("");
    void reload();
  }, [reload]);
  // Back from a drop: events may have been missed, so the whole session is asked for again.
  useEffect(() => {
    if (live !== "live") return;
    loader.reset();
    void reload();
  }, [live, loader, reload]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "gap") return void reload();
        if (!e.type.startsWith("studio.") || e.data.sessionId !== id) return;
        if (e.type === "studio.turn.delta") {
          streamed.current += String(e.data.text ?? "");
          setStreaming(streamed.current);
          return;
        }
        if (e.type === "studio.transcript.added") {
          streamed.current = "";
          setStreaming("");
        }
        void reload();
      }),
    [onEvent, id, reload],
  );

  const api: SessionApi = useMemo(() => {
    const after = <T,>(p: Promise<T>) => p.finally(() => void reload());
    return {
      send: (text, now = false) => after(studio.send(id, text, now)),
      queue: (text) => after(studio.queue(id, text)),
      removeQueued: (qid) => after(studio.removeQueued(id, qid)),
      sendQueued: () => after(studio.sendQueued(id)),
      stop: () => after(studio.stop(id)),
      saveDraft: (draft) => studio.saveDraft(id, draft),
    };
  }, [studio, id, reload]);

  return { detail, streaming, error, setError, reload, api };
}

/** The project's Studio settings (the selected model and effort), following settings events. */
export function useSettings(project: Project, studio: StudioApi) {
  const { onEvent } = project;
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const load = useCallback(() => studio.settings().then(setSettings, () => undefined), [studio]);
  useEffect(() => void load(), [load]);
  useEffect(() => onEvent((e) => void (e.type === "studio.settings.changed" && load())), [onEvent, load]);
  const save = useCallback(
    async (update: Pick<StudioSettingsUpdate, "provider" | "model" | "effort">) => {
      const next = await studio.saveSettings(update);
      setSettings(next);
      return next;
    },
    [studio],
  );
  return { settings, save, reload: load };
}
