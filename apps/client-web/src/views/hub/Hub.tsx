/**
 * The Playtest Hub on the Playtests tab: goals the game must meet, the checks
 * that prove them, their runs and the queue that runs them. A rail on wide
 * screens and a segmented bar on narrow ones move between the screens; each
 * screen has its own URL under #/playtests, so Back works and every goal,
 * check and run can be linked. Keyboard first: j and k move, Enter opens,
 * r runs, g then a letter jumps, Ctrl+K finds anything, ? lists the keys.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlanRequest } from "@ue-mcp-studio/shared";
import {
  GOAL_STATUS_LOOK,
  HUB_COPY,
  HUB_SHORTCUTS,
  hubHash,
  hubKeymap,
  hubPath,
  hubSection,
  paletteEntries,
  parseHubPath,
  searchPalette,
  sortGoals,
  typingTarget,
  type HubKeyAction,
  type HubRoute,
  type PaletteEntry,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { pushLocation, readLocation } from "../../location";
import { HubContext, useHub, type HubContextValue, type HubData } from "./state";
import { HubIcon, HubLink, Kbd, Placeholder, StatusMark, type HubIconName } from "./parts";
import { OverviewScreen } from "./Overview";
import { InboxScreen } from "./Inbox";
import { GoalScreen } from "./Goal";
import { LibraryScreen } from "./Library";
import { CheckScreen } from "./Check";
import { RunScreen } from "./Run";
import { QueueScreen } from "./Queue";
import { CheckPicker, GoalDialog, GoalPicker, RequirePicker } from "./dialogs";
import type { GoalPreset } from "./state";
import { HubLiveProvider } from "./live";
import type { DaemonState } from "../../state";
import type { SettingsSection } from "../settings/sections";
import "./hub.css";

type Overlay =
  | { kind: "palette" }
  | { kind: "shortcuts" }
  | { kind: "goal"; goalId: string | null; preset?: GoalPreset }
  | { kind: "addChecks"; goalId: string }
  | { kind: "require"; goalId: string }
  | { kind: "addToGoal"; checkIds: string[] };

/** The hub screen the hash names, read again on every hashchange (Back, Forward, a pasted link). */
function useHubRoute(): [HubRoute, (r: HubRoute) => void] {
  const [route, setRoute] = useState<HubRoute>(() => parseHubPath(readLocation().sub));
  useEffect(() => {
    const follow = () => {
      const at = readLocation();
      if (at.tab === "Playtests") setRoute(parseHubPath(at.sub));
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const go = (r: HubRoute) => {
    setRoute(r);
    pushLocation({ tab: "Playtests", sub: hubPath(r) || null });
  };
  return [route, go];
}

export function HubView({ data, narrow, onOpenChat, onChat, daemon, onSettings }: {
  data: HubData;
  narrow: boolean;
  /** Open a session, and a playtest's card in it. */
  onOpenChat: (sessionId: string, runId?: string) => void;
  /** Go to the Chat tab, where a playtest is asked for. */
  onChat?: () => void;
  /** The event stream, which the live viewport follows for the editor coming and going. */
  daemon?: Pick<DaemonState, "events">;
  /** Open Settings, from a way forward the live viewport offers. */
  onSettings?: (s: SettingsSection) => void;
}) {
  const [route, go] = useHubRoute();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad"; n: number } | null>(null);
  const screenKeys = useRef<((a: HubKeyAction) => boolean) | null>(null);
  screenKeys.current = null;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "bad" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast?.n]);
  const notify = (text: string, tone: "ok" | "bad" = "ok") => setToast((t) => ({ text, tone, n: (t?.n ?? 0) + 1 }));

  const runPlan = async (req: PlanRequest, what?: string) => {
    try {
      const { plan } = await api.hub.plan(req);
      const n = plan.items.length;
      notify(`Queued ${what ?? plan.title}: ${n} ${n === 1 ? "check" : "checks"}`);
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const runCheck = async (checkId: string, name?: string) => {
    try {
      await api.hub.runCheck(checkId);
      notify(`Queued ${name ?? "the check"}`);
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };

  // Keys: read through refs so one listener serves every render.
  const latest = useRef({ overlay, go, route });
  latest.current = { overlay, go, route };
  useEffect(() => {
    const keys = hubKeymap();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const { overlay: open, go: goTo } = latest.current;
      const palette = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
      if (open && !palette) return;
      // A modal over the hub (the full live viewer) has the keys: p must not pass a verdict behind it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const t = e.target as HTMLElement | null;
      if (!palette && typingTarget(t)) return;
      // Enter and Space on a focused control press it; they are not the hub's.
      if ((e.key === "Enter" || e.key === " ") && t && (t.tagName === "BUTTON" || t.tagName === "A")) return;
      const a = keys.press({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
      if (!a) return;
      if (a.type === "palette") setOverlay((o) => (o?.kind === "palette" ? null : { kind: "palette" }));
      else if (a.type === "go") goTo({ screen: a.to });
      else if (a.type === "help") setOverlay({ kind: "shortcuts" });
      else if (a.type === "newGoal") setOverlay({ kind: "goal", goalId: null });
      else if (!screenKeys.current?.(a)) return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const o = data.overview;
  if (!o) {
    return (
      <div className="playhub hub-loading">
        {data.error ? <div className="banner bad" role="alert">The hub did not load: {data.error} <button className="small-button" onClick={data.reload}>Try again</button></div> : <Placeholder rows={6} />}
      </div>
    );
  }

  const ctx: HubContextValue = {
    o,
    data,
    route,
    go,
    narrow,
    notify,
    runPlan,
    runCheck,
    openChat: onOpenChat,
    editGoal: (goalId, preset) => setOverlay({ kind: "goal", goalId, preset }),
    addChecks: (goalId) => setOverlay({ kind: "addChecks", goalId }),
    requireGoal: (goalId) => setOverlay({ kind: "require", goalId }),
    addToGoal: (checkIds) => setOverlay({ kind: "addToGoal", checkIds }),
    onKeys: (h) => {
      screenKeys.current = h;
    },
  };

  const screen = (() => {
    switch (route.screen) {
      case "overview": return <OverviewScreen onChat={onChat} />;
      case "inbox": return <InboxScreen />;
      case "goal": return <GoalScreen key={route.goalId} goalId={route.goalId} />;
      case "library": return <LibraryScreen />;
      case "check": return <CheckScreen key={route.checkId} checkId={route.checkId} />;
      case "run": return <RunScreen key={route.runId} runId={route.runId} />;
      case "queue": return <QueueScreen />;
    }
  })();

  return (
    <HubContext.Provider value={ctx}>
      <HubLiveProvider daemon={daemon} onSettings={onSettings}>
      <div className={`playhub ${narrow ? "narrow" : "wide"}`}>
        {narrow ? <HubBar onPalette={() => setOverlay({ kind: "palette" })} /> : <HubRail onPalette={() => setOverlay({ kind: "palette" })} onShortcuts={() => setOverlay({ kind: "shortcuts" })} />}
        <div className="hub-main">
          {data.error && <div className="banner warn small" role="alert">Could not refresh: {data.error}</div>}
          {screen}
        </div>
        {toast && <div className={`hub-toast ${toast.tone}`} role="status">{toast.text}<button className="ghost small-button" aria-label="Dismiss" onClick={() => setToast(null)}><HubIcon name="close" size={12} /></button></div>}
        {overlay?.kind === "palette" && <Palette onClose={() => setOverlay(null)} onShortcuts={() => setOverlay({ kind: "shortcuts" })} onNewGoal={() => setOverlay({ kind: "goal", goalId: null })} />}
        {overlay?.kind === "shortcuts" && <Shortcuts onClose={() => setOverlay(null)} />}
        {overlay?.kind === "goal" && <GoalDialog goalId={overlay.goalId} preset={overlay.preset} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "addChecks" && <CheckPicker goalId={overlay.goalId} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "require" && <RequirePicker goalId={overlay.goalId} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "addToGoal" && <GoalPicker checkIds={overlay.checkIds} onClose={() => setOverlay(null)} />}
      </div>
      </HubLiveProvider>
    </HubContext.Provider>
  );
}

const SECTIONS: ReadonlyArray<{ id: "overview" | "inbox" | "library" | "queue"; label: string; icon: HubIconName; keys: string }> = [
  { id: "overview", label: HUB_COPY.overview, icon: "overview", keys: "g o" },
  { id: "inbox", label: HUB_COPY.inbox, icon: "inbox", keys: "g i" },
  { id: "library", label: HUB_COPY.library, icon: "library", keys: "g l" },
  { id: "queue", label: HUB_COPY.queue, icon: "queue", keys: "g q" },
];

function sectionCount(id: string, ctx: Pick<HubContextValue, "o">): ReactNode {
  const { o } = ctx;
  if (id === "inbox" && o.inbox.length) return <span className="tab-count warn" aria-label={`${o.inbox.length} waiting`}>{o.inbox.length}</span>;
  if (id === "queue" && o.queue.current) return <span className="hub-live-dot" aria-label="Running" title="Running" />;
  if (id === "library") return <span className="hub-rail-count">{o.checks.length}</span>;
  return null;
}

/** The wide hub's rail: the four screens, then every goal by status, then New goal. */
function HubRail({ onPalette, onShortcuts }: { onPalette: () => void; onShortcuts: () => void }) {
  const ctx = useHub();
  const { o, route, go } = ctx;
  const at = hubSection(route);
  const goals = useMemo(() => sortGoals(o.goals.filter((g) => !g.goal.archived)), [o.goals]);
  return (
    <nav className="hub-rail" aria-label="Playtests">
      <button className="hub-find" onClick={onPalette} title="Find a goal, check or run (Ctrl+K)">
        <HubIcon name="search" />
        <span>Find or run</span>
        <span className="spacer" />
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="hub-rail-group">
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash({ screen: s.id } as HubRoute)} onGo={() => go({ screen: s.id } as HubRoute)} className={`hub-rail-item ${at === s.id && route.screen !== "goal" ? "active" : ""}`} title={`${s.label} (${s.keys})`}>
            <HubIcon name={s.icon} />
            <span className="hub-rail-label">{s.label}</span>
            {sectionCount(s.id, ctx)}
          </HubLink>
        ))}
      </div>
      <div className="hub-rail-head">
        <span>{HUB_COPY.goals}</span>
        <span className="spacer" />
        <button className="ghost icon-button" aria-label={HUB_COPY.newGoal} title={`${HUB_COPY.newGoal} (c)`} onClick={() => ctx.editGoal(null)}><HubIcon name="plus" size={12} /></button>
      </div>
      <div className="hub-rail-goals">
        {goals.length === 0 && <p className="dim small hub-rail-note">None yet.</p>}
        {goals.map((g) => (
          <HubLink key={g.goal.id} href={hubHash({ screen: "goal", goalId: g.goal.id })} onGo={() => go({ screen: "goal", goalId: g.goal.id })}
            className={`hub-rail-item goal ${route.screen === "goal" && route.goalId === g.goal.id ? "active" : ""}`} title={`${g.goal.title}: ${GOAL_STATUS_LOOK[g.status].label}`}>
            <StatusMark look={GOAL_STATUS_LOOK[g.status]} />
            <span className="hub-rail-label">{g.goal.title}</span>
            {g.goal.kind === "milestone" && <HubIcon name="milestone" size={12} />}
          </HubLink>
        ))}
      </div>
      <button className="ghost hub-rail-keys" onClick={onShortcuts}><HubIcon name="keyboard" /> {HUB_COPY.shortcuts} <Kbd>?</Kbd></button>
    </nav>
  );
}

/** The narrow hub's bar: the four screens side by side, and the palette for everything else. */
function HubBar({ onPalette }: { onPalette: () => void }) {
  const ctx = useHub();
  const at = hubSection(ctx.route);
  return (
    <div className="hub-bar">
      <nav className="hub-seg" aria-label="Playtests">
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash({ screen: s.id } as HubRoute)} onGo={() => ctx.go({ screen: s.id } as HubRoute)} className={`hub-seg-item ${at === s.id ? "active" : ""}`}>
            <span>{s.label}</span>
            {s.id !== "library" && sectionCount(s.id, ctx)}
          </HubLink>
        ))}
      </nav>
      <button className="ghost icon-button" aria-label="Find or run" onClick={onPalette}><HubIcon name="search" /></button>
    </div>
  );
}

