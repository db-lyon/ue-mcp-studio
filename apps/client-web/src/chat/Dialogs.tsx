import { useEffect, useState } from "react";
import type { DialogAnswer, EditorDialog } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { native } from "../native";
import { decider, outcomeLine, readyIn, statusLine, whoLine } from "./dialog-model";

/** The open editor dialogs of one session, each a card with the dialog's own buttons. */
export function DialogCards({ dialogs, now }: { dialogs: EditorDialog[]; now: number }) {
  if (dialogs.length === 0) return null;
  return (
    <div className="approvals dialogs" role="region" aria-label="Editor dialogs">
      {dialogs.map((d) => <DialogCard key={d.id} dialog={d} now={now} />)}
    </div>
  );
}

/** The rows a person can tick: each unsaved asset of a save prompt. */
function itemsOf(d: EditorDialog) {
  return (d.items ?? []).filter((i) => i.cells.some((c) => c.startsWith("/")));
}

/** Every transition so far, oldest first. */
function Steps({ dialog: d }: { dialog: EditorDialog }) {
  if (d.steps.length === 0) return null;
  return (
    <ol className="dialog-steps small" aria-label="What happened">
      {d.steps.map((s, i) => (
        <li key={i}>
          <span className="dim mono">{new Date(s.at).toLocaleTimeString()}</span> {s.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * One dialog: its title, message and buttons, which call met it, and one line
 * that says who decides right now. A press is sent to ue-mcp, which presses
 * that button in the editor.
 */
export function DialogCard({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<number, boolean>>({});
  const rows = itemsOf(d);
  const who = decider(d);
  const wait = readyIn(d, now);

  // Asked while the user is elsewhere: flash the window and post a notification.
  const wants = who === "you" || d.held !== null;
  useEffect(() => {
    if (wants && !document.hasFocus()) void native().drawattention?.(`Unreal is waiting on a dialog: ${d.title}`).catch(() => false);
  }, [wants, d.id]);
  // A new phase can be answered again.
  useEffect(() => setSent(null), [who, d.held?.button]);

  const send = (label: string, answer: DialogAnswer) => {
    setSent(label);
    setError(null);
    api.answerDialog(d.id, answer).catch((e: Error) => {
      setSent(null);
      setError(e.message);
    });
  };
  const press = (button: string) => {
    const items = rows.length > 0 ? rows.map((i) => ({ index: i.index, checked: ticks[i.index] ?? i.checked })) : undefined;
    send(button, { answer: "press", button, ...(items ? { items } : {}) });
  };

  const meta = whoLine(d);
  const busy = sent !== null;
  return (
    <div className="approval card dialog-card" role="group" aria-label={`Editor dialog: ${d.title}`}>
      <div className="approval-head">
        <span className="eyebrow">Editor dialog</span>
        {meta && <span className="dim small">met by {meta}</span>}
      </div>
      <strong className="dialog-title">{d.title || "(untitled dialog)"}</strong>
      {d.message && <pre className="output dialog-message">{d.message}</pre>}
      {rows.length > 0 && (
        <div className="dialog-items" role="group" aria-label="Assets">
          {rows.map((i) => (
            <label key={i.index} className="row toggle small">
              <input
                type="checkbox"
                disabled={who !== "you" || busy}
                checked={ticks[i.index] ?? i.checked}
                onChange={(e) => setTicks({ ...ticks, [i.index]: e.target.checked })}
              />
              <span>{i.label}</span>
              <span className="dim mono">{i.cells.find((c) => c.startsWith("/"))}</span>
            </label>
          ))}
        </div>
      )}
      <div className={`dialog-status ${who}`} role="status">{statusLine(d, now)}</div>
      {error && <div className="banner bad">{error}</div>}
      {d.held ? (
        <div className="row approval-actions">
          <button className="primary" disabled={busy} onClick={() => send(d.held!.button, { answer: "release" })}>Press {d.held.button} now</button>
          {d.buttons.filter((b) => b !== d.held!.button).map((b) => (
            <button key={b} disabled={busy} onClick={() => press(b)} title={`Override: press ${b} instead`}>{b} instead</button>
          ))}
        </div>
      ) : who === "you" ? (
        <div className="row approval-actions">
          {d.buttons.map((b, i) => (
            <button key={b} className={i === 0 ? "primary" : undefined} disabled={busy || wait > 0} onClick={() => press(b)}>{b}</button>
          ))}
          <button className="ghost" disabled={busy || wait > 0} onClick={() => send("delegate", { answer: "delegate" })} title="The agent picks the answer for this dialog">Let the agent decide</button>
        </div>
      ) : who === "agent" ? (
        <div className="row approval-actions">
          <span className="dim small">Answer it yourself:</span>
          {d.buttons.map((b) => <button key={b} disabled={busy} onClick={() => press(b)}>{b}</button>)}
        </div>
      ) : null}
      <Steps dialog={d} />
    </div>
  );
}

/** A dialog in the transcript: what it asked, every transition, and how it ended. */
export function DialogLine({ dialog: d }: { dialog: EditorDialog }) {
  const meta = whoLine(d);
  const ended = outcomeLine(d);
  return (
    <div className="dialog-line" role="note">
      <span className="eyebrow">Editor dialog</span> <strong>{d.title || "(untitled dialog)"}</strong>
      {meta && <span className="dim small"> met by {meta}</span>}
      <Steps dialog={d} />
      {ended && <div className="small">{ended}</div>}
    </div>
  );
}

/** The banner line while a dialog holds the editor: the same line the card says. */
export function DialogBannerLine({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  return (
    <div className="banner warn editor-banner dialog-banner" role="status">
      <span className="editor-banner-text">
        <strong>Editor waiting on a dialog:</strong> {d.title || "(untitled dialog)"}
        <span className="dim"> {statusLine(d, now)}</span>
      </span>
    </div>
  );
}
