import { useState } from "react";
import type { ApprovalDecision, ApprovalRequest } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DiffView } from "./Diff";

const TITLE: Record<ApprovalRequest["tool"], string> = {
  shell: "Run this command?",
  write_file: "Write this file?",
  edit_file: "Make this edit?",
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
  const title = a.tool === "write_file" && a.creates ? "Create this file?" : TITLE[a.tool];
  const kind = a.tool === "shell" ? "commands" : "file changes";
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
