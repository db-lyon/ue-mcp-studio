/**
 * App-wide state rebuilt from the daemon: health, refreshed on load and on
 * every editor or client event, and a bounded log of recent events. The page
 * keeps nothing the daemon does not have, so a reload lands where it was.
 */
import { useEffect, useRef, useState } from "react";
import type { DaemonEvent, DaemonHealth } from "ue-mcp/daemon";
import { api, subscribeEvents } from "./api";

const KEEP = 500;

export interface DaemonState {
  health: DaemonHealth | null;
  error: string | null;
  streaming: boolean;
  events: DaemonEvent[];
  refresh(): void;
}

export function useDaemon(): DaemonState {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const inflight = useRef(false);

  const refresh = (): void => {
    if (inflight.current) return;
    inflight.current = true;
    api.health().then(
      (h) => {
        setHealth(h);
        setError(null);
      },
      (e: Error) => setError(e.message),
    ).finally(() => {
      inflight.current = false;
    });
  };

  useEffect(() => {
    refresh();
    return subscribeEvents(
      (e) => {
        setEvents((prev) => {
          const next = prev.length >= KEEP ? prev.slice(prev.length - KEEP + 1) : prev.slice();
          next.push(e);
          return next;
        });
        if (e.type.startsWith("editor.") || e.type.startsWith("client.") || e.type.startsWith("daemon.")) refresh();
      },
      (connected) => {
        setStreaming(connected);
        if (connected) refresh();
      },
    );
  }, []);

  return { health, error, streaming, events, refresh };
}
