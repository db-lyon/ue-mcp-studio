import { Fragment, useEffect, useState } from "react";
import { CONVENTIONS, CONVENTION_INFO, EFFORT_NAMES, type Effort, type Convention, type NativeFile, type NativeOverview, type NativePreview, type NativeView } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Card, tokens, useMessage } from "./controls";

function scopeLine(f: NativeFile): string {
  if (f.scope.kind === "globs") return `when the agent touches ${f.scope.globs.join(", ")}`;
  if (f.scope.kind === "folder") return `when the agent works in ${f.scope.folder}`;
  return f.source === "user" ? "yours, every project" : f.source === "local" ? "this machine only" : "every call";
}

const SOURCE: Record<string, string> = { user: "User", project: "Project", local: "This machine", plugin: "Plugin" };

/** Where each convention keeps its subagents and skills, for the empty states. */
const SUBAGENT_DIR: Record<Convention, string | null> = { claude: ".claude/agents and ~/.claude/agents", codex: ".codex/agents and ~/.codex/agents", gemini: ".gemini/agents and ~/.gemini/agents", agents: null };
const SKILL_DIR: Record<Convention, string> = { claude: ".claude/skills and ~/.claude/skills", codex: ".agents/skills and ~/.agents/skills", gemini: ".agents/skills, .gemini/skills, ~/.agents/skills and ~/.gemini/skills", agents: ".agents/skills and ~/.agents/skills" };
const INSTRUCTION_FILE: Record<Convention, string> = { claude: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md", agents: "AGENTS.md" };

/** A path that wraps only after its slashes, never inside a name. */
export function Path({ p, className = "path" }: { p: string; className?: string }) {
  // Either separator, so a Windows path wraps at its backslashes too.
  const parts = p.split(/(?<=[\\/])/);
  return (
    <div className={className} title={p}>
      {parts.map((s, i) => <Fragment key={i}>{s}{i < parts.length - 1 && <wbr />}</Fragment>)}
    </div>
  );
}

function OpenFile({ path, onError }: { path: string; onError: (e: Error) => void }) {
  return <button className="small-button open-file" onClick={() => void api.openFile(path).catch(onError)} aria-label={`Open ${path}`} title={`Open ${path} in its default app`}>Open file</button>;
}

const count = (v: NativeView) => v.instructions.length + v.subagents.length + v.skills.length;

/** Tabs in one fixed order, the vendors' order everywhere in Settings; a dot marks those a route reads. */
export function conventionOrder(o: NativeOverview): NativeView[] {
  return [...o.conventions].sort((a, b) => CONVENTIONS.indexOf(a.convention) - CONVENTIONS.indexOf(b.convention));
}

/** The tab open first: the main agent's convention, else one a route reads, else the first in the fixed order. */
export function firstTab(o: NativeOverview): Convention {
  if (o.main) return o.main;
  const ordered = conventionOrder(o);
  return (ordered.find((v) => v.routes.length) ?? ordered[0])?.convention ?? "claude";
}

/**
 * Agents > the project's agent files: what each vendor's own files give its
 * models, read only. Studio reads them as that vendor's tools read them and
 * writes none.
 */
export function NativePanel({ overview, onConnect }: { overview: NativeOverview; onConnect: () => void }) {
  const ordered = conventionOrder(overview);
  const [tab, setTab] = useState<Convention>(() => firstTab(overview));
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const msg = useMessage();
  const view = overview.conventions.find((c) => c.convention === tab) ?? null;
  useEffect(() => {
    setPreview(null);
    if (view) api.nativePreview(view.convention).then(setPreview, () => setPreview(null));
  }, [view?.convention]);
  return (
    <>
      {view && (
        <>
          <nav className="subtabs scroll-tabs tabs-wide" aria-label="Whose files">
            {ordered.map((v) => (
              <button key={v.convention} className={`subtab ${v.convention === tab ? "active" : ""}`} aria-current={v.convention === tab ? "page" : undefined} title={`The files ${CONVENTION_INFO[v.convention].vendor} read`} onClick={() => setTab(v.convention)}>
                {v.routes.length > 0 && <span className="dot ok" aria-label="read by a connected route" />}{CONVENTION_INFO[v.convention].tool}<span className="count">{count(v)}</span>
              </button>
            ))}
          </nav>
          <label className="tabs-narrow tab-select">
            <span className="muted small">Vendor</span>
            <select value={view.convention} onChange={(e) => setTab(e.target.value as Convention)} aria-label="Whose files">
              {ordered.map((v) => <option key={v.convention} value={v.convention}>{CONVENTION_INFO[v.convention].tool} ({count(v)}){v.routes.length ? ", read by a connected route" : ""}</option>)}
            </select>
          </label>
        </>
      )}
      {msg.node}
      {view && <ConventionView view={view} main={overview.main} preview={preview} onConnect={onConnect} onError={msg.fail} />}
    </>
  );
}

function ConventionView({ view, main, preview, onConnect, onError }: { view: NativeView; main: Convention | null; preview: NativePreview | null; onConnect: () => void; onError: (e: Error) => void }) {
  const info = CONVENTION_INFO[view.convention];
  const sdk = preview?.loadedBy === "sdk";
  const inUse = view.routes.length > 0;
  const scoped = view.instructions.filter((f) => f.scope.kind !== "always").reduce((n, f) => n + f.tokens, 0);
  const later = view.instructions.filter((f) => f.scope.kind !== "always").length;
  const files = preview ? `${preview.files} file${preview.files === 1 ? "" : "s"}${later ? `; ${later} more join${later === 1 ? "s" : ""} when the agent works in ${later === 1 ? "its" : "their"} paths` : ""}` : "";
  return (
    <>
      <p className="muted small">
        {view.convention === "agents"
          ? <>Custom endpoints read the vendor-neutral files: {info.reads} <a href={info.docs} target="_blank" rel="noreferrer">AGENTS.md documentation</a></>
          : <>{info.vendor[0].toUpperCase() + info.vendor.slice(1)} read the files {info.tool} reads: {info.reads} <a href={info.docs} target="_blank" rel="noreferrer">{info.tool} documentation</a></>}
      </p>
      <p className="cfg-status">
        <span className={`dot ${inUse ? "ok" : ""}`} aria-hidden />
        {inUse
          ? <span>Read by: {view.routes.join(", ")}.{view.convention === main ? " The main agent runs here." : ""} {sdk ? "The Agent SDK loads these files itself, as Claude Code does." : `Studio reads them the way ${info.tool === "AGENTS.md" ? "agents that read AGENTS.md do" : `${info.tool} does`}.`}</span>
          : view.convention === "agents"
            ? <span>Read by: custom endpoints. No route on this machine reads these.</span>
            : <span>No connected route reads these. <button className="link" onClick={onConnect}>Connect one in Models & accounts</button></span>}
      </p>
      {view.notes.map((n) => <div key={n} className="banner warn small">{n}</div>)}

      <Card label={view.instructions.length ? `Instruction files · ${tokens(view.instructionTokens)} per call` : "Instruction files"}>
        {scoped > 0 && <p className="muted small">Up to {tokens(view.instructionTokens + scoped)} with the files that apply only to some paths or folders.</p>}
        {view.instructions.length === 0 && <p className="cfg-note">None found in any of those places. The usual one is a {INSTRUCTION_FILE[view.convention]} in the project folder.</p>}
        <ol className="ifiles">
          {view.instructions.map((f, i) => (
            <li key={f.path}>
              <span className="ifile-n dim num">{i + 1}</span>
              <div className="ifile-main">
                <Path p={f.path} />
                <div className="readers">{tokens(f.tokens)} tokens, {scopeLine(f)}{f.imports?.length ? `, imports ${f.imports.join(", ")}` : ""}</div>
              </div>
              <OpenFile path={f.path} onError={onError} />
            </li>
          ))}
        </ol>
        {preview?.text && (
          <details className="cfg-note">
            <summary>Preview: the text on every call ({files})</summary>
            <pre className="code">{preview.text}</pre>
          </details>
        )}
      </Card>

      <Card label="Subagents">
        {view.subagents.length === 0 && <p className="cfg-note">{SUBAGENT_DIR[view.convention] ? `None found in ${SUBAGENT_DIR[view.convention]!.replace(/ and /, " or ")}.` : "These models have no subagent files; Studio's worker is their helper."}</p>}
        <ul className="ifiles plain">
          {view.subagents.map((a) => (
            <li key={a.path}>
              <div className="ifile-main">
                <div><strong>{a.name}</strong> <span className="tag">{SOURCE[a.source]}</span> <span className="muted small">{a.description}</span></div>
                <dl className="fields">
                  <dt>Model</dt><dd>{a.runs.model}{a.model ? <> (file says <code>{a.model}</code>)</> : null}</dd>
                  <dt>Tools</dt><dd>{a.tools}</dd>
                  <dt>Turns</dt><dd>{a.maxTurns ? `at most ${a.maxTurns}` : "no limit set"}</dd>
                  <dt>Effort</dt><dd>{a.effort ? EFFORT_NAMES[a.effort as Effort] ?? a.effort : "the main agent's"}</dd>
                  <dt>Size</dt><dd>{tokens(a.tokens)} tokens when started</dd>
                </dl>
                {a.runs.note && <div className="cfg-note warn-text">{a.runs.note}</div>}
                {a.problems.map((p) => <div key={p} className="cfg-note warn-text">{p}</div>)}
                <Path p={a.path} className="path dim" />
              </div>
              <OpenFile path={a.path} onError={onError} />
            </li>
          ))}
        </ul>
      </Card>

      <Card label="Skills">
        {view.skills.length === 0 && <p className="cfg-note">None found in {SKILL_DIR[view.convention].replace(/ and /, " or ")}.</p>}
        <ul className="ifiles plain">
          {view.skills.map((s) => (
            <li key={s.path}>
              <div className="ifile-main">
                <div><strong className="mono">{s.name}</strong> <span className="tag">{s.owner ? `Plugin: ${s.owner}` : SOURCE[s.source]}</span></div>
                <div className="readers">{s.description || "No description."} {tokens(s.tokens)} tokens when loaded.{s.implicit ? "" : " Used only when you name it."}</div>
                {s.problems.map((p) => <div key={p} className="cfg-note warn-text">{p}</div>)}
                <Path p={`${s.path}/SKILL.md`} className="path dim" />
              </div>
              <OpenFile path={s.path} onError={onError} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
