/**
 * Fix failing playtests with an agent: the setting (AgentSettings.agentFixes,
 * off by default) and the line a failure shows while it is off. Both clients
 * draw these words; the hub's Fix buttons show only while it is on.
 */
export const AGENT_FIXES_COPY = {
  setting: "Fix failing clips with an agent",
  help: "Each fix runs in its own chat session and keeps trying until every step passes or it hits a blocker that needs you, which can use many tokens with no one watching. Turning this off stops fixes in progress.",
  off: "Fixing with an agent is off.",
  turnOn: "Turn it on in Settings",
} as const;

/** The Settings section the setting is in. */
export const AGENT_FIXES_SECTION = "approvals";
