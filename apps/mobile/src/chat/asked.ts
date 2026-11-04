import { createContext, useContext } from "react";

/** The open session's tool call ids waiting for the user's approval, so a subagent running one shows it waits on the user. */
export const AskedContext = createContext<ReadonlySet<string>>(new Set());

export const useAsked = (): ReadonlySet<string> => useContext(AskedContext);
