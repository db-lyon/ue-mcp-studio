/**
 * Settings as any Studio wrote or sent them, each field that is missing or
 * not valid at its default. The agent reads its settings file through these;
 * the panel reads the settings route through them too, since the daemon may
 * serve this panel beside an older agent (#151).
 */
import {
  DEFAULT_USAGE,
  EFFORTS,
  IMAGE_EDGES,
  KEY_PROVIDER_IDS,
  MAX_DIALOG_MINUTES,
  MAX_SUBAGENTS_PER_TURN,
  SUBAGENT_MODES,
  UNLIMITED_SUBAGENTS,
  type DialogPolicy,
  type Effort,
  type ImageSize,
  type KeyProviderId,
  type SubagentMode,
  type UsageSettings,
} from "./index.js";
import { APPROVAL_KINDS, approvalRuleFits, migrateApprovals, type Approvals } from "./composer.js";

/** A worker model of a named vendor; null for the main model; undefined when it is neither. */
export const subagentModelOf = (v: unknown): UsageSettings["subagentModel"] | undefined => {
  if (v === null) return null;
  const m = v as { provider?: unknown; model?: unknown } | undefined;
  return m && KEY_PROVIDER_IDS.includes(m.provider as KeyProviderId) && typeof m.model === "string" && m.model.trim()
    ? { provider: m.provider as KeyProviderId, model: m.model.trim() }
    : undefined;
};

/** Workers at once: -1 for no limit, or 1 to the most; undefined when it is neither. */
export const subagentsPerTurnOf = (v: unknown): number | undefined =>
  v === UNLIMITED_SUBAGENTS || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SUBAGENTS_PER_TURN) ? (v as number) : undefined;

/** Stored usage settings; fields an earlier Studio kept there, such as contextStrategy and budgets, are dropped. */
export function usageOf(raw: unknown): UsageSettings {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    subagents: SUBAGENT_MODES.includes(u.subagents as SubagentMode) ? (u.subagents as SubagentMode) : DEFAULT_USAGE.subagents,
    subagentModel: subagentModelOf(u.subagentModel) ?? DEFAULT_USAGE.subagentModel,
    subagentEffort: EFFORTS.includes(u.subagentEffort as Effort) ? (u.subagentEffort as Effort) : DEFAULT_USAGE.subagentEffort,
    subagentsPerTurn: subagentsPerTurnOf(u.subagentsPerTurn) ?? DEFAULT_USAGE.subagentsPerTurn,
    projectInstructions: typeof u.projectInstructions === "boolean" ? u.projectInstructions : DEFAULT_USAGE.projectInstructions,
    imageSize: typeof u.imageSize === "string" && u.imageSize in IMAGE_EDGES ? (u.imageSize as ImageSize) : DEFAULT_USAGE.imageSize,
  };
}

/** A stored or requested dialog policy, or null when it is not one. */
export function dialogPolicyOf(v: unknown): DialogPolicy | null {
  if (!v || typeof v !== "object") return null;
  const p = v as { kind?: unknown; minutes?: unknown };
  if (p.kind === "wait") return { kind: "wait" };
  if ((p.kind === "agent" || p.kind === "safe") && typeof p.minutes === "number" && Number.isFinite(p.minutes)
    && p.minutes > 0 && p.minutes <= MAX_DIALOG_MINUTES) {
    return { kind: p.kind, minutes: p.minutes };
  }
  return null;
}

/** Stored approval rows; settings from before them keep what askBeforeChanges did. */
export function approvalsOf(raw: Record<string, unknown>): Approvals {
  const base = migrateApprovals(raw.askBeforeChanges !== false);
  const a = raw.approvals && typeof raw.approvals === "object" ? (raw.approvals as Record<string, unknown>) : null;
  if (!a) return base;
  return Object.fromEntries(APPROVAL_KINDS.map((k) => [k, approvalRuleFits(k, a[k]) ? a[k] : base[k]])) as Approvals;
}
