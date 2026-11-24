/**
 * chat/HubRecordLink.tsx: links to Playtest Hub records (web:
 * chat/HubRecordLink.tsx). While the hub is on, the shell provides what it
 * knows of the records and a way to open one; a link that names a playtest
 * then opens its card on the Playtests page, and a hub address the page.
 * The rules are client-core's (hubRecordRoute).
 */
import { createContext, useContext, type ReactNode } from "react";
import { Text } from "react-native";
import { HUB_RECORD_COPY, hubRecordRoute, type HubRecordIndex, type HubRoute } from "@ue-mcp-studio/client-core";
import { inlineCode, useTheme } from "../ui";

export interface HubRecords {
  /** What the phone knows of the records: the playtest list's scripts. Null until it has loaded, when only #/playtests addresses resolve. */
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

/** A link to a hub address around its own text; the text alone while the hub is off. */
export function HubRecordLink({ address, children }: { address: string; children: ReactNode }) {
  const record = useHubRecord(address);
  if (!record) return <>{children}</>;
  return <HubAnchor open={record.open}>{children}</HubAnchor>;
}

/** The link itself, drawn as an asset link is (code: the code chip with an accent underline). */
export function HubAnchor({ open, code = false, children }: { open: () => void; code?: boolean; children: ReactNode }) {
  const t = useTheme();
  const look = code
    ? { ...inlineCode(t), boxShadow: `inset 0 -1px 0 ${t.c.accentLine}` }
    : { color: t.c.accentHi, textDecorationLine: "underline" as const, textDecorationColor: t.c.accentLine };
  return (
    <Text accessibilityRole="link" accessibilityHint={HUB_RECORD_COPY.opensInHub} style={look} onPress={open}>
      {children}
    </Text>
  );
}
