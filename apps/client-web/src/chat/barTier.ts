import { createContext, useContext } from "react";
import type { BarTier } from "@ue-mcp-studio/client-core";

// The tiers themselves are client-core's, shared with the mobile app's composer.
export { BAR_TIERS, atMost, barTier, type BarTier } from "@ue-mcp-studio/client-core";

export const BarTierContext = createContext<BarTier>("full");

/** The composer bar's tier, for a control inside it; full anywhere else. */
export const useBarTier = (): BarTier => useContext(BarTierContext);
