import { useEffect, useState } from "react";
import type { InstructionFile, InstructionsPreview, InstructionsView } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Card, Switch, tokens, useMessage } from "./controls";

/** Files whose text can move into AGENTS.md and be replaced by an import of it. */
const POINTABLE = ["CLAUDE.md", ".claude/CLAUDE.md", "GEMINI.md"];

function scopeNote(f: InstructionFile): string | null {
  if (f.missing) return "Not found. Remove it or put the file back.";
  if (f.sameAs) return f.imports?.length ? `Imports ${f.sameAs}. Included once, as ${f.sameAs}.` : `Same text as ${f.sameAs}. Included once, as ${f.sameAs}.`;
  if (f.scope.kind === "globs") return `Only when a turn touches ${f.scope.globs.join(", ")}.`;
  if (f.scope.kind === "folder") return `Only when an agent works in ${f.scope.folder}.`;
  if (f.convention === "studio") return "Your instructions, every project.";
  if (f.convention === "local") return "This machine only, usually git-ignored. Read last, so it overrides.";
  if (f.convention === "agents") return "The shared file that wins among the others.";
  if (f.convention === "added") return "Added by you.";
  return null;
}

/**
 * Agents > Instructions: every instruction file the project has, whatever
 * tool it was written for, in the order agents read them, with the composed
 * result for a chosen agent beside it.
 */
