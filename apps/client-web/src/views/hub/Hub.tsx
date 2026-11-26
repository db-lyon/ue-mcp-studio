/**
 * The Playtest Hub on the Playtests tab: goals the game must meet, the
 * playtests that prove them, and their runs; what runs now is a strip on the
 * Overview, and the Queue screen holds what waits, its order and schedules.
 * After a person's Run the toast says where the plan went, with Run next and
 * Open queue when it waits behind other work. A rail on wide
 * screens and a segmented bar on narrow ones move between the screens; each
 * screen has its own URL under #/playtests, so Back works and every goal,
 * check and run can be linked. Keyboard first: j and k move, Enter opens,
 * r runs, g then a letter jumps, Ctrl+K finds anything, ? lists the keys.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { PlanRequest, PlanRun } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  HUB_RECENT_KEY,
  SET_COPY,
  arrangementOn,
  hubHash,
  hubKeymap,
  hubPath,
  hubSection,
  hubShortcuts,
  paletteEntries,
  parseHubPath,
  parseRecent,
  rememberRecent,
  runFeedback,
  searchPalette,
  trailOf,
  trailPush,
  typingTarget,
  type HubTrail,
  type HubKeyAction,
  type HubRecent,
  type HubRoute,
  type PaletteEntry,
  type RunFeedback,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { historyState, pushLocation, readLocation, writeLocation } from "../../location";
import { HubContext, useAgentFixes, useHub, type HubContextValue, type HubData, type LeaveGuard } from "./state";
import { HubIcon, HubLink, Kbd, Placeholder, StatusMark, type HubIconName } from "./parts";
import { OverviewScreen } from "./Overview";
import { GoalScreen } from "./Goal";
import { GoalsScreen } from "./Goals";
import { MilestonesScreen } from "./Milestones";
import { LibraryScreen } from "./Library";
import { CheckScreen } from "./Check";
import { RunScreen } from "./Run";
import { DraftScreen } from "./Draft";
import { QueueScreen } from "./Queue";
import { ClipsScreen } from "./Clips";
import { ClipRunView } from "./TimelineRun";
import { ArrangementScreen } from "./Arrangement";
import { CheckPicker, DeleteDialog, DescribeDialog, GoalDeleteDialog, GoalDialog, GoalPicker, LeaveDialog, RequirePicker } from "./dialogs";
import type { GoalPreset } from "./state";
import "./hub.css";

type Overlay =
  | { kind: "palette" }
  | { kind: "shortcuts" }
  | { kind: "goal"; goalId: string | null; preset?: GoalPreset }
  | { kind: "addChecks"; goalId: string }
  | { kind: "require"; goalId: string }
  | { kind: "addToGoal"; checkIds: string[] }
  | { kind: "delete"; checkIds: string[]; onDone?: (deleted: string[]) => void }
  | { kind: "deleteGoal"; goalId: string; onDone?: () => void }
  | { kind: "describe" };

/**
 * The hub screen the hash names, read again on every hashchange (Back,
 * Forward, a pasted link). While a screen has unsaved changes (`guard`), a
 * hashchange away puts the hash back and asks through `onBlocked` instead.
 */
