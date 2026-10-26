import { useState } from "react";
import type { ApprovalDecision, ApprovalRequest } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";

const TITLE: Record<ApprovalRequest["tool"], string> = {
  shell: "Run this command?",
  write_file: "Write this file?",
  edit_file: "Make this edit?",
  editor_restart: "Restart the editor?",
  ue_mcp: "Run this action?",
};

/** What "Allow for this session" covers, by the kind of request. */
const KIND: Record<ApprovalRequest["tool"], string> = {
  shell: "commands",
  write_file: "file changes",
  edit_file: "file changes",
  editor_restart: "editor restarts",
  ue_mcp: "ue-mcp actions that delete or overwrite",
};

const OPERATION: Record<NonNullable<ApprovalRequest["operation"]>, string> = {
  restart: "Restart the editor",
  rebuild: "Stop the editor, rebuild the project's C++ and start it again",
  stop: "Stop the editor",
  start: "Start the editor",
};

/** The calls waiting for the user, oldest first, each with its own buttons. */
export function Approvals({ sessionId, approvals }: { sessionId: string; approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) return null;
  return (
    <div className="approvals" role="region" aria-label="Waiting for your approval">
      {approvals.map((a) => <ApprovalCard key={a.id} sessionId={sessionId} approval={a} />)}
    </div>
  );
}

/** One command or file change: what it is, and Allow, Allow for this session, Deny. */
export function ApprovalCard({ sessionId, approval: a }: { sessionId: string; approval: ApprovalRequest }) {
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: ApprovalDecision) => {
    setSent(decision);
    setError(null);
    api.approve(sessionId, a.id, decision).catch((e: Error) => {
      setSent(null);
      setError(e.message);
    });
  };
  const title = a.tool === "write_file" && a.creates ? "Create this file?" : a.tool === "editor_restart" && a.operation === "rebuild" ? "Rebuild and restart the editor?" : TITLE[a.tool];
  const kind = KIND[a.tool];
  return (
    <div className="approval card" role="group" aria-label={title}>
      <div className="approval-head">
        <span className="eyebrow">{title}</span>
        {a.subagent && <span className="dim small">from subagent {a.subagent}</span>}
      </div>
      {a.tool === "shell" ? (
        <>
          <pre className="output approval-command">{`$ ${a.command ?? ""}`}</pre>
          {a.cwd && <div className="dim small">in {a.cwd}</div>}
        </>
      ) : a.tool === "editor_restart" ? (
        <>
          <div>{OPERATION[a.operation ?? "restart"]}. Unsaved work in the editor is lost.</div>
          {a.reason && <div className="dim small">Why: {a.reason}</div>}
        </>
      ) : a.tool === "ue_mcp" ? (
        <>
          <div className="approval-path">{a.call?.category}.{a.call?.method}</div>
          <pre className="output approval-command">{JSON.stringify(a.call?.args ?? {}, null, 2)}</pre>
          <div className="dim small">ue-mcp marks this action as one that deletes or overwrites.</div>
        </>
      ) : (
        <>
          <div className="approval-path">{a.path}</div>
          <DiffView lines={a.diff ?? []} label={`Changes to ${a.path}`} />
        </>
      )}
      {error && <div className="banner bad">{error}</div>}
      <div className="row approval-actions">
        <button className="primary" disabled={sent !== null} onClick={() => answer("allow")}>Allow</button>
        <button disabled={sent !== null} onClick={() => answer("session")} title={`Allow ${kind} without asking for the rest of this session`}>Allow for this session</button>
        <button className="ghost" disabled={sent !== null} onClick={() => answer("deny")}>Deny</button>
      </div>
    </div>
  );
}
