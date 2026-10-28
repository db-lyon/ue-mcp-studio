import type { StatusReport } from "ue-mcp/daemon";

/**
 * What the Project panel says about each install problem ue-mcp reports.
 *
 * ue-mcp's own `what` and `fix` are written for an agent and name tool calls,
 * so the panel never shows `fix`, and shows `what` only for a code it does not
 * know yet. `action` names the button that fixes it, when the panel has one.
 */
export interface ProblemCopy {
  title: string;
  detail: string;
  action?: "rebuild" | "updates";
}

/** A source bridge deployed and not built yet; on a daemon with the "install.pendingBuild" feature. */
export interface PendingBuild {
  version: string;
  reason?: string;
  failed?: { at: string; message: string };
}

export function pendingBuildOf(report: StatusReport | null): PendingBuild | null {
  const pending = (report?.plugin as { pendingBuild?: PendingBuild | null } | undefined)?.pendingBuild;
  return pending && typeof pending.version === "string" ? pending : null;
}

export function problemCopy(problem: StatusReport["problems"][number], report: StatusReport): ProblemCopy {
  const p = report.plugin;
  const pending = pendingBuildOf(report);
  switch (problem.code) {
    case "no_engine":
      return {
        title: "Unreal Engine was not found.",
        detail: `No install of the engine this project uses (${report.project.engineAssociation ?? "unknown version"}) was found. Install it, or set editor.buildToolPath in ue-mcp.yml under Advanced.`,
      };
    case "no_toolchain":
      return {
        title: "No C++ compiler was found.",
        detail: "The bridge plugin is built from source on this machine, which needs the C++ tools Unreal uses. Install them, then check again.",
      };
    case "bridge_not_deployed":
      return {
        title: "The bridge plugin is not in this project.",
        detail: "Apply in Clients and tools setup below to install it.",
      };
    case "bridge_not_enabled":
      return {
        title: "The bridge plugin is not enabled.",
        detail: "It is in the project, but the project does not load it. Apply in Clients and tools setup below to enable it.",
      };
    case "bridge_version_mismatch":
      return {
        title: "The bridge plugin is a different version from ue-mcp.",
        detail: `The project has bridge ${p.installedVersion ?? "?"} and ue-mcp is ${p.packagedVersion ?? "?"}. Update it from Updates.`,
        action: "updates",
      };
    case "bridge_never_compiled":
      return {
        title: "The bridge plugin needs to be built.",
        detail: "It has never been built in this project, so the editor has no bridge to load. Rebuild builds it and opens the editor.",
        action: "rebuild",
      };
    case "bridge_build_stale":
      return {
        title: "The bridge plugin needs a rebuild.",
        detail: `${pending ? `ue-mcp updated the bridge to ${pending.version} while the editor was open, and the editor still runs the previous build.` : "Its source is newer than its last build, so the editor still runs the previous build."} Features added since then do not work until it is rebuilt.`,
        action: "rebuild",
      };
    default:
      return { title: problem.what, detail: "" };
  }
}

interface EditorStep {
  step: string;
  ok: boolean;
  result?: string;
  reason?: string;
}

const STEP: Record<string, "stop" | "build" | "start"> = {
  "editor.stop_editor": "stop",
  "project.build": "build",
  "editor.start_editor": "start",
};

/** The first failed step's reason: `reason` on a newer daemon, else the message inside its result. */
function stepReason(s: EditorStep): string {
  if (s.reason) return s.reason;
  try {
    const parsed = JSON.parse(s.result ?? "") as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON, or a payload followed by notes.
  }
  return (s.result ?? "").trim().slice(0, 1200) || "no detail";
}

/**
 * Text from ue-mcp with every sentence that names a tool call taken out, such
 * as "Stop it with editor(action='stop_editor')", which is advice to an agent.
 */
export function withoutToolCalls(text: string): string {
  const call = /\b[a-z_]+\((action=|[a-z_]+\))/i;
  return text
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !call.test(sentence))
    .join(" ")
    .trim();
}

export interface RebuildOutcome {
  ok: boolean;
  /** Whether the build step passed. */
  built: boolean;
  /** The step that failed and why. */
  failure?: { step: "stop" | "build" | "start" | "other"; reason: string };
}

/** What a daemon rebuild did, read from its steps. */
export function readRebuild(result: Record<string, unknown>): RebuildOutcome {
  const steps = (result.steps as EditorStep[] | undefined) ?? [];
  const failed = steps.find((s) => !s.ok);
  const built = steps.some((s) => s.step === "project.build" && s.ok);
  if (!failed) return steps.length > 0 ? { ok: true, built } : { ok: false, built, failure: { step: "other", reason: "The rebuild ran no steps." } };
  return { ok: false, built, failure: { step: STEP[failed.step] ?? "other", reason: withoutToolCalls(stepReason(failed)) } };
}
