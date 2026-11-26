/**
 * The hub's small pieces, drawn the same on every screen: the status mark
 * (one shape per status, so none relies on colour), the status pill, the
 * win/loss sparkline, the progress bar, keys and icons.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { RunOutcome } from "@ue-mcp-studio/shared";
import { AGENT_FIXES_COPY, AGENT_FIXES_SECTION, HUB_COPY, HUB_TRAIL_COPY, hubHash, sparkBars, sparkLabel, trailCrumbs, trailHasBack, type HubCrumb, type HubRoute, type StatusGlyph, type StatusLook } from "@ue-mcp-studio/client-core";
import { formatLocation, pushLocation, readLocation } from "../../location";
import { useHub } from "./state";

const SHAPES: Record<StatusGlyph, ReactNode> = {
  check: <><circle cx="8" cy="8" r="6.5" className="fill" /><path d="M5 8.2l2 2 4-4.2" className="cut" /></>,
  fail: <><circle cx="8" cy="8" r="6.5" className="fill" /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" className="cut" /></>,
  needs: <><path d="M8 1.2l6.8 6.8L8 14.8 1.2 8z" className="fill" /><path d="M8 4.8v3.6M8 10.6v.4" className="cut" /></>,
  missing: <><circle cx="8" cy="8" r="6" className="line" strokeDasharray="2.4 1.8" /><path d="M6.3 6.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2v.2" className="line" /></>,
  running: <><circle cx="8" cy="8" r="6" className="line" /><path d="M8 2a6 6 0 0 1 0 12z" className="fill" /></>,
  flaky: <><circle cx="8" cy="8" r="6" className="line" /><path d="M4.6 9l1.7-2.6 1.7 3.2 1.7-3.2 1.7 2.6" className="line" /></>,
  stale: <><circle cx="8" cy="8" r="6" className="line" /><path d="M8 4.8V8l2.2 1.4" className="line" /></>,
  never: <circle cx="8" cy="8" r="6" className="line" strokeDasharray="1.2 2.2" />,
  risk: <><path d="M8 1.8l6.4 11.4H1.6z" className="line" /><path d="M8 6.4v3M8 11.2v.2" className="line" /></>,
  skip: <><circle cx="8" cy="8" r="6" className="line" /><path d="M4.2 11.8l7.6-7.6" className="line" /></>,
  stop: <rect x="2.8" y="2.8" width="10.4" height="10.4" rx="2" className="fill" />,
  queued: <circle cx="8" cy="8" r="5.5" className="line" />,
};

/** A status's mark. `label` makes it an image with that name; without it, it is decoration beside a visible label. */
export function StatusMark({ look, label, size = 14 }: { look: StatusLook; label?: string; size?: number }) {
  return (
    <svg className={`hub-mark tone-${look.tone} glyph-${look.glyph}`} width={size} height={size} viewBox="0 0 16 16" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {label && <title>{label}</title>}
      {SHAPES[look.glyph]}
    </svg>
  );
}

/** Mark and label together: the status as every list and header shows it. */
export function StatusPill({ look, children }: { look: StatusLook; children?: ReactNode }) {
  return (
    <span className={`hub-status tone-${look.tone}`}>
      <StatusMark look={look} />
      <span>{children ?? look.label}</span>
    </span>
  );
}

/** Recent outcomes, oldest to newest: passes above the line, failures below, anything else a tick on it. */
export function WinLoss({ recent, max = 20, wide = false }: { recent: readonly RunOutcome[]; max?: number; wide?: boolean }) {
  const bars = sparkBars(recent, max);
  const bw = wide ? 6 : 4;
  const w = Math.max(bw * max, 8);
  return (
    <svg className="hub-spark" width={w} height={wide ? 24 : 16} viewBox={`0 0 ${w} 16`} preserveAspectRatio="none" role="img" aria-label={sparkLabel(recent)}>
      <title>{sparkLabel(recent)}</title>
      <line x1="0" x2={w} y1="8" y2="8" className="hub-spark-axis" />
      {bars.map((b, i) => {
        const x = w - (bars.length - i) * bw;
        const y = b.dir === "up" ? 1 : b.dir === "down" ? 9 : 7;
        const h = b.dir === "mid" ? 2 : 6;
        return <rect key={i} x={x + 0.5} y={y} width={bw - 1.5} height={h} rx="0.6" className={`tone-${b.tone}`} />;
      })}
    </svg>
  );
}

/** Required checks meeting the rule, out of all of them. */
export function Progress({ met, total, label }: { met: number; total: number; label?: string }) {
  const pct = total ? Math.round((met / total) * 100) : 0;
  return (
    <span className="hub-progress" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={met} aria-label={label ?? `${met} of ${total}`}>
      <span className="hub-progress-track"><span className="hub-progress-fill" style={{ width: `${pct}%` }} /></span>
      <span className="hub-progress-text mono">{met}/{total}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="hub-kbd">{children}</kbd>;
}

const ICON_PATHS = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  attention: "M2.5 9.5 4 3.5h8l1.5 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM2.5 9.5h3.2l.8 1.6h3l.8-1.6h3.2",
  library: "M3 3h2.5v10H3zM7 3h2.5v10H7zM11 3.5l2.3-.6 2 9.6-2.3.5z",
  queue: "M3 4h10M3 8h10M3 12h6M12 10.5l2 1.5-2 1.5z",
  goal: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  milestone: "M3.5 14V2.5M3.5 3h8l-1.8 2.8 1.8 2.7h-8",
  play: "M5 3.5v9l7.5-4.5z",
  plus: "M8 3v10M3 8h10",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14",
  pause: "M5 3.5v9M11 3.5v9",
  up: "M8 12.5v-9M4.5 7 8 3.5 11.5 7",
  down: "M8 3.5v9M4.5 9 8 12.5 11.5 9",
  close: "M4 4l8 8M12 4l-8 8",
  edit: "M10.5 2.5l3 3L6 13H3v-3z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  copy: "M5.5 5.5h7.5v7.5H5.5zM3 10.5V3h7.5",
  assign: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.8-2.2 2.7-3.5 5-3.5s4.2 1.3 5 3.5",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  external: "M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5",
  sparkle: "M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2",
  calendar: "M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3",
  chevron: "M6 3.5 10.5 8 6 12.5",
  caret: "M4.5 6.5 8 10l3.5-3.5",
  back: "M10 3.5 5.5 8l4.5 4.5",
  keyboard: "M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6",
  expand: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
  warn: "M8 2 14.5 13.5h-13zM8 6.5v3.2M8 11.4v.3",
  stop: "M4 4h8v8H4z",
  loop: "M2.5 8V6.5a2 2 0 0 1 2-2h8M10.5 2.5l2 2-2 2M13.5 8v1.5a2 2 0 0 1-2 2h-8M5.5 13.5l-2-2 2-2",
  fit: "M2.5 4v8M13.5 4v8M5 8h6M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2",
  focus: "M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M6 8h4",
  arrange: "M2 4h6M5 8h9M2 12h5M2 2.5v11",
} as const;
export type HubIconName = keyof typeof ICON_PATHS;

