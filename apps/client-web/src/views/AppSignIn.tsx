import { useEffect, useRef, useState } from "react";
import { PROVIDERS, type SignInId, type StudioSignIn } from "@ue-mcp-studio/shared";
import { api } from "../api";

export const SIGN_IN_ABOUT: Record<SignInId, string> = {
  chatgpt: "Runs OpenAI models on your ChatGPT plan.",
  claude: "Runs Claude models on your Claude plan, using your Claude Code login.",
  studio: "Runs your Studio plan's models on your ue-mcp account.",
};

/** A device or browser sign-in's three calls: its progress, start and cancel. */
export interface SignInCalls {
  view(): Promise<StudioSignIn>;
  start(): Promise<StudioSignIn>;
  cancel(): Promise<void>;
}

const callsOf = (id: SignInId): SignInCalls => ({ view: () => api.signIn(id), start: () => api.startSignIn(id), cancel: () => api.cancelSignIn(id) });

/**
 * One sign-in: a button, then the page to approve on, until it finishes.
 * `calls` runs another device flow through the same form (linking GitHub to
 * the signed-in account); `label` names the button.
 */
export function AppSignIn({ id, primary = true, onDone, name = PROVIDERS[id].name, about = SIGN_IN_ABOUT[id], label, calls = callsOf(id), doneText, autoStart = false }: {
  id: SignInId;
  primary?: boolean;
  onDone: () => void;
  name?: string;
  about?: string;
  label?: string;
  calls?: SignInCalls;
  doneText?: string;
  /** Start at once instead of showing the button first: the user already asked (Link GitHub). */
  autoStart?: boolean;
}) {
  const [state, setState] = useState<StudioSignIn | null>(null);
  const done = useRef(false);

  useEffect(() => {
    // A finished sign-in from before means a sign-out since, when this form is showing.
    calls.view().then((s) => {
      if (autoStart && s.state !== "pending") return void start();
      setState(s.state === "done" ? { state: "idle" } : s);
    }, () => setState({ state: "idle" }));
  }, [id]);

  // Follow a pending sign-in until it is approved.
  useEffect(() => {
    if (state?.state !== "pending") return;
    const t = setInterval(() => calls.view().then(setState, () => {}), 2000);
    return () => clearInterval(t);
  }, [state?.state, id]);

  useEffect(() => {
    if (state?.state === "done" && !done.current) {
      done.current = true;
      onDone();
    }
  }, [state]);

  const start = () => calls.start().then((s) => {
    setState(s);
    if (s.state === "pending" && s.url) window.open(s.url, "_blank");
  }, (e: Error) => setState({ state: "error", error: e.message }));

  if (!state) return null;
  if (state.state === "pending") {
    return (
      <div className="connect signin">
        {state.userCode ? (
          <>
            <p className="small muted">Enter this code on GitHub to sign in to {name}:</p>
            <div className="row">
              <span className="signin-code mono">{state.userCode}</span>
              <button onClick={() => void navigator.clipboard?.writeText(state.userCode!)}>Copy</button>
              <a href={state.url} target="_blank" rel="noreferrer"><button className="primary">Open GitHub</button></a>
            </div>
          </>
        ) : !state.url ? (
          <>
            <p className="small muted">{name}'s sign-in page opened in your browser. Approve it there.</p>
            {state.terminal && <TerminalSignIn command={state.terminal} />}
          </>
        ) : (
          <div className="row">
            <span className="small muted">Approve the sign-in in your browser.</span>
            <a href={state.url} target="_blank" rel="noreferrer"><button>Open again</button></a>
          </div>
        )}
        <p className="dim small">Waiting for approval. <button className="ghost small-button" onClick={() => void calls.cancel().then(() => setState({ state: "idle" }))}>Cancel</button></p>
      </div>
    );
  }
  if (state.state === "done") return <p className="small">{doneText ?? `Signed in to ${name}.`}</p>;
  return (
    <div className="connect signin">
      {state.state === "error" && <div className="banner bad small">{state.error}</div>}
      {state.state === "error" && state.terminal && <TerminalSignIn command={state.terminal} />}
      <button className={primary ? "primary" : ""} onClick={() => void start()}>{label ?? `Sign in to ${name}`}</button>
      {about && <p className="dim small">{about}</p>}
    </div>
  );
}

/** The sign-in command for a terminal. */
export function TerminalSignIn({ command, lead = "No browser opened? Run this in" }: { command: string; lead?: string }) {
  return (
    <div className="signin-terminal">
      <p className="dim small">{lead} {command.startsWith("& ") || command.startsWith("$env:") ? "PowerShell" : "a terminal"} and follow its prompts:</p>
      <div className="row">
        <code className="mono small">{command}</code>
        <button onClick={() => void navigator.clipboard?.writeText(command)}>Copy</button>
      </div>
    </div>
  );
}