function useHubRoute(guard: MutableRefObject<LeaveGuard | null>, onBlocked: (r: HubRoute) => void): [HubRoute, (r: HubRoute) => void, HubTrail] {
  const [{ route, trail }, setAt] = useState<{ route: HubRoute; trail: HubTrail }>(() => {
    const r = parseHubPath(readLocation().sub);
    return { route: r, trail: trailOf(historyState(), r) };
  });
  const current = useRef({ route, trail });
  current.current = { route, trail };
  useEffect(() => {
    // Back, Forward, a crumb or a pasted link: the entry's own trail comes with it, or a fresh one.
    const follow = () => {
      const at = readLocation();
      if (at.tab !== "Playtests") return;
      const next = parseHubPath(at.sub);
      const nextTrail = trailOf(historyState(), next);
      if (hubPath(next) === hubPath(current.current.route)) {
        if (nextTrail.routes.length !== current.current.trail.routes.length) setAt({ route: current.current.route, trail: nextTrail });
        return;
      }
      if (guard.current?.dirty()) {
        writeLocation({ tab: "Playtests", sub: hubPath(current.current.route) || null });
        onBlocked(next);
        return;
      }
      current.current = { route: next, trail: nextTrail };
      setAt(current.current);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const go = (r: HubRoute) => {
    const t = trailPush(current.current.trail, r);
    current.current = { route: r, trail: t };
    setAt(current.current);
    pushLocation({ tab: "Playtests", sub: hubPath(r) || null }, { hubTrail: t });
  };
  return [route, go, trail];
}

export function HubView({ data, narrow, onOpenChat, onChat, canDeleteGoals = false, events, health }: {
  data: HubData;
  /** The daemon's recent events and health, which the timeline follows runs by. */
  events?: HubContextValue["events"];
  health?: unknown;
  narrow: boolean;
  /** The daemon offers deleting goals (canDeleteGoals of its health). */
  canDeleteGoals?: boolean;
  /** Open a session, and a playtest's card in it. */
  onOpenChat: (sessionId: string, runId?: string) => void;
  /** Go to the Chat tab, where a playtest is asked for. */
  onChat?: () => void;
}) {
  const guard = useRef<LeaveGuard | null>(null);
  const [leaving, setLeaving] = useState<HubRoute | null>(null);
  const [route, moveTo, trail] = useHubRoute(guard, setLeaving);
  // Every way to another screen asks first while the editor has unsaved changes.
  // A new screen opens at its top, so a record reached from a link or a row is the first thing shown;
  // one returned to by Back opens where it was left, kept in its history entry.
  const main = useRef<HTMLDivElement>(null);
  const keepScroll = () => {
    if (main.current) window.history.replaceState({ ...(window.history.state ?? {}), hubScroll: main.current.scrollTop }, "");
  };
  const at = hubPath(route);
  useEffect(() => {
    const kept = (historyState() as { hubScroll?: unknown } | null)?.hubScroll;
    if (main.current) main.current.scrollTop = typeof kept === "number" ? kept : 0;
  }, [at]);
  const go = (r: HubRoute) => {
    if (guard.current?.dirty() && hubPath(r) !== hubPath(route)) return setLeaving(r);
    keepScroll();
    moveTo(r);
  };
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad"; n: number; actions?: ToastAction[] } | null>(null);
  const screenKeys = useRef<((a: HubKeyAction) => boolean) | null>(null);
  screenKeys.current = null;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "bad" || toast.actions?.length ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast?.n]);
  const notify = (text: string, tone: "ok" | "bad" = "ok", actions?: ToastAction[]) => setToast((t) => ({ text, tone, n: (t?.n ?? 0) + 1, ...(actions?.length ? { actions } : {}) }));

  /** After a person's Run: where the plan went, with Run next and Open queue when it waits behind other work. */
  const ranFeedback = (plan: PlanRun, f: RunFeedback) => {
    const actions: ToastAction[] = [];
    if (f.runNext) {
      actions.push({
        label: HUB_COPY.runNext,
        run: async () => {
          try {
            await api.hub.movePlan(plan.id, 0);
            notify(`${plan.title} runs next`);
          } catch (e) {
            notify((e as Error).message, "bad");
          }
          data.reload();
        },
      });
    }
    if (f.openQueue) actions.push({ label: HUB_COPY.openQueue, run: () => go({ screen: "queue" }) });
    notify(f.text, f.tone, actions);
  };
  const runPlan = async (req: PlanRequest, what?: string) => {
    try {
      const { plan, placement } = await api.hub.plan(req);
      ranFeedback(plan, runFeedback(what ?? plan.title, placement, plan.items.length));
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const runCheck = async (checkId: string, name?: string) => {
    try {
      const { plan, placement } = await api.hub.runCheck(checkId);
      ranFeedback(plan, runFeedback(name ?? "the clip", placement));
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
      <div className="hub-root hub-loading">
        {data.error ? <div className="banner bad" role="alert">Clips did not load: {data.error} <button className="small-button" onClick={data.reload}>Try again</button></div> : <Placeholder rows={6} />}
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
    deleteChecks: (checkIds, onDone) => setOverlay({ kind: "delete", checkIds, onDone }),
    canDeleteGoals,
    deleteGoal: (goalId, onDone) => setOverlay({ kind: "deleteGoal", goalId, onDone }),
    describePlaytest: () => setOverlay({ kind: "describe" }),
    onKeys: (h) => {
      screenKeys.current = h;
    },
    guardLeave: (g) => {
      guard.current = g;
    },
    trail,
    events,
    health,
    // The browser's own history: the entry there holds the screen and its trail, and the leave guard still asks.
    goBack: (steps) => {
      keepScroll();
      window.history.go(-steps);
    },
  };

  const screen = (() => {
    switch (route.screen) {
      case "overview": return <OverviewScreen onChat={onChat} />;
      case "milestones": return <MilestonesScreen />;
      case "goals": return <GoalsScreen />;
      case "goal": return <GoalScreen key={route.goalId} goalId={route.goalId} />;
      case "library": return <LibraryScreen />;
      case "check": return <CheckScreen key={route.checkId} checkId={route.checkId} />;
      case "run": return <RunScreen key={route.runId} runId={route.runId} />;
      case "draft": return <DraftScreen key={hubPath(route)} checkId={route.checkId} goalId={route.goalId} />;
      case "queue": return <QueueScreen />;
      case "clips": return <ClipsScreen />;
      case "clip": return <ClipRunView key={route.path} path={route.path} />;
      case "arrangement": return <ArrangementScreen />;
    }
  })();

  return (
    <HubContext.Provider value={ctx}>
      {/* The Arrangement takes the whole page, as a DAW's does: the rail folds to its icons and the screen fills the height. */}
      <div className={`hub-root ${narrow ? "narrow" : "wide"} ${route.screen === "arrangement" ? "slim" : ""}`}>
        {narrow ? <HubBar onPalette={() => setOverlay({ kind: "palette" })} /> : <HubRail onPalette={() => setOverlay({ kind: "palette" })} onShortcuts={() => setOverlay({ kind: "shortcuts" })} />}
        <div className={`hub-main ${route.screen === "arrangement" ? "fill" : ""}`} ref={main}>
          {data.error && <div className="banner warn small" role="alert">Could not refresh: {data.error}</div>}
          {screen}
        </div>
        {toast && (
          <div className={`hub-toast ${toast.tone}`} role="status">
            {toast.text}
            {toast.actions?.map((a) => <button key={a.label} className="small-button" onClick={() => { setToast(null); void a.run(); }}>{a.label}</button>)}
            <button className="ghost small-button" aria-label="Dismiss" onClick={() => setToast(null)}><HubIcon name="close" size={12} /></button>
          </div>
        )}
        {overlay?.kind === "palette" && <Palette onClose={() => setOverlay(null)} onShortcuts={() => setOverlay({ kind: "shortcuts" })} onNewGoal={() => setOverlay({ kind: "goal", goalId: null })} />}
        {overlay?.kind === "shortcuts" && <Shortcuts onClose={() => setOverlay(null)} />}
        {overlay?.kind === "goal" && <GoalDialog goalId={overlay.goalId} preset={overlay.preset} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "addChecks" && <CheckPicker goalId={overlay.goalId} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "require" && <RequirePicker goalId={overlay.goalId} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "addToGoal" && <GoalPicker checkIds={overlay.checkIds} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "delete" && <DeleteDialog checkIds={overlay.checkIds} onDone={overlay.onDone} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "deleteGoal" && <GoalDeleteDialog goalId={overlay.goalId} onDone={overlay.onDone} onClose={() => setOverlay(null)} />}
        {overlay?.kind === "describe" &&<DescribeDialog onClose={() => setOverlay(null)} />}
        {leaving && (
          <LeaveDialog
            isNew={route.screen === "draft" && !route.checkId}
            onStay={() => setLeaving(null)}
            onDiscard={() => {
              const to = leaving;
              guard.current?.discard();
              guard.current = null;
              setLeaving(null);
              moveTo(to);
            }}
          />
        )}
      </div>
    </HubContext.Provider>
  );
}

type SectionId = "overview" | "milestones" | "goals" | "library" | "queue";
const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; icon: HubIconName; keys?: string }> = [
  { id: "overview", label: HUB_COPY.overview, icon: "overview", keys: "g o" },
  { id: "milestones", label: HUB_COPY.milestones, icon: "milestone", keys: "g m" },
  { id: "goals", label: HUB_COPY.goals, icon: "goal" },
  { id: "library", label: HUB_COPY.library, icon: "library", keys: "g l" },
  { id: "queue", label: HUB_COPY.queue, icon: "queue", keys: "g q" },
];

/** A button on the hub's toast. */
interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

/** The last five goals and playtests opened, newest first, kept in this browser. */
function useRecent(route: HubRoute): HubRecent[] {
  const [list, setList] = useState<HubRecent[]>(() => {
    try {
      return parseRecent(window.localStorage.getItem(HUB_RECENT_KEY));
    } catch {
      return [];
    }
  });
  const id = route.screen === "goal" ? route.goalId : route.screen === "check" ? route.checkId : null;
  const kind = route.screen === "goal" ? "goal" : "check";
  useEffect(() => {
    if (!id) return;
    setList((l) => {
      const next = rememberRecent(l, { kind, id });
      try {
        window.localStorage.setItem(HUB_RECENT_KEY, JSON.stringify(next));
      } catch { /* storage is a convenience */ }
      return next;
    });
  }, [kind, id]);
  return list;
}

function sectionCount(id: string, ctx: Pick<HubContextValue, "o">): ReactNode {
  const { o } = ctx;
  if (id === "overview" && o.attention.length) return <span className="tab-count warn" aria-label={`${o.attention.length} need attention`}>{o.attention.length}</span>;
  if (id === "overview" && o.queue.current) return <span className="hub-live-dot" aria-label={HUB_COPY.nowRunning} title={HUB_COPY.nowRunning} />;
  if (id === "milestones") return <span className="hub-rail-count">{o.goals.filter((g) => !g.goal.archived && g.goal.kind === "milestone").length}</span>;
  if (id === "goals") return <span className="hub-rail-count">{o.goals.filter((g) => !g.goal.archived && g.goal.kind !== "milestone").length}</span>;
  if (id === "library") return <span className="hub-rail-count">{o.checks.length}</span>;
  if (id === "queue" && o.queue.current) return <span className="hub-live-dot" aria-label={HUB_COPY.nowRunning} title={HUB_COPY.nowRunning} />;
  if (id === "queue" && o.queue.queued.length) return <span className="hub-rail-count">{o.queue.queued.length}</span>;
  return null;
}

const sectionRoute = (id: SectionId): HubRoute => ({ screen: id });
const SET_ROUTE: HubRoute = { screen: "arrangement" };

/** The wide hub's rail: the four screens, then the goals and playtests opened last. */
function HubRail({ onPalette, onShortcuts }: { onPalette: () => void; onShortcuts: () => void }) {
  const ctx = useHub();
  const { o, route, go } = ctx;
  const at = hubSection(route);
  const recent = useRecent(route).flatMap((r) => {
    if (r.kind === "goal") {
      const g = o.goals.find((x) => x.goal.id === r.id && !x.goal.archived);
      return g ? [{ key: `goal:${r.id}`, title: g.goal.title, look: GOAL_STATUS_LOOK[g.status], to: { screen: "goal", goalId: r.id } as HubRoute }] : [];
    }
    const c = o.checks.find((x) => x.id === r.id);
    return c ? [{ key: `check:${r.id}`, title: c.name, look: CHECK_HEALTH_LOOK[c.health], to: { screen: "check", checkId: r.id } as HubRoute }] : [];
  });
  return (
    <nav className="hub-rail" aria-label={HUB_COPY.title}>
      <button className="hub-find" onClick={onPalette} title="Find a track, clip or run (Ctrl+K)">
        <HubIcon name="search" />
        <span>Find or run</span>
        <span className="spacer" />
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="hub-rail-group">
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash(sectionRoute(s.id))} onGo={() => go(sectionRoute(s.id))} className={`hub-rail-item ${at === s.id && route.screen !== "goal" && route.screen !== "arrangement" ? "active" : ""}`} title={s.keys ? `${s.label} (${s.keys})` : s.label}>
            <HubIcon name={s.icon} />
            <span className="hub-rail-label">{s.label}</span>
            {sectionCount(s.id, ctx)}
          </HubLink>
        ))}
        {arrangementOn(ctx.health) && (
          <HubLink href={hubHash(SET_ROUTE)} onGo={() => go(SET_ROUTE)} className={`hub-rail-item ${route.screen === "arrangement" ? "active" : ""}`}>
            <HubIcon name="arrange" />
            <span className="hub-rail-label">{SET_COPY.arrangement}</span>
          </HubLink>
        )}
      </div>
      {recent.length > 0 &&<div className="hub-rail-head"><span>{HUB_COPY.recent}</span></div>}
      <div className="hub-rail-goals">
        {recent.map((r) => (
          <HubLink key={r.key} href={hubHash(r.to)} onGo={() => go(r.to)}
            className={`hub-rail-item goal ${hubPath(route) === hubPath(r.to) ? "active" : ""}`} title={`${r.title}: ${r.look.label}`}>
            <StatusMark look={r.look} />
            <span className="hub-rail-label">{r.title}</span>
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
      <nav className="hub-seg" aria-label={HUB_COPY.title}>
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash(sectionRoute(s.id))} onGo={() => ctx.go(sectionRoute(s.id))} className={`hub-seg-item ${at === s.id && ctx.route.screen !== "arrangement" ? "active" : ""}`}>
            <span>{s.label}</span>
            {s.id === "overview" && sectionCount(s.id, ctx)}
          </HubLink>
        ))}
        {arrangementOn(ctx.health) && (
          <HubLink href={hubHash(SET_ROUTE)} onGo={() => ctx.go(SET_ROUTE)} className={`hub-seg-item ${ctx.route.screen === "arrangement" ? "active" : ""}`}>
            <span>{SET_COPY.arrangement}</span>
          </HubLink>
        )}
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
    else if (c === "runFailing") void ctx.runPlan({ scope: { kind: "failing" } }, "every failing clip");
    else if (c === "runAll") void ctx.runPlan({ scope: { kind: "all" } }, "every clip");
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
  const shortcuts = hubShortcuts(useAgentFixes());
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
                {shortcuts.filter((s) => s.group === g).map((s) => (
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

