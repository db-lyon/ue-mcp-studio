/**
 * The agent settings ue-mcp owns, under /v1/ext/studio:
 *
 *   GET /agent-settings   the feedback tool, the feedback mode, the editor dialog mode, Playtest runs and the playtest loop's budget
 *   PUT /agent-settings   change them: { feedbackTool?, feedbackMode?, dialogMode?, playtestRuns?, playtestBudget? }
 *
 * The feedback tool is the `disable` list in ue-mcp.yml, which ue-mcp reads at
 * start, so changing it restarts ue-mcp (after the turn in progress). The modes
 * are this project's, as `ue-mcp feedback mode` and `ue-mcp dialog mode` set them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument, isSeq } from "yaml";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { AgentSettings, DialogMode, FeedbackMode, PlaytestRunsMode } from "@ue-mcp-studio/shared";
import { budgetOf, type PlaytestStore } from "./playtest-store.js";

const FEEDBACK_MODES: readonly FeedbackMode[] = ["interactive", "auto-approve", "defer"];
const DIALOG_MODES: readonly DialogMode[] = ["interactive", "auto", "defer"];

interface Modes {
  get(): { feedback: { mode: FeedbackMode; project: boolean }; dialog: { mode: DialogMode | null; project: boolean } };
  setFeedback(mode: FeedbackMode | undefined): void;
  setDialog(mode: DialogMode | undefined): void;
}

/** Whether ue-mcp.yml leaves the feedback tool on. */
export function feedbackToolOn(ymlText: string): boolean {
  const disabled = parseDocument(ymlText).toJS()?.disable;
  return !(Array.isArray(disabled) && disabled.includes("feedback"));
}

/** ue-mcp.yml with the feedback tool turned on or off, its comments and layout kept. */
export function withFeedbackTool(ymlText: string, on: boolean): string {
  const doc = parseDocument(ymlText || "{}\n");
  const list = doc.get("disable");
  const current = isSeq(list) ? (list.toJSON() as string[]) : [];
  const next = on ? current.filter((c) => c !== "feedback") : current.includes("feedback") ? current : [...current, "feedback"];
  if (next.length === 0) doc.delete("disable");
  else doc.set("disable", next);
  return doc.toString();
}

export function registerAgentSettings(api: DaemonExtensionApi, restartUeMcp: () => Promise<unknown>, playtests?: PlaytestStore): void {
  const modes = (api as unknown as { modes?: Modes }).modes;
  const yml = path.join(api.projectDir, "ue-mcp.yml");
  const read = (): string => (fs.existsSync(yml) ? fs.readFileSync(yml, "utf-8") : "");
  const view = (): AgentSettings => ({
    feedbackTool: feedbackToolOn(read()),
    feedbackMode: modes?.get().feedback ?? null,
    dialogMode: modes?.get().dialog ?? null,
    ...(playtests ? { playtestRuns: playtests.runs(), playtestBudget: playtests.budget() } : {}),
  });

  api.route("GET", "/agent-settings", () => ({ body: view() }));
  api.route("PUT", "/agent-settings", async (req) => {
    const b = (req.body ?? {}) as { feedbackTool?: unknown; feedbackMode?: unknown; dialogMode?: unknown; playtestRuns?: unknown; playtestBudget?: unknown };
    if (b.playtestRuns !== undefined && b.playtestRuns !== "manual" && b.playtestRuns !== "automatic") return { status: 400, body: { error: "playtestRuns must be manual or automatic" } };
    const budget = b.playtestBudget === undefined ? undefined : budgetOf(b.playtestBudget);
    if (typeof budget === "string") return { status: 400, body: { error: budget } };
    if (b.feedbackTool !== undefined && typeof b.feedbackTool !== "boolean") return { status: 400, body: { error: "feedbackTool must be a boolean" } };
    if (b.feedbackMode !== undefined && b.feedbackMode !== null && !FEEDBACK_MODES.includes(b.feedbackMode as FeedbackMode)) return { status: 400, body: { error: "feedbackMode must be interactive, auto-approve, defer or null" } };
    if (b.dialogMode !== undefined && b.dialogMode !== null && !DIALOG_MODES.includes(b.dialogMode as DialogMode)) return { status: 400, body: { error: "dialogMode must be interactive, auto, defer or null" } };
    if ((b.feedbackMode !== undefined || b.dialogMode !== undefined) && !modes) return { status: 409, body: { error: "This ue-mcp cannot set modes from Studio; update ue-mcp." } };
    if (b.feedbackMode !== undefined) modes!.setFeedback((b.feedbackMode as FeedbackMode | null) ?? undefined);
    if (b.dialogMode !== undefined) modes!.setDialog((b.dialogMode as DialogMode | null) ?? undefined);
    if (b.playtestRuns !== undefined) playtests?.setRuns(b.playtestRuns as PlaytestRunsMode);
    if (budget) playtests?.setBudget(budget);
    let restarting = false;
    if (typeof b.feedbackTool === "boolean" && b.feedbackTool !== feedbackToolOn(read())) {
      fs.writeFileSync(yml, withFeedbackTool(read(), b.feedbackTool));
      await restartUeMcp();
      restarting = true;
    }
    return { body: { ...view(), restarting } };
  });
}
