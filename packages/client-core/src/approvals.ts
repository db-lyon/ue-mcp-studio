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

/** The card's question. */
export function approvalTitle(a: Pick<ApprovalRequest, "tool" | "creates" | "operation">): string {
  if (a.tool === "write_file" && a.creates) return "Create this file?";
  if (a.tool === "editor_restart" && a.operation === "rebuild") return "Rebuild and restart the editor?";
  return TITLE[a.tool];
}

/** What "Allow for this session" covers, by the kind of request. */
export const APPROVAL_KIND: Record<ApprovalRequest["tool"], string> = {
  shell: "commands",
  write_file: "file changes",
  edit_file: "file changes",
  editor_restart: "editor restarts",
  ue_mcp: "ue-mcp actions that delete or overwrite",
};

export const RESTART_OPERATION: Record<NonNullable<ApprovalRequest["operation"]>, string> = {
  restart: "Restart the editor",
  rebuild: "Stop the editor, rebuild the project's C++ and start it again",
  stop: "Stop the editor",
  start: "Start the editor",
};
