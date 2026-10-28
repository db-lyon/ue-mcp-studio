import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FeedbackReport, FeedbackResult } from "@ue-mcp-studio/shared";
import { api } from "../api";

/** Opens in the system browser from the editor panel; a plain browser opens a tab. */
const openLink = (url: string) => void window.open(url, "_blank", "noopener");

/**
 * Report a problem or suggest an idea: filed as an issue on Studio's GitHub
 * tracker, with the installed versions when the user includes them. A crash
 * opens it filled in with what broke and its stack.
 */
export function FeedbackDialog({ onClose, initial }: { onClose: () => void; initial?: { title: string; description: string } }) {
  const [kind, setKind] = useState<FeedbackReport["kind"]>("problem");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [includeEnvironment, setIncludeEnvironment] = useState(true);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackResult | null>(null);

  useEffect(() => {
    api.feedbackEnvironment().then((e) => setEnvironment(e.body), () => setEnvironment(null));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const ready = title.trim().length >= 5 && description.trim().length >= 20;
  const send = () => {
    setSending(true);
    setError(null);
    api.sendFeedback({ kind, title, description, includeEnvironment }).then((r) => {
      setResult(r);
      // Nothing the user wrote is lost: the same report opens on GitHub to finish there.
      if (!r.filed) openLink(r.link);
    }, (e: Error) => setError(e.message)).finally(() => setSending(false));
  };

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card feedback" role="dialog" aria-label="Send feedback" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">Send feedback</div>
        {result?.filed ? (
          <>
            <p className="muted">Filed as <a href={result.url} onClick={(e) => { e.preventDefault(); openLink(result.url); }}>issue #{result.number}</a> on Studio's tracker. Thanks.</p>
            <div className="row"><span className="spacer" /><button className="primary" onClick={onClose}>Done</button></div>
          </>
        ) : result ? (
          <>
            <p className="muted">{result.reason} The report opened on GitHub, filled in, to send from there.</p>
            <div className="row">
              <button className="ghost" onClick={() => openLink(result.link)}>Open it again</button>
              <span className="spacer" />
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="row feedback-kind" role="radiogroup" aria-label="Kind">
              <button role="radio" aria-checked={kind === "problem"} className={kind === "problem" ? "current" : "ghost"} onClick={() => setKind("problem")}>Report a problem</button>
              <button role="radio" aria-checked={kind === "idea"} className={kind === "idea" ? "current" : "ghost"} onClick={() => setKind("idea")}>Suggest an idea</button>
            </div>
            <input aria-label="Title" placeholder={kind === "problem" ? "What went wrong, in a line" : "The idea, in a line"} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <textarea
              aria-label="Description"
              rows={7}
              placeholder={kind === "problem" ? "What you did, what you expected, and what happened instead." : "What you would like Studio to do, and why."}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className="row toggle small">
              <input type="checkbox" checked={includeEnvironment} onChange={(e) => setIncludeEnvironment(e.target.checked)} />
              <span>Include the installed versions, engine, OS and model</span>
            </label>
            {includeEnvironment && environment && (
              <details className="dim small">
                <summary>What gets added</summary>
                <pre className="feedback-env">{environment}</pre>
              </details>
            )}
            <p className="dim small">Filed publicly on github.com/db-lyon/ue-mcp-studio. No keys, files or project names are sent.</p>
            {error && <div className="banner bad small">{error}</div>}
            <div className="row">
              <span className="spacer" />
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!ready || sending} onClick={send}>{sending ? "Sending" : "Send"}</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
