/**
 * Links to Playtest Hub records. While the hub is on, the app provides what
 * it knows of the hub's records and a way to open one; a link that names a
 * playtest, goal, milestone or run then opens it on the Playtests tab. The
 * rules are client-core's (hubRecordRoute).
 */
import { createContext, useContext, type ReactNode } from "react";
import { HUB_RECORD_COPY, hubHash, hubRecordRoute, type HubRecordIndex, type HubRoute } from "@ue-mcp-studio/client-core";

export interface HubRecords {
  /** What the hub knows; null while the hub is off or its overview has not loaded, when only #/playtests addresses resolve. */
  index: HubRecordIndex | null;
  open: (route: HubRoute) => void;
}

export const HubRecordsContext = createContext<HubRecords | null>(null);

/** The hub screen a link target names and the way to open it, or null for a link that keeps its own behaviour. */
export function useHubRecord(target: string | null | undefined): { route: HubRoute; open: () => void } | null {
  const records = useContext(HubRecordsContext);
  if (!records) return null;
  const route = hubRecordRoute(target, records.index);
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
      title={HUB_RECORD_COPY.opensInHub}
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
