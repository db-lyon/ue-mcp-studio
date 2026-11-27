/**
 * Links to Playtest Hub screens. While the hub is on, the app provides a way
 * to open one; a #/playtests/... link in a reply then opens it on the
 * Playtests tab. The address rules are client-core's (hubAddressRoute).
 */
import { createContext, useContext, type ReactNode } from "react";
import { hubAddressRoute, hubHash, type HubRoute } from "@ue-mcp-studio/client-core";

export interface HubRecords {
  open: (route: HubRoute) => void;
}

export const HubRecordsContext = createContext<HubRecords | null>(null);

/** The hub screen a link target names and the way to open it, or null for a link that keeps its own behaviour. */
export function useHubRecord(target: string | null | undefined): { route: HubRoute; open: () => void } | null {
  const records = useContext(HubRecordsContext);
  if (!records || !target) return null;
  const route = hubAddressRoute(target);
  return route ? { route, open: () => records.open(route) } : null;
}

/** A link to a hub screen around its own text. Without the app's hub (a page with no tabs) it is the text alone. */
export function HubRecordLink({ address, children, code = false }: { address: string; children: ReactNode; code?: boolean }) {
  const record = useHubRecord(address);
  if (!record) return <>{children}</>;
  return <HubAnchor route={record.route} open={record.open} code={code}>{children}</HubAnchor>;
}

/** The anchor itself: a real href, so a middle click or Copy link has the address. */
export function HubAnchor({ route, open, code, children }: { route: HubRoute; open: () => void; code?: boolean; children: ReactNode }) {
  return (
    <a
      className={`asset-link hub-record-link${code ? " code" : ""}`}
      href={hubHash(route)}
      title="Opens in the Playtest Hub"
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open();
      }}
    >
      {children}
    </a>
  );
}
