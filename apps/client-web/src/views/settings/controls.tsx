/** The controls every Settings section is built from, so each reads the same way. */
import { useEffect, useState, type ReactNode } from "react";

/** One choice of a few, shown side by side. */
export function Seg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T | null;
  options: ReadonlyArray<{ id: T; name: string; title?: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className={`seg ${options.length >= 3 || options.reduce((n, o) => n + o.name.length, 0) > 24 ? "many" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? "on" : ""}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => value !== o.id && onChange(o.id)}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

/** A setting on one line: what it is and what it does, with its control at the end. */
export function Row({ title, help, children, badge, inline }: { title: ReactNode; help?: ReactNode; children?: ReactNode; badge?: ReactNode; inline?: boolean }) {
  return (
    <div className={`toggle-row ${inline ? "inline" : ""}`}>
      <div className="grow">
        <div className="t">{title}{badge}</div>
        {help && <div className="d">{help}</div>}
      </div>
      {children}
    </div>
  );
}

/** "Shared with other clients": the value lives in ue-mcp, so every MCP client on the project follows it. */
export function Shared() {
  return <span className="shared" title="ue-mcp stores this for the project, so every MCP client connected to it follows the same setting.">Shared with other clients</span>;
}

/** A choice with a sentence under it. */
export function Opt({ on, onPick, title, desc, name, disabled, overridden }: { on: boolean; onPick: () => void; title: ReactNode; desc?: ReactNode; name: string; disabled?: boolean; overridden?: boolean }) {
  return (
    <label className={`opt ${on ? "on" : ""} ${overridden ? "overridden" : ""}`}>
      <input type="radio" name={name} checked={on} disabled={disabled} onChange={() => onPick()} />
      <span>
        <span className="t">{title}</span>
        {desc && <span className="d"> {desc}</span>}
      </span>
    </label>
  );
}

export function Card({ label, children, actions, className = "" }: { label?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {label && (
        <h2 className="cfg-label">
          {label}
          {actions && <><span className="spacer" />{actions}</>}
        </h2>
      )}
      {children}
    </section>
  );
}

/**
 * A whole number typed into a box, saved on blur or Enter. Empty is null
 * where `nullable`; anything out of range shows why and is not saved.
 */
export function NumberField({ value, onSave, min, max, nullable, label, placeholder = "none", className = "cfg-num" }: {
  value: number | null;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
  nullable?: boolean;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value === null ? "" : value.toLocaleString("en-US"));
  useEffect(() => setText(value === null ? "" : value.toLocaleString("en-US")), [value]);
  const raw = text.replace(/[,\s_]/g, "");
  const n = Number(raw);
  const valid = raw === "" ? !!nullable : Number.isInteger(n) && n >= min && n <= max;
  const save = () => {
    const next = raw === "" ? null : n;
    if (valid && next !== value) onSave(next);
  };
  return (
    <input
      className={`${className} num`}
      inputMode="numeric"
      aria-label={label}
      aria-invalid={!valid}
      title={valid ? undefined : `${nullable ? "Empty for none, or " : ""}a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`}
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
    />
  );
}

/** A colour per agent id, stable across renders, readable on every theme. */
const AVATAR_COLORS = ["#e8a06a", "#9aa0a6", "#6aaee8", "#7fcf9a", "#c79bea", "#e3cd6a", "#ef8f8f", "#7fd3d3"];
export function avatarColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function Avatar({ id, name, small }: { id: string; name: string; small?: boolean }) {
  return <span className={`avatar ${small ? "sm" : ""}`} style={{ background: avatarColor(id) }} title={name} aria-hidden>{initials(name)}</span>;
}

/** Tokens as people read them: 950, 12k, 1.4M. */
export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "none";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <>
      <div className="cfg-scrim" onClick={onClose} />
      <div className="cfg-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cfg-sheet-head">
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </>
  );
}

/** A message under a section: saved, or what went wrong. */
export function useMessage() {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const node = message ? <div className={`banner ${message.ok ? "ok" : "bad"}`} role={message.ok ? "status" : "alert"} onClick={() => setMessage(null)}>{message.text}</div> : null;
  return { node, ok: (text: string) => setMessage({ ok: true, text }), fail: (e: Error | string) => setMessage({ ok: false, text: typeof e === "string" ? e : e.message }), clear: () => setMessage(null) };
}
