/**
 * The project's last 500 daemon events, kept from the moment the project
 * opens, as client-web's useDaemon keeps them for its Diagnostics log. The
 * shell starts it when a project opens (useEventLog in the project's root);
 * Diagnostics reads it.
 */
import { useSyncExternalStore } from "react";
import type { StreamEvent } from "@ue-mcp-studio/client-core";
import type { Project } from "../../connection";

const KEEP = 500;

interface Log {
  events: StreamEvent[];
  listeners: Set<() => void>;
  stop: () => void;
}

const logs = new WeakMap<Project["onEvent"], Log>();

function logOf(project: Project): Log {
  let log = logs.get(project.onEvent);
  if (!log) {
    const made: Log = { events: [], listeners: new Set(), stop: () => undefined };
    made.stop = project.onEvent((e) => {
      made.events = [...made.events, e].slice(-KEEP);
      for (const l of made.listeners) l();
    });
    logs.set(project.onEvent, made);
    log = made;
  }
  return log;
}

/** The events so far, newest last; keeps recording for as long as the project is open. */
export function useEventLog(project: Project): StreamEvent[] {
  const log = logOf(project);
  return useSyncExternalStore(
    (l) => {
      log.listeners.add(l);
      return () => void log.listeners.delete(l);
    },
    () => log.events,
    () => log.events,
  );
}