/** Ctrl+K: jump to any goal, check or recent run, or run one, by typing a few letters of it. */
function Palette({ onClose, onShortcuts, onNewGoal }: { onClose: () => void; onShortcuts: () => void; onNewGoal: () => void }) {
  const ctx = useHub();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const entries = useMemo(() => paletteEntries(ctx.o), [ctx.o]);
  const shown = useMemo(() => searchPalette(entries, q), [entries, q]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [q]);
  const pick = (e: PaletteEntry | undefined) => {
    if (!e) return;
    onClose();
    if (e.route) return ctx.go(e.route);
    const c = e.command;
    if (c === "newGoal") onNewGoal();
    else if (c === "shortcuts") onShortcuts();
    else if (c === "runFailing") void ctx.runPlan({ scope: { kind: "failing" } }, "every failing check");
    else if (c === "runAll") void ctx.runPlan({ scope: { kind: "all" } }, "every check");
    else if (c && typeof c === "object" && "runGoal" in c) {
      const g = ctx.o.goals.find((x) => x.goal.id === c.runGoal);
      void ctx.runPlan({ scope: { kind: "goal", goalId: c.runGoal } }, g?.goal.title);
    } else if (c && typeof c === "object" && "runCheck" in c) void ctx.runCheck(c.runCheck, ctx.o.checks.find((x) => x.id === c.runCheck)?.name);
  };
  const move = (d: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, at + d));
    setAt(next);
    const row = list.current?.children[next] as HTMLElement | undefined;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="overlay hub-overlay-top" onClick={onClose}>
      <div className="overlay-card hub-palette" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="hub-palette-input">
          <HubIcon name="search" />
          <input
            autoFocus
            value={q}
            placeholder={HUB_COPY.palettePlaceholder}
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="hub-palette-list"
            aria-activedescendant={shown[at] ? `hub-pal-${at}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); move(1); }
              else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); move(-1); }
              else if (e.key === "Enter") { e.preventDefault(); pick(shown[at]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="hub-palette-list" id="hub-palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <p className="dim small hub-palette-empty">{HUB_COPY.paletteEmpty}</p>}
          {shown.map((e, i) => (
            <div key={e.id} id={`hub-pal-${i}`} role="option" aria-selected={i === at} className={`hub-palette-row ${i === at ? "on" : ""}`} onMouseMove={() => i !== at && setAt(i)} onClick={() => pick(e)}>
              {e.look ? <StatusMark look={e.look} /> : <HubIcon name={e.kind === "screen" ? "chevron" : e.command === "newGoal" ? "plus" : e.command === "shortcuts" ? "keyboard" : "play"} />}
              <span className="hub-palette-label">{e.label}</span>
              {e.hint && <span className="hub-palette-hint">{e.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ?: every key the hub answers to. */
function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const groups = ["Go to", "Move", "Act"] as const;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card hub-shortcuts" role="dialog" aria-label={HUB_COPY.shortcuts} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">{HUB_COPY.shortcuts}<span className="spacer" /><button className="ghost" onClick={onClose}>Close</button></div>
        <div className="hub-shortcut-groups">
          {groups.map((g) => (
            <section key={g}>
              <h2>{g}</h2>
              <dl>
                {HUB_SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.label} className="hub-shortcut">
                    <dt>{s.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

