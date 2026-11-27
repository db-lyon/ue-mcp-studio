/**
 * The hub's small pieces: status marks, icons, links that are real anchors,
 * screen heads, empty states and placeholders.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { hubHash, type HubRoute, type StatusGlyph, type StatusLook } from "@ue-mcp-studio/client-core";
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

const ICON_PATHS = {
  arrange: "M2 4h6M5 8h9M2 12h5M2 2.5v11",
  suite: "M3 3h2.5v10H3zM7 3h2.5v10H7zM11 3.5l2.3-.6 2 9.6-2.3.5z",
  queue: "M3 4h10M3 8h10M3 12h6M12 10.5l2 1.5-2 1.5z",
  play: "M5 3.5v9l7.5-4.5z",
  stop: "M4 4h8v8H4z",
  record: "M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z",
  plus: "M8 3v10M3 8h10",
  close: "M4 4l8 8M12 4l-8 8",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  back: "M10 3.5 5.5 8l4.5 4.5",
  chevron: "M6 3.5 10.5 8 6 12.5",
  caret: "M4.5 6.5 8 10l3.5-3.5",
  warn: "M8 2 14.5 13.5h-13zM8 6.5v3.2M8 11.4v.3",
  fit: "M2.5 4v8M13.5 4v8M5 8h6M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2",
  pause: "M5 3.5v9M11 3.5v9",
  edit: "M10.5 2.5l3 3L6 13H3v-3z",
} as const;
export type HubIconName = keyof typeof ICON_PATHS;

export function HubIcon({ name, size = 14 }: { name: HubIconName; size?: number }) {
  const filled = name === "play" || name === "stop" || name === "record";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** A link to a hub screen: a real anchor, so it opens in place, copies, and middle-clicks like any link. */
export function HubLink({ href, onGo, children, ...rest }: { href: string; onGo: () => void; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
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

/** A link to a hub route. */
export function RouteLink({ to, children, ...rest }: { to: HubRoute; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const { go } = useHub();
  return <HubLink {...rest} href={hubHash(to)} onGo={() => go(to)}>{children}</HubLink>;
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

/** A screen's head: the way back when it has one, the title, a line under it and the actions. */
export function ScreenHead({ title, sub, actions, back, compact }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { label: string; route: HubRoute }; compact?: boolean }) {
  return (
    <header className={`hub-head ${compact ? "compact" : ""}`}>
      <div className="hub-head-text">
        {back && <RouteLink className="hub-back small" to={back.route}><HubIcon name="back" size={12} />{back.label}</RouteLink>}
        <h1 className="hub-title">{title}</h1>
        {sub && <div className="hub-sub">{sub}</div>}
      </div>
      {actions && <div className="hub-head-actions">{actions}</div>}
    </header>
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
