import { useEffect, useState } from "react";
import { CONVENTION_INFO, type Convention, type NativeFile, type NativeOverview, type NativePreview, type NativeView } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Card, tokens, useMessage } from "./controls";

function scopeLine(f: NativeFile): string {
  if (f.scope.kind === "globs") return `when the agent touches ${f.scope.globs.join(", ")}`;
  if (f.scope.kind === "folder") return `when the agent works in ${f.scope.folder}`;
  return f.source === "user" ? "yours, every project" : f.source === "local" ? "this machine only" : "every call";
}

const SOURCE: Record<string, string> = { user: "Yours", project: "Project", local: "This machine", plugin: "Plugin" };

function OpenFile({ path, onError }: { path: string; onError: (e: Error) => void }) {
  return <button className="ghost small-button" onClick={() => void api.openFile(path).catch(onError)} aria-label={`Open ${path}`}>Open file</button>;
}

/** Tabs by convention: the main agent's first, then those a connected route reads, then the rest. */
export function conventionOrder(o: NativeOverview): NativeView[] {
  const rank = (v: NativeView) => (v.convention === o.main ? 0 : v.routes.length ? 1 : 2);
  // Ties by name, so no vendor leads by default.
  return [...o.conventions].sort((a, b) => rank(a) - rank(b) || CONVENTION_INFO[a.convention].name.localeCompare(CONVENTION_INFO[b.convention].name));
}

/**
 * Agents > Project files: what each vendor's own files give its models, read
 * only. Studio reads them as that vendor's tools read them and writes none.
 */
export function NativePanel({ overview }: { overview: NativeOverview }) {
  const ordered = conventionOrder(overview);
  const [tab, setTab] = useState<Convention>(ordered[0]?.convention ?? "claude");
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const msg = useMessage();
  const view = overview.conventions.find((c) => c.convention === tab) ?? ordered[0];
  useEffect(() => {
    setPreview(null);
    if (view) api.nativePreview(view.convention).then(setPreview, () => setPreview(null));
  }, [view?.convention]);
  if (!view) return null;
  const info = CONVENTION_INFO[view.convention];
  const count = (v: NativeView) => v.instructions.length + v.subagents.length + v.skills.length;
  return (
    <>
      <nav className="subtabs" aria-label="Whose files">
        {ordered.map((v) => (
          <button key={v.convention} className={`subtab ${v.convention === tab ? "active" : ""}`} aria-current={v.convention === tab ? "page" : undefined} onClick={() => setTab(v.convention)}>
            {CONVENTION_INFO[v.convention].name}<span className="count">{count(v)}</span>
          </button>
        ))}
      </nav>
      {msg.node}
      <p className="muted small">
        {info.vendor[0].toUpperCase() + info.vendor.slice(1)} read the files {info.tool} reads: {info.reads} <a href={info.docs} target="_blank" rel="noreferrer">{info.tool} documentation</a>
      </p>
      <p className="cfg-note">
        {view.convention === overview.main ? "The main agent reads these. " : ""}
        {view.routes.length ? `Read on this machine by ${view.routes.join(" and ")}.` : "No connected route reads these yet."}
        {view.convention === "claude" && preview?.loadedBy === "sdk" ? " On the Claude sign-in the Agent SDK loads them itself, as Claude Code does." : ""}
      </p>
      {view.notes.map((n) => <div key={n} className="banner warn small">{n}</div>)}

      <Card label={`Instruction files ${view.instructions.length ? `(${tokens(view.instructionTokens)} tokens on every call)` : ""}`}>
        {view.instructions.length === 0 && <p className="cfg-note">None in this project. {view.convention === "claude" ? "Claude Code reads a CLAUDE.md in the project folder." : view.convention === "gemini" ? "Gemini CLI reads a GEMINI.md in the project folder." : "These models read an AGENTS.md in the project folder."}</p>}
        <ol className="ifiles">
          {view.instructions.map((f, i) => (
            <li key={f.path}>
              <span className="ifile-n dim num">{i + 1}</span>
              <div className="ifile-main">
                <div className="path">{f.path}</div>
                <div className="readers">{tokens(f.tokens)} tokens, {scopeLine(f)}{f.imports?.length ? `, imports ${f.imports.join(", ")}` : ""}</div>
              </div>
              <OpenFile path={f.path} onError={msg.fail} />
            </li>
          ))}
        </ol>
        {preview?.text && (
          <details className="cfg-note">
            <summary>What an agent is given from these files</summary>
            <pre className="code">{preview.text}</pre>
          </details>
        )}
      </Card>

      <Card label="Subagents">
        {view.subagents.length === 0 && <p className="cfg-note">{view.convention === "agents" ? "These models have no subagent files; Studio's own worker is their helper." : `None in this project. ${info.tool} reads them from ${view.convention === "claude" ? ".claude/agents" : view.convention === "codex" ? ".codex/agents" : ".gemini/agents"}.`}</p>}
        <ol className="ifiles">
          {view.subagents.map((a) => (
            <li key={a.path}>
              <span className="ifile-n" />
              <div className="ifile-main">
                <div><strong>{a.name}</strong> <span className="muted small">{a.description}</span></div>
                <div className="readers">Runs on {a.runs.model}{a.model ? ` (its file names ${a.model})` : ""}. Tools: {a.tools}.{a.maxTurns ? ` At most ${a.maxTurns} turns.` : ""}{a.effort ? ` Effort ${a.effort}.` : ""}</div>
                {a.runs.note && <div className="cfg-note warn-text">{a.runs.note}</div>}
                {a.problems.map((p) => <div key={p} className="cfg-note warn-text">{p}</div>)}
                <div className="path dim">{a.path}</div>
              </div>
              <OpenFile path={a.path} onError={msg.fail} />
            </li>
          ))}
        </ol>
      </Card>

      <Card label="Skills">
        {view.skills.length === 0 && <p className="cfg-note">None in this project. {info.tool} reads them from {view.convention === "claude" ? ".claude/skills" : view.convention === "gemini" ? ".agents/skills and .gemini/skills" : ".agents/skills"}.</p>}
        <ol className="ifiles">
          {view.skills.map((s) => (
            <li key={`${s.path}`}>
              <span className="ifile-n" />
              <div className="ifile-main">
                <div><strong className="mono">{s.name}</strong> <span className="tag">{s.owner ? `plugin ${s.owner}` : SOURCE[s.source]}</span></div>
                <div className="readers">{s.description || "No description."} {tokens(s.tokens)} tokens when loaded.{s.implicit ? "" : " Used only when you name it."}</div>
                {s.problems.map((p) => <div key={p} className="cfg-note warn-text">{p}</div>)}
                <div className="path dim">{s.path}</div>
              </div>
              <OpenFile path={s.path} onError={msg.fail} />
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
