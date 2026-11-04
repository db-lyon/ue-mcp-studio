/**
 * What an approval card says: the question for each kind of request, what
 * "Allow for this session" covers, and what an editor restart does.
 */
import type { ApprovalRequest } from "@ue-mcp-studio/shared";

const TITLE: Record<ApprovalRequest["tool"], string> = {
  shell: "Run this command?",
  write_file: "Write this file?",
  edit_file: "Make this edit?",
  editor_restart: "Restart the editor?",
  ue_mcp: "Run this action?",
};

/** The card's title for each editor operation. */
const OPERATION_TITLE: Record<NonNullable<ApprovalRequest["operation"]>, string> = {
  restart: "Restart the editor?",
  rebuild: "Rebuild and restart the editor?",
  stop: "Stop the editor?",
  start: "Start the editor?",
};

/** The card's question. */
export function approvalTitle(a: Pick<ApprovalRequest, "tool" | "creates" | "operation">): string {
  if (a.tool === "write_file" && a.creates) return "Create this file?";
  if (a.tool === "editor_restart") return OPERATION_TITLE[a.operation ?? "restart"];
  return TITLE[a.tool];
}

/** What "Allow for this session" covers, by the kind of request. */
export const APPROVAL_KIND: Record<ApprovalRequest["tool"], string> = {
  shell: "commands",
  write_file: "file changes",
  edit_file: "file changes",
  editor_restart: "editor starts, stops and restarts",
  ue_mcp: "ue-mcp actions that delete or overwrite",
};

/** An editor operation's card body: what it does, and that a close shows the editor's save prompt first. */
export function restartLine(operation: ApprovalRequest["operation"]): string {
  return `${RESTART_OPERATION[operation ?? "restart"]}.${operation === "start" ? "" : " Unsaved work gets the editor's save prompt first."}`;
}

export const RESTART_OPERATION: Record<NonNullable<ApprovalRequest["operation"]>, string> = {
  restart: "Restart the editor",
  rebuild: "Stop the editor, rebuild the project's C++ and start it again",
  stop: "Stop the editor",
  start: "Start the editor",
};
