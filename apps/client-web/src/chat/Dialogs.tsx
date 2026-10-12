import { useEffect, useState } from "react";
import type { DialogAnswer, EditorDialog } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { native } from "../native";
import { clock, holdLeft, outcomeLine, policyLine, readyIn, whoLine } from "./dialog-model";

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

/**
 * One dialog: its title, message and buttons, which call met it, and what
 * happens if nobody answers. A press is sent to ue-mcp, which presses that
 * button in the editor.
 */
export function DialogCard({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<number, boolean>>({});
  const rows = itemsOf(d);
  const asking = d.asking !== null;
  const wait = readyIn(d, now);

  // Asked while the user is elsewhere: flash the window and post a notification.
  const wants = asking || d.held !== null;
  useEffect(() => {
    if (wants && !document.hasFocus()) void native().drawattention?.(`Unreal is waiting on a dialog: ${d.title}`).catch(() => false);
  }, [wants, d.id]);

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

  const who = whoLine(d);
  const policy = policyLine(d, now);
  const busy = sent !== null;
  return (
    <div className="approval card dialog-card" role="group" aria-label={`Editor dialog: ${d.title}`}>
      <div className="approval-head">
        <span className="eyebrow">Editor dialog</span>
        {who && <span className="dim small">met by {who}</span>}
      </div>
      <strong className="dialog-title">{d.title || "(untitled dialog)"}</strong>
      {d.message && <pre className="output dialog-message">{d.message}</pre>}
      {rows.length > 0 && (
        <div className="dialog-items" role="group" aria-label="Assets">
          {rows.map((i) => (
            <label key={i.index} className="row toggle small">
              <input
                type="checkbox"
                disabled={!asking || busy}
                checked={ticks[i.index] ?? i.checked}
                onChange={(e) => setTicks({ ...ticks, [i.index]: e.target.checked })}
              />
              <span>{i.label}</span>
              <span className="dim mono">{i.cells.find((c) => c.startsWith("/"))}</span>
            </label>
          ))}
        </div>
      )}
      {error && <div className="banner bad">{error}</div>}
      {d.held ? (
        <>
          <div className="banner warn dialog-hold">
            The agent chose <strong>{d.held.button}</strong>, which discards work. It is pressed in {holdLeft(d, now)} s.
          </div>
          <div className="row approval-actions">
            <button className="primary" disabled={busy} onClick={() => send(d.held!.button, { answer: "release" })}>Press {d.held.button} now</button>
            {d.buttons.filter((b) => b !== d.held!.button).map((b) => (
              <button key={b} disabled={busy} onClick={() => press(b)} title={`Override: press ${b} instead`}>{b} instead</button>
            ))}
          </div>
        </>
      ) : asking ? (
        <>
          <div className="row approval-actions">
            {d.buttons.map((b, i) => (
              <button key={b} className={i === 0 ? "primary" : undefined} disabled={busy || wait > 0} onClick={() => press(b)}>{b}</button>
            ))}
            <button className="ghost" disabled={busy || wait > 0} onClick={() => send("delegate", { answer: "delegate" })} title="The agent picks the answer for this dialog">Let the agent decide</button>
          </div>
          {policy && <div className="dim small">{policy}</div>}
        </>
      ) : d.mode === "auto" ? (
        <>
          <div className="dim small">The agent answers dialogs in this project. You can press one yourself.</div>
          <div className="row approval-actions">
            {d.buttons.map((b) => <button key={b} disabled={busy} onClick={() => press(b)}>{b}</button>)}
          </div>
        </>
      ) : (
        <div className="dim small">Answer it in the editor. Nothing else runs until it is answered.</div>
      )}
    </div>
  );
}

/** A dialog in the transcript: what it asked and how it ended. */
export function DialogLine({ dialog: d }: { dialog: EditorDialog }) {
  const who = whoLine(d);
  return (
    <div className="dialog-line" role="note">
      <span className="eyebrow">Editor dialog</span> <strong>{d.title || "(untitled dialog)"}</strong>
      {who && <span className="dim small"> met by {who}</span>}
      <div className="small">{outcomeLine(d)}</div>
    </div>
  );
}

/** The banner line while a dialog holds the editor. */
export function DialogBannerLine({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const policy = policyLine(d, now);
  return (
    <div className="banner warn editor-banner dialog-banner" role="status">
      <span className="editor-banner-text">
        <strong>Editor waiting on a dialog:</strong> {d.title || "(untitled dialog)"}
        {d.held && <span className="dim"> The agent chose {d.held.button}, pressed in {clock(d.held.until - now)}.</span>}
        {!d.held && policy && <span className="dim"> {policy}</span>}
        {!d.held && !d.asking && d.mode !== "auto" && <span className="dim"> Answer it in the editor.</span>}
      </span>
    </div>
  );
}
