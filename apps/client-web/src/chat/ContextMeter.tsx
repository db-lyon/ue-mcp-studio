import { useEffect, useId, useRef, useState } from "react";
import { contextView, type ContextUsage, type ContextView, type SessionSpend } from "@ue-mcp-studio/shared";
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

/**
 * The context ring: how full, as an arc from the top, clockwise, with a tick
 * where it compacts. Past the window the ring is closed and glows.
 */
export function ContextRing({ view, className = "" }: { view: ContextView; className?: string }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, view.fraction));
  // A sliver still shows once anything is measured.
  const dash = view.used > 0 ? Math.max(f * c, 0.6) : 0;
  const a = view.compactAt * 2 * Math.PI;
  const tx = (rad: number) => 8 + rad * Math.sin(a);
  const ty = (rad: number) => 8 - rad * Math.cos(a);
  return (
    <svg className={`context-ring level-${view.level} ${view.fraction > 1 ? "over" : ""} ${className}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle className="context-ring-track" cx="8" cy="8" r={r} />
      <circle className="context-ring-fill" cx="8" cy="8" r={r} strokeDasharray={`${dash} ${c}`} transform="rotate(-90 8 8)" />
      <line className="context-ring-tick" x1={tx(4)} y1={ty(4)} x2={tx(8)} y2={ty(8)} />
    </svg>
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

/** The hover card's lines: tokens of the window, the model it was measured on, where it compacts. */
export function tipLines(view: ContextView, context: ContextUsage | undefined, opts: { nameOf: (id: string) => string; modelName: string; runtime: boolean; compacting: boolean; owner?: string }): string[] {
  const lines: string[] = [];
  if (opts.owner) lines.push(`${opts.owner} agent's context`);
  lines.push(`${view.estimated ? "About " : ""}${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}`);
  const on = view.measuredOn ?? (context?.model || null);
  if (view.estimated && !on) lines.push("Estimated from the conversation's text");
  else if (on) lines.push(view.measuredOn ? `Measured on ${opts.nameOf(on)}, next turn on ${opts.modelName}` : `Measured on ${opts.nameOf(on)}`);
  const at = tokenCount(Math.round(view.window * view.compactAt));
  const who = opts.runtime ? "Claude's runtime compacts" : "Studio compacts";
  if (opts.compacting) lines.push("Compacting now");
  else if (view.fraction >= 1) lines.push(`Over the window: ${opts.runtime ? "the runtime compacts it next turn" : "Studio compacts it before the next request"}`);
  else if (view.fraction >= view.compactAt) lines.push(`Past where it compacts (${at}): ${opts.runtime ? "compacts next turn" : "compacts before the next request"}`);
  else lines.push(`${who} at ${opts.runtime ? "about " : ""}${at} (${pct(view.compactAt)})`);
  return lines;
}

/**
 * The composer's context meter: how much of the model's window the
 * conversation takes now, as a small ring and a percentage that turn amber and
 * then red near the point it compacts. Hovered, a card says the tokens, the
 * model they were measured on and where it compacts. Opened (a click, or a tap
 * on a touch screen), it has the numbers behind it, Compact now, and the
 * session's totals, which are spend, not context.
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
  const tipId = useId();
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
  const runtimeNow = runtime && !view?.measuredOn && !!context?.window;
  const tip = view ? tipLines(view, context, { nameOf, modelName: modelName ?? model, runtime: runtimeNow, compacting, owner }) : ["Context is measured after the next reply"];
  const label = view
    ? `${owner ? `${owner} agent's context` : "Context"} ${pct(view.fraction)} full: ${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}${compacting ? ", compacting" : ""}`
    : "Context not measured yet";
  return (
    <div className="context-meter" ref={box}>
      <button
        className={`ghost context-button level-${view?.level ?? "ok"} ${compacting ? "compacting" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        aria-describedby={open ? undefined : tipId}
        onClick={() => setOpen(!open)}
      >
        {view ? <ContextRing view={view} /> : <span className="context-ring-empty" aria-hidden="true" />}
        <span className="context-pct">{view ? `${view.estimated ? "~" : ""}${pct(view.fraction)}` : "ctx"}</span>
        {!open && (
          <span className="context-tip" role="tooltip" id={tipId}>
            {tip.map((l, i) => <span key={i} className={i === (owner ? 1 : 0) ? "context-tip-main" : undefined}>{l}</span>)}
          </span>
        )}
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
              <p className="dim small">{compactLine(view, runtimeNow)}</p>
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
      <ContextRing view={view} />
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
