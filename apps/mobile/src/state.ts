/**
 * The open project's daemon as the web client's views read it (its
 * apps/client-web/src/state.ts): health, refreshed on load and on every
 * editor, client or daemon event, whether the stream is up, and a bounded log
 * of recent events. Built from the project's own stream, so every view on the
 * phone sees the same daemon.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson, type StreamEvent } from "@ue-mcp-studio/client-core";
import type { RefusedExtension } from "@ue-mcp-studio/shared";
import type { Project } from "./connection";

const KEEP = 500;

export interface DaemonHealth {
  ok?: boolean;
  version: string;
  startedAt?: string;
  lastEventId?: number;
  projectRoot?: string;
  editors: Array<{ name: string; connected: boolean; port?: number; pid?: number | null; lastDisconnect?: string | null }>;
  extensions?: Array<{ name: string; version: string }>;
  refusedExtensions?: RefusedExtension[];
  features?: string[];
  ui?: string | null;
}

/** An event the daemon sent, as the web client's DaemonEvent. */
export type DaemonEvent = StreamEvent;

export interface DaemonState {
  health: DaemonHealth | null;
  error: string | null;
  streaming: boolean;
  events: DaemonEvent[];
  refresh(): void;
}

export function useDaemon(project: Project): DaemonState {
  const { transport, onEvent, live } = project;
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const inflight = useRef(false);

  const refresh = useCallback((): void => {
    if (inflight.current) return;
    inflight.current = true;
    requestJson<DaemonHealth>(transport, "GET", "/v1/health")
      .then(
        (h) => {
          setHealth({ ...h, editors: Array.isArray(h.editors) ? h.editors : [] });
          setError(null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => {
        inflight.current = false;
      });
  }, [transport]);

  useEffect(() => {
    refresh();
    return onEvent((e) => {
      setEvents((prev) => {
        const next = prev.length >= KEEP ? prev.slice(prev.length - KEEP + 1) : prev.slice();
        next.push(e);
        return next;
      });
      if (e.type.startsWith("editor.") || e.type.startsWith("client.") || e.type.startsWith("daemon.")) refresh();
    });
  }, [onEvent, refresh]);

  const streaming = live === "live";
  useEffect(() => {
    if (streaming) refresh();
  }, [streaming, refresh]);

  return { health, error, streaming, events, refresh };
}