export function HubIcon({ name, size = 14 }: { name: HubIconName; size?: number }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** A link to a hub screen: a real anchor, so it opens in place, copies, and middle-clicks like any link. */
export function HubLink({ href, onGo, children, ...rest }: { href: string; onGo: () => void; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & { "data-row"?: string }) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onGo();
      }}
    >
      {children}
    </a>
  );
}

/** Where a Fix button would be while Fix failing clips with an agent is off: one quiet line, and the way to the setting. */
export function AgentFixesOff() {
  const to = { tab: "Settings" as const, section: AGENT_FIXES_SECTION, sub: null };
  return (
    <span className="muted hub-fixes-off">
      {AGENT_FIXES_COPY.off}{" "}
      <HubLink href={formatLocation({ ...readLocation(), ...to, session: null })} onGo={() => pushLocation(to)}>{AGENT_FIXES_COPY.turnOn}</HubLink>
    </span>
  );
}

/** An empty state: what this place is for and the one or two things to do next. */
export function Empty({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="hub-empty">
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
      {actions && <div className="hub-empty-actions">{actions}</div>}
    </div>
  );
}

/**
 * A form field: its label names the control, and an error is the control's
 * description, so a screen reader hears the name and then what is wrong.
 */
export function HubField({ id, label, error, children }: {
  id: string;
  label: string;
  error?: string;
  children: (a: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  return (
    <div className="hub-field">
      <label htmlFor={id} className="hub-field-label">{label}</label>
      {children({ id, "aria-invalid": !!error, ...(error ? { "aria-describedby": `${id}-error` } : {}) })}
      {error && <span className="hub-error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

/** A screen's head: a way back, title, a line under it, and its actions at the end. */
/**
 * A screen's head. Above the title, the way the user came (breadcrumbs, each
 * going back to that screen); a screen reached fresh shows `back`, its parent
 * in the hub's map, instead.
 */
export function ScreenHead({ title, eyebrow, sub, actions, back, compact }: { title: ReactNode; eyebrow?: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { label: string; route: HubRoute }; compact?: boolean }) {
  const { go, trail } = useHub();
  return (
    <header className={`hub-head ${compact ? "compact" : ""}`}>
      <div className="hub-head-text">
        {trailHasBack(trail) ? <Crumbs /> : back && <HubLink className="hub-back small" href={hubHash(back.route)} onGo={() => go(back.route)}><HubIcon name="back" size={12} />{back.label}</HubLink>}
        {eyebrow && <div className="hub-eyebrow">{eyebrow}</div>}
        <h1 className="hub-title">{title}</h1>
        {sub && <div className="hub-sub">{sub}</div>}
      </div>
      {actions && <div className="hub-head-actions">{actions}</div>}
    </header>
  );
}

/** The trail as breadcrumbs: back to the screen before, then every screen on the way, the one on show last. */
function Crumbs() {
  const { o, trail, goBack } = useHub();
  const { crumbs, folded } = trailCrumbs(trail, o);
  const prev = crumbs[crumbs.length - 2];
  const href = (c: HubCrumb) => (c.route ? hubHash(c.route) : `#/${c.label.toLowerCase()}`);
  return (
    <nav className="hub-crumbs small" aria-label={HUB_TRAIL_COPY.trail}>
      {prev && <HubLink className="hub-back" href={href(prev)} onGo={() => goBack(1)} aria-label={`${HUB_TRAIL_COPY.back}: ${prev.label}`} title={`${HUB_TRAIL_COPY.back}: ${prev.label}`}><HubIcon name="back" size={12} /></HubLink>}
      {folded > 0 && <span className="hub-crumb-fold dim" aria-hidden="true">…</span>}
      {crumbs.map((c, i) => (
        <span key={`${c.steps}`} className="hub-crumb">
          {(i > 0 || folded > 0) && <span className="hub-crumb-sep dim" aria-hidden="true">/</span>}
          {c.steps === 0
            ? <span aria-current="page">{c.label}</span>
            : <HubLink href={href(c)} onGo={() => goBack(c.steps)}>{c.label}</HubLink>}
        </span>
      ))}
    </nav>
  );
}

/** Placeholder rows while the first answer is on its way. */
export function Placeholder({ rows = 4 }: { rows?: number }) {
  return (
    <div className="hub-placeholder" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <span key={i} className="hub-placeholder-row" style={{ width: `${88 - i * 9}%` }} />)}
    </div>
  );
}
