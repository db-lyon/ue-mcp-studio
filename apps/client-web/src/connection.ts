/**
 * The panel's connection to ue-mcp. The state machine is shared with the
 * mobile app (client-core); what is left here reads the page itself.
 */
import { isRemotePage } from "@ue-mcp-studio/client-core";

export {
  ALIVE_GRACE_MS, ATTEMPT_MS, BACKOFF_MS, LOST_PAUSE_MS, MAX_ATTEMPTS, RECONNECT_MS, REMOTE_OFFLINE, REMOTE_QUIET_MS, REMOTE_RECONNECT_MS, CONN_QUIET_MS as QUIET_MS,
  REMOTE_UPDATES, RESTART_MS, UPDATE_RESTART_MS, WAKE_GRACE_MS, connected, elapsed, headline, isRemotePage, step, stoppingWhy, waking,
  type Conn, type ConnEvent, type Phase, type StepOptions,
} from "@ue-mcp-studio/client-core";

/**
 * Whether this page is a paired browser's. The visual QA harness sets
 * __studioRemotePage to show a paired browser's page from this computer.
 */
export function onRemotePage(): boolean {
  if (typeof window === "undefined") return false;
  const forced = (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage;
  return forced ?? isRemotePage(!!(window as unknown as { ue?: unknown }).ue, window.location.hostname);
}
