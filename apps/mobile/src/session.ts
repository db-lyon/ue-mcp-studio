/**
 * One open session, kept in step with the daemon the way the web client keeps
 * it: hashed deltas through client-core's DetailLoader, refetched on the
 * session's events, with the turn's streamed text collected between them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailLoader, requestJson } from "@ue-mcp-studio/client-core";
import type { SessionDetail, SessionSync, StudioSettings } from "@ue-mcp-studio/shared";
import type { Project } from "./connection";

const sessionPath = (id: string) => `/v1/ext/studio/sessions/${encodeURIComponent(id)}`;

export interface SessionApi {
  send(text: string, now?: boolean): Promise<unknown>;
  queue(text: string): Promise<unknown>;
  removeQueued(qid: string): Promise<unknown>;
  sendQueued(): Promise<unknown>;
  stop(): Promise<unknown>;
  saveDraft(draft: string): Promise<unknown>;
}

export function useSession(project: Project, id: string) {
  const { transport, onEvent, live } = project;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamed = useRef("");

  const loader = useMemo(
    () =>
      new DetailLoader(
        (sid, have) => requestJson<SessionSync | SessionDetail>(transport, "GET", `${sessionPath(sid)}?sync=1${have !== undefined ? `&have=${have}` : ""}`),
        (d) => {
          setDetail(d);
          setError(null);
        },
        (e) => {
          if (e.name !== "AbortError") setError(e.message);
        },
      ),
    [transport],
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
    const post = (sub: string, json?: unknown) => requestJson(transport, "POST", `${sessionPath(id)}${sub}`, json !== undefined ? { json } : {});
    const after = <T,>(p: Promise<T>) => p.finally(() => void reload());
    return {
      send: (text, now = false) => after(post("/messages", now ? { text, attachments: [], now } : { text, attachments: [] })),
      queue: (text) => after(post("/queue", { text, attachments: [] })),
      removeQueued: (qid) => after(requestJson(transport, "DELETE", `${sessionPath(id)}/queue/${encodeURIComponent(qid)}`)),
      sendQueued: () => after(post("/queue/next")),
      stop: () => after(post("/stop")),
      saveDraft: (draft) => requestJson(transport, "PUT", `${sessionPath(id)}/draft`, { json: { draft } }),
    };
  }, [transport, id, reload]);

  return { detail, streaming, error, setError, reload, api };
}

/** The project's Studio settings (the selected model and effort), following settings events. */
export function useSettings(project: Project) {
  const { transport, onEvent } = project;
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const load = useCallback(() => requestJson<StudioSettings>(transport, "GET", "/v1/ext/studio/settings").then(setSettings, () => undefined), [transport]);
  useEffect(() => void load(), [load]);
  useEffect(() => onEvent((e) => void (e.type === "studio.settings.changed" && load())), [onEvent, load]);
  const save = useCallback(
    async (update: Partial<Pick<StudioSettings, "provider" | "model" | "effort">>) => {
      const next = await requestJson<StudioSettings>(transport, "PUT", "/v1/ext/studio/settings", { json: update });
      setSettings(next);
      return next;
    },
    [transport],
  );
  return { settings, save, reload: load };
}
