/**
 * What Studio brings to the Playtest Hub, which runs in ue-mcp's daemon.
 *
 * The hub (clips, arrangements, tests, suites, runs, the queue and the editor
 * lease) is ue-mcp's, and Studio is only a UI on its routes. It hands the hub
 * signals the daemon cannot see for itself, through api.hub.configure
 * (feature "hub"):
 *
 * - enabled: the Playtest Hub experiment's switch;
 * - inputAgeMs: how long since someone used this computer;
 * - agentCalls: the editor calls Studio's own agents have in flight, so the
 *   queue waits for them.
 */
import type { BusyCall as HubBusyCall, DaemonExtensionApi, HubClientOptions } from "ue-mcp/daemon";
import type { BusyState } from "@ue-mcp-studio/shared";

export interface HubBridgeOptions {
  api: DaemonExtensionApi;
  /** The Playtest Hub experiment's switch. */
  enabled: () => boolean;
  /** How long since someone used this computer; null when no window reports it. */
  inputAgeMs: () => number | null;
  /** What the editor is working on (BusyTracker): the calls Studio's agents have in flight are the hub's agentCalls. */
  busy: () => BusyState;
}

/** Whether the daemon offers the hub (its feature "hub"). */
export const offersHub = (api: DaemonExtensionApi): boolean => !!api.hub && (api.features ?? []).includes("hub");

/** The options Studio gives the hub. */
export function hubOptions(o: HubBridgeOptions): HubClientOptions {
  return {
    enabled: o.enabled,
    inputAgeMs: o.inputAgeMs,
    agentCalls: (): HubBusyCall[] => o.busy().calls.flatMap((c) => (c.source === "studio" ? [{ ...c, source: "agent" as const }] : [])),
  };
}

/** Give the daemon's hub Studio's signals. Returns the function that takes them back, or a no-op where the daemon has no hub. */
export function configureHub(o: HubBridgeOptions): () => void {
  if (!offersHub(o.api)) return () => {};
  return o.api.hub!.configure(hubOptions(o));
}
