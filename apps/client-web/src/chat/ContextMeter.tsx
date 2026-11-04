import { useEffect, useRef, useState } from "react";
import { contextView, type ContextUsage, type ContextView, type SessionSpend } from "@ue-mcp-studio/shared";
import { atMost, useBarTier } from "./barTier";
import { tokenCount } from "./model";

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** A dollar amount: cents under ten dollars, whole dollars past it. */
export function dollars(n: number): string {
  if (n > 0 && n < 0.01) return "under $0.01";
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** The context bar: how full, and a tick where it compacts. */
export function ContextBar({ view, className = "" }: { view: ContextView; className?: string }) {
  return (
    <span className={`context-bar level-${view.level} ${className}`} aria-hidden="true">
      <span className="context-fill" style={{ width: `${Math.min(100, view.fraction * 100)}%`, minWidth: view.used > 0 ? 2 : 0 }} />
      {view.fraction > 1 && <span className="context-over" />}
      <span className="context-tick" style={{ left: `${view.compactAt * 100}%` }} />
    </span>
  );
}

/** Where the runtime or Studio compacts, in words. */
function compactLine(view: ContextView, runtime: boolean): string {
  const at = tokenCount(Math.round(view.window * view.compactAt));
  if (view.fraction >= view.compactAt) {
    return runtime
      ? `It is past where Claude's runtime compacts (${at}): it compacts at the start of the next turn.`
      : `It is past where Studio compacts (${at}): Studio compacts it before the next request goes.`;
  }
  return runtime
    ? `Claude's runtime compacts this session on its own at about ${at} tokens (${pct(view.compactAt)}).`
    : `Studio compacts it on its own at ${at} tokens (${pct(view.compactAt)}).`;
}

/**
 * The composer's context meter: how much of the model's window the
 * conversation takes now, as a percentage and a thin bar that turns amber and
 * then red near the point it compacts. Opened, it has the numbers behind it,
 * Compact now, and the session's totals, which are spend, not context.
 */
export function ContextMeter({ context, totals, model, modelName, nameOf = (id) => id, listedWindow, busy, compacting, runtime, onCompact, owner }: {
  context: ContextUsage | undefined;
  totals: SessionSpend | undefined;
  /** The model the next turn runs on, by id, and as the picker names it. */
  model: string;
  modelName?: string;
  /** A model's name by its id, for the models a measurement was made on. */
  nameOf?: (id: string) => string;
  /** Its window as the vendor's list gave it. */
  listedWindow?: number;
  busy: boolean;
  compacting: boolean;
  /** The Claude sign-in: its runtime compacts on its own. */
  runtime: boolean;
  onCompact: () => void;
  /** Whose context it is, shown before the bar when that is not obvious (a subagent's thread is open). */
  owner?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tight = atMost("merged", useBarTier());
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const view = contextView(context, model, listedWindow);
  if (!view && !totals?.requests) return null;
  const label = view
    ? `${owner ? `${owner} agent's context` : "Context"} ${pct(view.fraction)} full: ${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}`
    : "Context not measured yet";
  return (
    <div className="context-meter" ref={box}>
      <button
        className={`ghost context-button level-${view?.level ?? "ok"} ${compacting ? "compacting" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title={`${label}. Session totals inside.`}
        onClick={() => setOpen(!open)}
      >
        {owner && <span className="context-owner">{owner}</span>}
        {view && <ContextBar view={view} />}
        <span className="context-pct">{compacting && !tight ? "Compacting" : view ? `${view.estimated ? "~" : ""}${pct(view.fraction)}` : "ctx"}</span>
        {view && !tight && !compacting && <span className="context-of dim">{view.estimated ? "~" : ""}{tokenCount(view.used)}/{tokenCount(view.window)}</span>}
      </button>
      {open && (
        <div className="picker-menu up context-pop" role="dialog" aria-label="Context and session totals">
          <div className="context-pop-head">
            <span className="eyebrow">{owner ? `${owner} agent's context` : "Context"}</span>
            <span className="context-pop-actions">
              <button disabled={busy || compacting || !view} onClick={() => { setOpen(false); onCompact(); }} title={busy ? "Compact when the turn ends" : "Summarize the conversation to free context; the transcript stays"}>
                Compact now
              </button>
              <button className="icon-button" aria-label="Close" title="Close" onClick={() => setOpen(false)}>{"\u00d7"}</button>
            </span>
          </div>
          {view ? (
            <>
              <div className="context-pop-bar"><ContextBar view={view} className="wide" /></div>
              <p className="context-big">
                <strong>{view.estimated ? "about " : ""}{view.used.toLocaleString("en-US")}</strong> of {view.window.toLocaleString("en-US")} tokens <span className={`context-pct level-${view.level}`}>{view.estimated ? "~" : ""}{pct(view.fraction)}</span>
              </p>
              {context && !view.estimated && (
                <p className="dim small">
                  Last request: {tokenCount(context.input)} prompt{context.cached ? ` (${tokenCount(context.cached)} from the cache)` : ""} and {tokenCount(context.output)} answer, on {nameOf(context.model)} at {new Date(context.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                </p>
              )}
              <p className="dim small">{compactLine(view, runtime && !view.measuredOn && !!context?.window)}</p>
              {view.estimated && <p className="dim small">Estimated from the conversation's text. The next reply measures it.</p>}
              {view.measuredOn && <p className="dim small context-note">Measured on {nameOf(view.measuredOn)}. The next turn runs on {modelName ?? model}, whose window is {tokenCount(view.window)}.</p>}
              {view.windowAssumed && <p className="dim small context-note">Studio does not know {modelName ?? model}'s window, so {tokenCount(view.window)} is assumed.</p>}
            </>
          ) : (
            <p className="dim small">Measured after the next reply.</p>
          )}
          {totals && totals.requests > 0 && (
            <>
              <div className="context-pop-head totals-head"><span className="eyebrow">Session totals</span><span className="dim small">every agent, every request</span></div>
              <dl className="context-totals">
                <dt>Input</dt><dd>{tokenCount(totals.input)}</dd>
                <dt>Cache reads</dt><dd>{tokenCount(totals.cacheRead)}</dd>
                {totals.cacheWrite > 0 && <><dt>Cache writes</dt><dd>{tokenCount(totals.cacheWrite)}</dd></>}
                <dt>Output</dt><dd>{tokenCount(totals.output)}{totals.reasoning > 0 ? <span className="dim"> ({tokenCount(totals.reasoning)} reasoning)</span> : null}</dd>
                <dt>Requests</dt><dd>{totals.requests.toLocaleString("en-US")}</dd>
                {totals.costUsd !== undefined && <><dt>Cost</dt><dd>{dollars(totals.costUsd)} <span className="dim">at API prices</span></dd></>}
              </dl>
              {totals.costUsd !== undefined && runtime && <p className="dim small">Your Claude plan covers it; the cost is what the same requests would cost on a key.</p>}
              <p className="dim small">Spend adds up every request. Context is only what the next request starts from.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Above the composer once the context nears the point it compacts: how full
 * it is and Compact now, so a long turn does not start with the summary
 * moments away. Dismissed per session until the level rises again.
 */
export function ContextWarning({ view, runtime, busy, onCompact, onDismiss }: { view: ContextView; runtime: boolean; busy: boolean; onCompact: () => void; onDismiss: () => void }) {
  return (
    <div className={`context-warning level-${view.level}`} role="status">
      <ContextBar view={view} />
      <span className="context-warning-text">
        {view.fraction >= 1
          ? <>Context is past this model's window: {tokenCount(view.used)} of {tokenCount(view.window)}. {runtime ? "Claude's runtime compacts it" : "Studio compacts it before the next request"}, or compact now.</>
          : <>Context is {pct(view.fraction)} full. {runtime ? "Claude's runtime" : "Studio"} compacts it at {pct(view.compactAt)}; compact now to choose the moment.</>}
      </span>
      <button className="primary" disabled={busy} onClick={onCompact} title={busy ? "Compact when the turn ends" : undefined}>Compact now</button>
      <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>{"×"}</button>
    </div>
  );
}
