/**
 * The daemon keeps one busy check per extension, and the last setBusy wins.
 * Studio has several sources (turns, remote control), so each part gets an api
 * whose setBusy adds a source, and the daemon sees any of them.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";

export function shareBusy(api: DaemonExtensionApi): DaemonExtensionApi {
  const sources: Array<() => boolean> = [];
  api.setBusy(() => sources.some((s) => s()));
  const setBusy = (busy: () => boolean): void => void sources.push(busy);
  return new Proxy(api, { get: (target, prop, receiver) => (prop === "setBusy" ? setBusy : Reflect.get(target, prop, receiver)) });
}
