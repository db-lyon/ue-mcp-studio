/**
 * One open project: its sealed transport behind the PIN lock guard, its live
 * event stream, and the lock state, for the screens to share. Coming back to
 * the foreground reconnects the stream and asks the lock again, since either
 * may have changed while the app slept.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createLock, fromUeMcp, STREAM_IDLE_MS, subscribeEvents, type Lock, type StreamEvent, type Transport } from "@ue-mcp-studio/client-core";
import { transportFor, type Device } from "./relay";

export type Live = "connecting" | "live" | "offline";

export interface Project {
  device: Device;
  transport: Transport;
  lock: Lock;
  live: Live;
  /** Why the stream last dropped, shown while offline. */
  dropCause: string | null;
  onEvent(listener: (e: StreamEvent) => void): () => void;
  /** Any answer from ue-mcp itself (not the relay saying the computer is away): it is up, whatever the stream says. */
  onAlive?(listener: (at: number) => void): () => void;
  /** Drop the event stream and open it again now. */
  reconnect?(): void;
}

/** A sleep longer than this gets a fresh stream on return, even if the old one looks open. */
const WAKE_REFRESH_MS = 30_000;

/** `transport` replaces the sealed one: the visual QA harness answers from fixtures through it. */
export function useProject(device: Device, override?: Transport): Project {
  const raw = useMemo(() => override ?? transportFor(device), [device, override]);
  const lock = useMemo(() => createLock(raw), [raw]);
  const aliveListeners = useRef(new Set<(at: number) => void>());
  const transport = useMemo<Transport>(() => {
    const guarded = lock.guard(raw);
    return async (method, path, options) => {
      const reply = await guarded(method, path, options);
      if (fromUeMcp(reply.status)) aliveListeners.current.forEach((l) => l(Date.now()));
      return reply;
    };
  }, [lock, raw]);
  const listeners = useRef(new Set<(e: StreamEvent) => void>());
  const kick = useRef<() => void>(() => undefined);
  const [live, setLive] = useState<Live>("connecting");
  const [dropCause, setDropCause] = useState<string | null>(null);

  useEffect(() => {
    void lock.refresh();
    const stream = subscribeEvents(
      transport,
      (e) => listeners.current.forEach((l) => l(e)),
      (on) => {
        setLive(on ? "live" : "offline");
        if (on) setDropCause(null);
      },
      { idleMs: STREAM_IDLE_MS, onDrop: setDropCause },
    );
    kick.current = () => stream.kick(true);
    let backgroundAt: number | null = null;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        backgroundAt ??= Date.now();
        return;
      }
      const slept = backgroundAt !== null && Date.now() - backgroundAt > WAKE_REFRESH_MS;
      backgroundAt = null;
      stream.kick(slept);
      void lock.refresh();
    });
    return () => {
      sub.remove();
      stream.stop();
    };
  }, [lock, transport]);

  const onEvent = useCallback((l: (e: StreamEvent) => void) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  const onAlive = useCallback((l: (at: number) => void) => {
    aliveListeners.current.add(l);
    return () => void aliveListeners.current.delete(l);
  }, []);
  const reconnect = useCallback(() => kick.current(), []);

  return { device, transport, lock, live, dropCause, onEvent, onAlive, reconnect };
}

export function useLockView(lock: Lock) {
  return useSyncExternalStore(lock.subscribe, lock.view);
}