export function InstructionsPanel({ agents }: { agents: Array<{ id: string; name: string }> }) {
  const [view, setView] = useState<InstructionsView | null>(null);
  const [agent, setAgent] = useState<string>(agents[0]?.id ?? "");
  const [prev, setPrev] = useState<InstructionsPreview | null>(null);
  const [adding, setAdding] = useState<{ path: string; after: string | null } | null>(null);
  const [creating, setCreating] = useState<string[] | null>(null);
  const msg = useMessage();
  const load = () => api.instructions().then(setView, msg.fail);
  useEffect(() => void load(), []);
  useEffect(() => {
    if (view) api.instructionsPreview(agent || undefined).then(setPrev, () => setPrev(null));
  }, [view, agent]);

  if (!view) return <>{msg.node ?? <p className="muted">Reading the project's instruction files</p>}</>;
  const added = (current: InstructionsView) => current.files.filter((f) => f.convention === "added").map((f) => ({ path: f.path, after: current.files[current.files.indexOf(f) - 1]?.path ?? null }));
  const toggle = (f: InstructionFile, on: boolean) => {
    const off = view.files.filter((x) => !x.on).map((x) => x.path).filter((p) => p !== f.path);
    api.saveInstructions({ off: on ? off : [...off, f.path] }).then(setView, msg.fail);
  };
  const addFile = () => {
    if (!adding?.path.trim()) return;
    api.saveInstructions({ added: [...added(view), { path: adding.path.trim(), after: adding.after }] }).then((v) => {
      setView(v);
      setAdding(null);
    }, msg.fail);
  };
  const removeAdded = (p: string) => api.saveInstructions({ added: added(view).filter((a) => a.path !== p) }).then(setView, msg.fail);
  const move = (f: InstructionFile, by: -1 | 1) => {
    const i = view.files.indexOf(f);
    const order = view.files.filter((x) => x !== f);
    const at = Math.max(0, Math.min(order.length, i + by));
    const after = at === 0 ? null : order[at - 1].path;
    api.saveInstructions({ added: added(view).map((a) => (a.path === f.path ? { path: a.path, after } : a)) }).then(setView, msg.fail);
  };
  const pointable = view.files.filter((f) => POINTABLE.includes(f.path) && !f.sameAs).map((f) => f.path);
  const create = () => api.createAgentsMd(creating ?? []).then((r) => {
    setView(r.view);
    setCreating(null);
    msg.ok(r.pointed.length ? `Created AGENTS.md. ${r.pointed.join(" and ")} now import it.` : "Created AGENTS.md.");
  }, msg.fail);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  /** Who reads a file, by name: every agent, or the first two and how many more. */
  const readers = (f: InstructionFile): string => {
    const ids = f.readBy ?? [];
    if (ids.length === 0) return "no agent";
    if (ids.length === agents.length && agents.length > 2) return `all ${agents.length} agents`;
    const names = ids.map(name);
    return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  };

  return (
    <>
      <div className="banner info small">
        Studio reads every common instruction file, in the order below, and gives the same text to every agent on every vendor. Where files disagree the later one wins, and the agent is told so. AGENTS.md comes after the other shared files, so it wins among them; local files come last.
      </div>
      {msg.node}
      <div className="cfg-side">
        <Card
          label="Files, in the order they are read"
          actions={
            <div className="actions">
              {!view.hasAgentsMd && <button onClick={() => setCreating(pointable)}>Create AGENTS.md</button>}
              <button onClick={() => setAdding({ path: "", after: view.files.at(-1)?.path ?? null })}>Add a file</button>
            </div>
          }
        >
          {creating && (
            <div className="banner info small">
              <p>AGENTS.md is written with what the project's other shared files say, under a heading per file.</p>
              {pointable.map((p) => (
                <label key={p} className="check">
                  <input type="checkbox" checked={creating.includes(p)} onChange={(e) => setCreating(e.target.checked ? [...creating, p] : creating.filter((x) => x !== p))} />
                  Then make {p} import AGENTS.md, so its text is read once
                </label>
              ))}
              <div className="actions"><button className="primary" onClick={() => void create()}>Create</button><button className="ghost" onClick={() => setCreating(null)}>Cancel</button></div>
            </div>
          )}
          {adding && (
            <div className="cfg-inline" style={{ marginBottom: 10 }}>
              <input aria-label="File to add" placeholder="docs/style-guide.md" value={adding.path} onChange={(e) => setAdding({ ...adding, path: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addFile()} />
              <select aria-label="Read it after" value={adding.after ?? ""} onChange={(e) => setAdding({ ...adding, after: e.target.value || null })}>
                <option value="">Read first</option>
                {view.files.map((f) => <option key={f.path} value={f.path}>After {f.path}</option>)}
              </select>
              <button className="primary" disabled={!adding.path.trim()} onClick={addFile}>Add</button>
              <button className="ghost" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
          {view.files.length === 0 && <p className="cfg-note">This project has no instruction files yet. Create AGENTS.md to give every agent the same instructions.</p>}
          <div className="scroll-x">
            <table className="cfg-table">
              <thead>
                <tr><th>#</th><th>File</th><th className="r">Tokens</th><th className="hide-narrow">Read by</th><th className="r">Read</th></tr>
              </thead>
              <tbody>
                {view.files.map((f, i) => (
                  <tr key={f.path}>
                    <td className="dim num">{f.order}</td>
                    <td>
                      <div className="path">{f.path}</div>
                      {scopeNote(f) && <div className={`cfg-note ${f.missing ? "warn" : ""}`}>{scopeNote(f)}</div>}
                      {f.on && !f.sameAs && <div className="readers show-narrow">Read by {readers(f)}</div>}
                      {f.convention === "added" && (
                        <div className="cfg-inline small">
                          <button className="ghost" disabled={i === 0} onClick={() => move(f, -1)} aria-label={`Read ${f.path} earlier`}>Earlier</button>
                          <button className="ghost" disabled={i === view.files.length - 1} onClick={() => move(f, 1)} aria-label={`Read ${f.path} later`}>Later</button>
                          <button className="ghost" onClick={() => void removeAdded(f.path)}>Remove</button>
                        </div>
                      )}
                    </td>
                    <td className="r num">{f.sameAs ? "0" : tokens(f.tokens)}</td>
                    <td className="hide-narrow readers">{f.on && !f.sameAs ? readers(f) : ""}</td>
                    <td className="r">
                      {f.sameAs
                        ? <span className="dim small">as {f.sameAs}</span>
                        : <Switch label={`Read ${f.path}`} on={f.on} disabled={!!f.missing} onChange={(v) => toggle(f, v)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cfg-note">Recognised: {view.recognised.join(", ")}. Add a file to include anything else, such as a style guide. New files Studio creates are AGENTS.md.</p>
        </Card>
        <Card label="What an agent reads">
          {agents.length > 1 && (
            <select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)} style={{ width: "100%", marginBottom: 8 }}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {prev && (
            <>
              <p className="muted small">
                {prev.files ? `${prev.files} file${prev.files === 1 ? "" : "s"}, ${tokens(prev.tokens)} tokens on every call.` : "No instruction files."}
                {prev.conditional.length > 0 && ` Plus ${prev.conditional.map((c) => `${c.path} (${tokens(c.tokens)})`).join(", ")} when it works where they apply.`}
              </p>
              {prev.text && <pre className="code">{prev.text}</pre>}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
