import { createContext, useContext } from "react";
import type { SessionAgent } from "@ue-mcp-studio/shared";

/** The open session's tool call ids waiting for the user's approval, so a call held for it is drawn on its own line. */
export const AskedContext = createContext<ReadonlySet<string>>(new Set());

export const useAsked = (): ReadonlySet<string> => useContext(AskedContext);

/** The open session's subagents as the daemon sent them, by agent call id: the only source of their state. */
export const AgentsContext = createContext<ReadonlyMap<string, SessionAgent>>(new Map());

export const useAgents = (): ReadonlyMap<string, SessionAgent> => useContext(AgentsContext);
