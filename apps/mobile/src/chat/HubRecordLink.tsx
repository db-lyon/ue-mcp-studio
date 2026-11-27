/**
 * chat/HubRecordLink.tsx: links to Playtest Hub screens (web:
 * chat/HubRecordLink.tsx). The phone has no hub screens, so the shell
 * provides no way to open one and a #/playtests link is its text alone; a
 * client that can open the hub provides HubRecordsContext.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Text } from "react-native";
import { hubAddressRoute, type HubRoute } from "@ue-mcp-studio/client-core";
import { inlineCode, useTheme } from "../ui";

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

/** A link to a hub address around its own text; the text alone where the hub cannot open. */
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
    <Text accessibilityRole="link" accessibilityHint="Opens in the Playtest Hub" style={look} onPress={open}>
      {children}
    </Text>
  );
}
