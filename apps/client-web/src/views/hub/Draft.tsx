/**
 * The playtest editor: a new playtest, or a saved one, on a screen of its own.
 * Each step reads as one sentence and is built from parts picked from what
 * the open level has (pie(script_values), its Input Actions and levels):
 * what the engine does first, then what the observer checks or what a person
 * judges. ue-mcp checks the draft as it changes (pie(script_validate)), and
 * each finding sits on the step and field it is about, its candidates one
 * click away. Save creates the script asset (pie(script_create)) or updates
 * it, then opens the playtest. Unsaved changes are kept for this tab and
 * asked about before leaving.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DRAFT_CHECK_MS,
  DRAFT_COPY,
  EMPTY_CATALOG,
  HUB_COPY,
  SUBJECT_GROUPS,
  actSentence,
  anchorFindings,
  applyCandidate,
  assetNameOf,
  candidateLabel,
  choiceOf,
  draftAct,
  draftCatalogOf,
  draftCheckId,
  draftFromScript,
  draftKey,
  draftOfStored,
  draftPayload,
  draftProblems,
  draftStatus,
  draftStep,
  duplicateDraftStep,
  emptyDraft,
  findSubject,
  hubPath,
  inPieHelps,
  levelName,
  moveDraftStep,
  opChoices,
  refusalProblems,
  removeDraftStep,
  scriptPathOf,
  searchSubjects,
  shownProblems,
  stepSentence,
  updateDraftStep,
  withChoice,
  withJudge,
  withAutoInstructions,
  withSubject,
  type ActVerb,
  type Draft,
  type DraftAct,
  type DraftCatalog,
  type DraftField,
  type DraftProblem,
  type DraftStep,
  type SentencePart,
  type Subject,
} from "@ue-mcp-studio/client-core";
import { parseCheckId } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { useHub } from "./state";
import { HubIcon, Placeholder, ScreenHead, StatusMark } from "./parts";

const STORE_PREFIX = "studio.hub.draft:";
const store = {
  get(key: string): unknown {
    try {
      const v = window.sessionStorage.getItem(STORE_PREFIX + key);
      return v ? (JSON.parse(v) as unknown) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      window.sessionStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage blocked or full: the draft lives until the screen closes.
    }
  },
  remove(key: string): void {
    try {
      window.sessionStorage.removeItem(STORE_PREFIX + key);
    } catch {
      // Nothing kept.
    }
  },
};

type Loaded = { draft: Draft; base: string };
type Saving = "save" | "run" | "wait" | null;

export function DraftScreen({ checkId, goalId }: { checkId?: string; goalId?: string }) {
  const hub = useHub();
  const { o, go } = hub;
  const routeKey = hubPath({ screen: "draft", checkId, goalId });
  const scriptPath = checkId ? parseCheckId(checkId)?.target ?? null : null;
  const goal = goalId ? o.goals.find((g) => g.goal.id === goalId) ?? null : null;

  const [catalog, setCatalog] = useState<DraftCatalog>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [restored, setRestored] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [found, setFound] = useState<DraftProblem[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkedLevel, setCheckedLevel] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusNext = useRef<string | null>(null);

  // The catalog: what steps can name in the open level.
  useEffect(() => {
    let live = true;
    api.drafting.catalog().then((raw) => {
      if (!live) return;
      setCatalog(draftCatalogOf(raw));
      setCatalogError(null);
      setCatalogLoaded(true);
    }, (e: Error) => {
      if (!live) return;
      setCatalogError(e.message);
      setCatalogLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // The draft: the saved script as written, or a new one in the open level, or what this tab kept of either.
  useEffect(() => {
    let live = true;
    const start = (d: Draft) => {
      if (!live) return;
      const base = draftKey(d);
      const kept = store.get(routeKey) as { draft?: unknown; base?: string } | null;
      const back = kept && (kept.base === base || !scriptPath) ? draftOfStored(kept.draft) : null;
      setLoaded({ draft: d, base });
      setDraft(back ?? d);
      setRestored(!!back && draftKey(back) !== base);
      setOpen((back ?? d).steps[0]?.id ?? null);
    };
    // Both wait for the catalog: a new draft starts in the open level, and a saved one's sentences need its names.
    if (!catalogLoaded) return;
    if (scriptPath) {
      api.drafting.script(scriptPath).then((r) => start(withAutoInstructions(draftFromScript(r.script, r.players), catalog)), (e: Error) => live && setLoadError(e.message));
    } else {
      start(emptyDraft(catalog.currentLevel));
    }
    return () => {
      live = false;
    };
  }, [scriptPath, catalogLoaded]);

  const dirty = !!draft && !!loaded && draftKey(draft) !== loaded.base;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && saving === null;

  // Kept for this tab while it differs from what was opened, so leaving the Playtests tab loses nothing.
  useEffect(() => {
    if (!draft || !loaded) return;
    if (dirty) store.set(routeKey, { draft, base: loaded.base });
    else store.remove(routeKey);
  }, [draft, loaded, dirty]);

  useEffect(() => {
    hub.guardLeave({ dirty: () => dirtyRef.current, discard: () => store.remove(routeKey) });
    const unload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      hub.guardLeave(null);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  const taken = useMemo(() => new Set(o.checks.map((c) => c.check.target)), [o.checks]);
  const local = useMemo(() => (draft ? draftProblems(draft, catalog, { taken }) : []), [draft, catalog, taken]);
  const payload = useMemo(() => (draft ? draftPayload(draft, catalog) : null), [draft, catalog]);
  const payloadKey = payload ? JSON.stringify(payload) : "";

  // ue-mcp checks the draft once it has stopped changing for a moment. A late answer to an older draft is dropped.
  const asked = useRef(0);
  useEffect(() => {
    if (!draft || !payload || draft.steps.length === 0 || catalogError) {
      setChecking(false);
      return;
    }
    const n = ++asked.current;
    setChecking(true);
    const sent = draft.steps;
    const level = draft.map || catalog.currentLevel;
    const t = setTimeout(() => {
      api.drafting.validate(payload).then((r) => {
        if (n !== asked.current) return;
        setFound(anchorFindings(r.errors ?? [], sent));
        setCheckError(null);
        setCheckedLevel(level);
        setChecking(false);
      }, (e: Error) => {
        if (n !== asked.current) return;
        setCheckError(e.message);
        setChecking(false);
      });
    }, DRAFT_CHECK_MS);
    return () => clearTimeout(t);
  }, [payloadKey, catalogError]);

  // Ctrl+S saves, wherever focus is on the screen.
  const saveKey = useRef<((run: boolean) => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveKey.current?.(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    document.getElementById(id)?.focus();
  });

  if (loadError) {
    return (
      <div className="hub-screen">
        <ScreenHead back={backOf(checkId, goal)} eyebrow={DRAFT_COPY.editPlaytest} title={scriptPath ? scriptPath.split("/").pop() ?? "" : DRAFT_COPY.newPlaytest} />
        <div className="banner bad">{loadError}</div>
      </div>
    );
  }
  if (!draft || !loaded) {
    return <div className="hub-screen"><Placeholder rows={6} /></div>;
  }

  const shown = shownProblems(local, found, tried);
  const at = (stepId: string | null, field?: DraftField) => shown.filter((p) => p.stepId === stepId && (field === undefined || p.field === field));
  const change = (f: (d: Draft) => Draft, stepId?: string | null, field?: DraftField) => {
    setDraft((d) => (d ? f(d) : d));
    setSaveError(null);
    // A finding on what just changed goes until ue-mcp says it again.
    if (stepId !== undefined) setFound((cur) => cur.filter((p) => !(p.stepId === stepId && (field === undefined || p.field === field || field === "step"))));
  };
  const changeStep = (id: string, f: (s: DraftStep) => DraftStep, field: DraftField = "step") => change((d) => updateDraftStep(d, id, f), id, field);

  const addStep = (judge: "auto" | "manual") => {
    const s = draftStep(judge);
    change((d) => ({ ...d, steps: [...d.steps, s] }));
    setOpen(s.id);
    focusNext.current = judge === "auto" ? `${s.id}-value` : `${s.id}-instruction`;
  };
  const move = (id: string, by: number) => {
    const i = draft.steps.findIndex((s) => s.id === id);
    const j = i + by;
    if (j < 0 || j >= draft.steps.length) return;
    change((d) => moveDraftStep(d, id, by));
    setAnnounce(DRAFT_COPY.moved(j + 1));
    focusNext.current = `${id}-toggle`;
  };
  const duplicate = (id: string) => {
    const r = duplicateDraftStep(draft, id);
    if (!r.id) return;
    change(() => r.draft);
    setOpen(r.id);
    focusNext.current = `${r.id}-toggle`;
  };
  const remove = (id: string) => {
    const i = draft.steps.findIndex((s) => s.id === id);
    const next = draft.steps[i + 1] ?? draft.steps[i - 1];
    change((d) => removeDraftStep(d, id), id);
    if (open === id) setOpen(next?.id ?? null);
    focusNext.current = next ? `${next.id}-toggle` : "draft-add-auto";
  };
  const fix = (p: DraftProblem, candidate: string) => change((d) => applyCandidate(d, p, candidate, catalog), p.stepId, p.field);
  const inPie = (stepId: string) => changeStep(stepId, (s) => ({ ...s, resolveInPie: true }), "value");

  const firstProblem = () => {
    const p = shownProblems(local, found, true)[0];
    if (!p) return;
    if (p.stepId) {
      setOpen(p.stepId);
      focusNext.current = fieldId(p.stepId, p.field);
    } else focusNext.current = p.field === "name" ? "draft-name" : p.field === "map" ? "draft-map" : "draft-add-auto";
  };

  const name = draft.path ? draft.name : assetNameOf(draft.name);
  const save = async (run: boolean) => {
    setTried(true);
    setSaveError(null);
    if (local.length) {
      firstProblem();
      return;
    }
    const p = draftPayload(draft, catalog);
    const sent = draft.steps;
    setSaving(run ? "run" : "save");
    try {
      let path = draft.path;
      if (path) await api.drafting.save(path, p);
      else path = (await api.drafting.create({ name, ...p })).path;
      if (!draft.path && goalId) await api.hub.addChecks(goalId, [{ kind: "script", target: path }]).catch((e: Error) => hub.notify(e.message, "bad"));
      store.remove(routeKey);
      const id = draftCheckId({ path, name });
      // A new script reaches the hub with the editor's next script list.
      if (!draft.path) {
        setSaving("wait");
        await listed(id);
      }
      hub.data.reload();
      if (run) await hub.runCheck(id, name);
      else hub.notify(DRAFT_COPY.savedTitle(name));
      dirtyRef.current = false;
      go({ screen: "check", checkId: id });
    } catch (e) {
      setSaving(null);
      setSaveError((e as Error).message);
      const back = refusalProblems(e, sent);
      if (back.length) setFound(back);
    }
  };

  saveKey.current = (run) => {
    if (saving === null) void save(run);
  };
  const status = draftStatus({ checking, checkError: catalogError ?? checkError, local, editor: shown.filter((p) => p.kind === "editor"), checkedLevel, saving, savedName: name });
  const levelMismatch = !!draft.map && !!catalog.currentLevel && draft.map !== catalog.currentLevel;
  const nameProblems = at(null, "name");
  const mapProblems = at(null, "map");
  const wholeProblems = at(null, "steps");

  return (
    <div className="hub-screen hub-draft">
      <ScreenHead
        back={backOf(checkId, goal)}
        eyebrow={draft.path ? DRAFT_COPY.editPlaytest : DRAFT_COPY.newPlaytest}
        title={draft.path ? draft.name : (
          <input
            id="draft-name"
            className="hub-draft-name"
            value={draft.name}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={DRAFT_COPY.namePlaceholder}
            aria-label={DRAFT_COPY.nameLabel}
            aria-invalid={nameProblems.length > 0}
            aria-describedby={nameProblems.length ? "draft-name-problem" : undefined}
            onChange={(e) => change((d) => ({ ...d, name: e.target.value }), null, "name")}
            onBlur={() => assetNameOf(draft.name) !== draft.name && change((d) => ({ ...d, name: assetNameOf(d.name) }), null, "name")}
          />
        )}
        sub={<>
          <span className="mono small dim hub-path">{draft.path ?? (name ? scriptPathOf(name) : `${scriptPathOf("")}...`)}</span>
          {goal && !draft.path && <span className="hub-goal-chip"><HubIcon name="goal" size={11} />{DRAFT_COPY.addsToGoal(goal.goal.title)}</span>}
        </>}
      />
      {nameProblems.map((p, i) => <ProblemLine key={i} id={i === 0 ? "draft-name-problem" : undefined} problem={p} step={undefined} onFix={(c) => fix(p, c)} />)}
      {restored && (
        <div className="banner small hub-draft-restored">
          <span>{DRAFT_COPY.restored}</span>
          <button className="ghost small-button" onClick={() => {
            setDraft(loaded.draft);
            setRestored(false);
            store.remove(routeKey);
          }}>{DRAFT_COPY.discard}</button>
        </div>
      )}
      {catalogError && <div className="banner warn small">{DRAFT_COPY.noEditor}</div>}

      <div className="hub-draft-level">
        <label htmlFor="draft-map" className="hub-draft-label">{DRAFT_COPY.levelLabel}</label>
        <select id="draft-map" value={draft.map} aria-invalid={mapProblems.length > 0} onChange={(e) => change((d) => ({ ...d, map: e.target.value }), null, "map")}>
          <option value="">{DRAFT_COPY.anyLevel}{catalog.currentLevel ? ` (${levelName(catalog.currentLevel)})` : ""}</option>
          {catalog.levels.map((l) => <option key={l.path} value={l.path}>{l.name}</option>)}
          {draft.map && !catalog.levels.some((l) => l.path === draft.map) && <option value={draft.map}>{levelName(draft.map)}</option>}
        </select>
        {levelMismatch && <span className="small dim">{DRAFT_COPY.valuesFrom(levelName(catalog.currentLevel!))}</span>}
      </div>
      {mapProblems.map((p, i) => <ProblemLine key={i} problem={p} step={undefined} onFix={(c) => fix(p, c)} />)}

      <section className="hub-section" aria-labelledby="draft-steps-head">
        <div className="hub-section-head"><h2 id="draft-steps-head">{DRAFT_COPY.steps} <span className="dim">{draft.steps.length}</span></h2></div>
        {draft.steps.length === 0 && <p className="dim small">{DRAFT_COPY.emptyHint}</p>}
        <ol className="hub-draft-steps">
          {draft.steps.map((s, i) => (
            <StepCard
              key={s.id}
              step={s}
              index={i}
              count={draft.steps.length}
              open={open === s.id}
              catalog={catalog}
              defaultWithinMs={draft.defaultWithinMs}
              problems={at(s.id)}
              onToggle={() => setOpen(open === s.id ? null : s.id)}
              onChange={(f, field) => changeStep(s.id, f, field)}
              onMove={(by) => move(s.id, by)}
              onDuplicate={() => duplicate(s.id)}
              onRemove={() => remove(s.id)}
              onFix={fix}
              onInPie={() => inPie(s.id)}
            />
          ))}
        </ol>
        {wholeProblems.map((p, i) => <ProblemLine key={i} problem={p} step={undefined} onFix={(c) => fix(p, c)} />)}
        <div className="hub-draft-add">
          <button id="draft-add-auto" onClick={() => addStep("auto")}><HubIcon name="plus" size={12} /> {DRAFT_COPY.addCheck}</button>
          <button onClick={() => addStep("manual")}><HubIcon name="plus" size={12} /> {DRAFT_COPY.addAsk}</button>
        </div>
      </section>

      <div className="hub-draft-foot" role="group" aria-label="Save">
        <div className={`hub-draft-status tone-${status.tone}`} aria-live="polite">
          <StatusDot tone={status.tone} />
          {(status.tone === "bad" || status.tone === "idle") && shownProblems(local, found, true).length
            ? <button className="ghost hub-draft-status-text" onClick={firstProblem}>{status.text}</button>
            : <span className="hub-draft-status-text">{status.text}</span>}
        </div>
        {saveError && <span className="hub-error hub-draft-save-error" role="alert">{DRAFT_COPY.saveFailed} {saveError}</span>}
        <span className="spacer" />
        <button className="ghost" onClick={() => go(backOf(checkId, goal).route)} disabled={saving !== null}>{DRAFT_COPY.cancel}</button>
        <button onClick={() => void save(true)} disabled={saving !== null}><HubIcon name="play" size={11} /> {DRAFT_COPY.saveRun}</button>
        <button className="primary" onClick={() => void save(false)} disabled={saving !== null} title="Save (Ctrl+S)">{DRAFT_COPY.save}</button>
      </div>
      <span className="sr-only" aria-live="polite">{announce}</span>
    </div>
  );
}

/** Where Cancel and the back link go: the playtest being edited, the goal a new one joins, or the Library. */
function backOf(checkId: string | undefined, goal: { goal: { id: string; title: string } } | null) {
  if (checkId) return { label: parseCheckId(checkId)?.target.split("/").pop() || HUB_COPY.playtest, route: { screen: "check" as const, checkId } };
  if (goal) return { label: goal.goal.title, route: { screen: "goal" as const, goalId: goal.goal.id } };
  return { label: HUB_COPY.library, route: { screen: "library" as const } };
}

/** Wait until the hub lists a new playtest (the editor's script list is read again within 15 seconds), then go on. */
async function listed(checkId: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    try {
      const d = await api.hub.check(checkId, { limit: 1 });
      if (!d.state.missing) return;
    } catch {
      // Not listed yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The element a problem's field is, to focus it. */
function fieldId(stepId: string, field: DraftField): string {
  if (field.startsWith("act:")) return `${stepId}-${field.replace(":", "-")}`;
  if (field === "value" || field === "op" || field === "target" || field === "within" || field === "instruction") return `${stepId}-${field}`;
  return `${stepId}-toggle`;
}

function StatusDot({ tone }: { tone: string }) {
  if (tone === "busy") return <span className="spinner hub-draft-spinner" aria-hidden="true" />;
  const look = tone === "ok" ? { glyph: "check" as const, tone: "ok" as const, label: "" } : tone === "bad" ? { glyph: "fail" as const, tone: "bad" as const, label: "" } : tone === "warn" ? { glyph: "risk" as const, tone: "warn" as const, label: "" } : { glyph: "queued" as const, tone: "idle" as const, label: "" };
  return <StatusMark look={look} />;
}

// ---------- A step ----------

function Sentence({ parts }: { parts: SentencePart[] }) {
  return (
    <span className="hub-draft-sentence">
      {parts.map((p, i) => ("text" in p ? <span key={i}>{p.text}</span> : <span key={i} className={`hub-draft-tok role-${p.role}${p.missing ? " missing" : ""}`} title={p.title}>{p.token}</span>))}
    </span>
  );
}

function StepCard({ step, index, count, open, catalog, defaultWithinMs, problems, onToggle, onChange, onMove, onDuplicate, onRemove, onFix, onInPie }: {
  step: DraftStep;
  index: number;
  count: number;
  open: boolean;
  catalog: DraftCatalog;
  defaultWithinMs: number;
  problems: DraftProblem[];
  onToggle: () => void;
  onChange: (f: (s: DraftStep) => DraftStep, field?: DraftField) => void;
  onMove: (by: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onFix: (p: DraftProblem, candidate: string) => void;
  onInPie: () => void;
}) {
  const parts = stepSentence(step, catalog, defaultWithinMs);
  const bodyId = `${step.id}-body`;
  const editorProblems = problems.filter((p) => p.kind !== "incomplete");
  const at = (field: DraftField) => problems.filter((p) => p.field === field);
  const lines = (field: DraftField) => at(field).map((p, i) => <ProblemLine key={i} id={i === 0 ? `${step.id}-${field.replace(":", "-")}-problem` : undefined} problem={p} step={step} onFix={(c) => onFix(p, c)} onInPie={onInPie} />);
  const described = (field: DraftField) => (at(field).length ? { "aria-invalid": true, "aria-describedby": `${step.id}-${field.replace(":", "-")}-problem` } : {});
  const arrange = Array.isArray(step.keep.arrange) ? step.keep.arrange.length : step.keep.arrange ? 1 : 0;
  const { narrow } = useHub();
  // Beside the sentence on a wide screen; at the foot of the open step on a narrow one, with their names.
  const tools = (
    <span className="hub-draft-step-actions">
      <button className="ghost icon-button" aria-label={`${DRAFT_COPY.moveUp}, step ${index + 1}`} title={`${DRAFT_COPY.moveUp} (Alt+Up)`} disabled={index === 0} onClick={() => onMove(-1)}><HubIcon name="up" size={12} />{narrow && DRAFT_COPY.moveUp}</button>
      <button className="ghost icon-button" aria-label={`${DRAFT_COPY.moveDown}, step ${index + 1}`} title={`${DRAFT_COPY.moveDown} (Alt+Down)`} disabled={index === count - 1} onClick={() => onMove(1)}><HubIcon name="down" size={12} />{narrow && DRAFT_COPY.moveDown}</button>
      <button className="ghost icon-button" aria-label={`${DRAFT_COPY.duplicate}, step ${index + 1}`} title={DRAFT_COPY.duplicate} onClick={onDuplicate}><HubIcon name="copy" size={12} />{narrow && DRAFT_COPY.duplicate}</button>
      <button className="ghost icon-button" aria-label={`${DRAFT_COPY.remove} ${index + 1}`} title={DRAFT_COPY.remove} onClick={onRemove}><HubIcon name="trash" size={12} />{narrow && DRAFT_COPY.removeShort}</button>
    </span>
  );

  return (
    <li className={`hub-draft-step judge-${step.judge}${open ? " open" : ""}${problems.length ? " has-problem" : ""}`}>
      <div className="hub-draft-step-head">
        <button
          id={`${step.id}-toggle`}
          className="hub-draft-step-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); onMove(-1); }
            else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); onMove(1); }
          }}
          title="Alt+Up and Alt+Down move the step"
        >
          <span className="hub-draft-num mono">{index + 1}</span>
          <JudgeIcon judge={step.judge} />
          <Sentence parts={parts} />
          {editorProblems.length > 0 && <StatusMark look={{ glyph: "fail", tone: "bad", label: "" }} label={`${editorProblems.length} ${editorProblems.length === 1 ? "problem" : "problems"}`} size={13} />}
        </button>
        {!narrow && tools}
      </div>
      {!open && editorProblems.length > 0 && (
        <div className="hub-draft-step-peek">
          {editorProblems.slice(0, 1).map((p, i) => <ProblemLine key={i} problem={p} step={step} onFix={(c) => onFix(p, c)} onInPie={onInPie} />)}
        </div>
      )}
      {open && (
        <div className="hub-draft-step-body" id={bodyId}>
          <div className="hub-draft-row">
            <span className="hub-draft-label" id={`${step.id}-judge-label`}>{DRAFT_COPY.judgedBy}</span>
            <div className="seg" role="radiogroup" aria-labelledby={`${step.id}-judge-label`}>
              {(["auto", "manual"] as const).map((j) => (
                <button key={j} role="radio" aria-checked={step.judge === j} className={step.judge === j ? "on" : ""} onClick={() => onChange((s) => withJudge(s, j))}>
                  <JudgeIcon judge={j} /> {j === "auto" ? DRAFT_COPY.observer : DRAFT_COPY.person}
                </button>
              ))}
            </div>
            {step.player && <span className="pill" title="The player this step is for in a multiplayer playtest">{step.player}</span>}
          </div>

          <div className="hub-draft-block">
            <span className="hub-draft-label">{DRAFT_COPY.doLabel}</span>
            <div className="hub-draft-acts">
              {step.acts.map((a, ai) => (
                <div key={a.id}>
                  <ActRow
                    stepId={step.id}
                    act={a}
                    index={ai}
                    catalog={catalog}
                    invalid={described(`act:${a.id}`)}
                    onChange={(next) => onChange((s) => ({ ...s, acts: s.acts.map((x) => (x.id === a.id ? next : x)) }), `act:${a.id}`)}
                    onRemove={() => onChange((s) => ({ ...s, acts: s.acts.filter((x) => x.id !== a.id) }), `act:${a.id}`)}
                  />
                  {lines(`act:${a.id}`)}
                </div>
              ))}
              <button className="ghost hub-draft-add-act" onClick={() => onChange((s) => ({ ...s, acts: [...s.acts, draftAct("press")] }))}><HubIcon name="plus" size={11} /> {DRAFT_COPY.addAction}</button>
            </div>
          </div>
          {arrange > 0 && <p className="small dim hub-draft-kept">{DRAFT_COPY.setupKept(arrange)}</p>}
          {lines("setup")}

          {step.judge === "auto" ? (
            <div className="hub-draft-block">
              <span className="hub-draft-label">{DRAFT_COPY.checkLabel}</span>
              <CheckRow step={step} catalog={catalog} defaultWithinMs={defaultWithinMs} described={described} onChange={onChange} />
              {lines("value")}
              {lines("op")}
              {lines("target")}
              {lines("within")}
              {step.resolveInPie && <p className="small dim">{DRAFT_COPY.inPieOn} <button className="ghost small-button" onClick={() => onChange((s) => ({ ...s, resolveInPie: false }), "value")}>Undo</button></p>}
              <label className="hub-draft-note">
                <span className="hub-draft-label">{DRAFT_COPY.playerNote}</span>
                <input id={`${step.id}-instruction`} value={step.instruction} placeholder={DRAFT_COPY.playerNotePlaceholder} onChange={(e) => onChange((s) => ({ ...s, instruction: e.target.value }), "instruction")} />
              </label>
            </div>
          ) : (
            <div className="hub-draft-block">
              <label className="hub-draft-label" htmlFor={`${step.id}-instruction`}>{DRAFT_COPY.askLabel}</label>
              <div className="hub-draft-ask">
                <textarea
                  id={`${step.id}-instruction`}
                  rows={2}
                  value={step.instruction}
                  placeholder={DRAFT_COPY.askPlaceholder}
                  {...described("instruction")}
                  onChange={(e) => onChange((s) => ({ ...s, instruction: e.target.value.replace(/\r?\n/g, " ") }), "instruction")}
                />
                {lines("instruction")}
                <label className="hub-check-label hub-draft-agent">
                  <input type="checkbox" checked={step.agentJudgeable} onChange={(e) => onChange((s) => ({ ...s, agentJudgeable: e.target.checked }))} />
                  <span>{DRAFT_COPY.agentMay}</span>
                </label>
              </div>
            </div>
          )}
          {lines("step")}
          {narrow && <div className="hub-draft-step-tools">{tools}</div>}
        </div>
      )}
    </li>
  );
}

function JudgeIcon({ judge }: { judge: "auto" | "manual" }) {
  return (
    <svg className={`hub-draft-judge ${judge}`} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label={judge === "auto" ? DRAFT_COPY.observer : DRAFT_COPY.person} role="img">
      {judge === "auto"
        ? <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
        : <path d="M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.8-2.2 2.7-3.5 5-3.5s4.2 1.3 5 3.5" />}
    </svg>
  );
}

// ---------- What is checked ----------

function CheckRow({ step, catalog, defaultWithinMs, described, onChange }: {
  step: DraftStep;
  catalog: DraftCatalog;
  defaultWithinMs: number;
  described: (f: DraftField) => Record<string, unknown>;
  onChange: (f: (s: DraftStep) => DraftStep, field?: DraftField) => void;
}) {
  const subject = findSubject(catalog, step.value, step.op);
  const kind = subject?.kind ?? null;
  const choices = opChoices(step.value ? kind : null);
  const choice = step.value ? choiceOf(step, kind) : null;
  const subjects = catalog.subjects;
  return (
    <div className="hub-draft-check">
      <Picker
        id={`${step.id}-value`}
        label="Value"
        value={step.value}
        shown={subject ? <SubjectLabel s={subject} /> : step.value ? <span className="mono">{step.value}</span> : null}
        placeholder={DRAFT_COPY.valuePlaceholder}
        searchLabel={DRAFT_COPY.searchValues}
        subjects={subjects}
        allowTyped
        invalid={described("value")}
        onPick={(path, s) => onChange((x) => withSubject(x, path, s), "value")}
      />
      <select
        id={`${step.id}-op`}
        aria-label="How it is checked"
        value={choice?.id ?? ""}
        disabled={!step.value}
        {...described("op")}
        onChange={(e) => {
          const c = choices.find((x) => x.id === e.target.value);
          if (c) onChange((x) => withChoice(x, c, subject), "op");
        }}
      >
        {!choice && <option value="">{step.value ? DRAFT_COPY.needsOp : "is"}</option>}
        {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      {choice?.needs === "enum" && subject?.enumValues && (
        <select id={`${step.id}-target`} aria-label="Value it is" value={step.target} {...described("target")} onChange={(e) => onChange((x) => ({ ...x, target: e.target.value }), "target")}>
          {subject.enumValues.map((v) => <option key={v.value} value={String(v.value)}>{v.name}</option>)}
        </select>
      )}
      {(choice?.needs === "number" || choice?.needs === "least" || (choice?.needs === "enum" && !subject?.enumValues)) && (
        <span className="hub-draft-inline">
          {choice.needs === "least" && <span className="dim small">by at least</span>}
          <input
            id={`${step.id}-target`}
            className="mono hub-draft-num-input"
            inputMode="decimal"
            aria-label={choice.needs === "least" ? "Least change" : "Target"}
            placeholder={choice.needs === "least" ? DRAFT_COPY.leastPlaceholder : "0"}
            value={step.target}
            {...described("target")}
            onChange={(e) => onChange((x) => ({ ...x, target: e.target.value }), "target")}
          />
        </span>
      )}
      <span className="hub-draft-inline">
        <span className="dim small">{DRAFT_COPY.within}</span>
        <input
          id={`${step.id}-within`}
          className="mono hub-draft-num-input"
          inputMode="decimal"
          aria-label="Time limit in seconds"
          placeholder={step.op === "triggered" ? DRAFT_COPY.noLimit : String(defaultWithinMs / 1000)}
          value={step.within}
          {...described("within")}
          onChange={(e) => onChange((x) => ({ ...x, within: e.target.value }), "within")}
        />
        <span className="dim small">{DRAFT_COPY.seconds}</span>
      </span>
    </div>
  );
}

function SubjectLabel({ s }: { s: Subject }) {
  return (
    <>
      <span className="mono hub-draft-subject">{s.label}</span>
      <span className="hub-draft-type">{s.type}</span>
    </>
  );
}

// ---------- What the engine does first ----------

const VERBS: ActVerb[] = ["press", "hold", "wait", "place", "console"];

function ActRow({ stepId, act, index, catalog, invalid, onChange, onRemove }: {
  stepId: string;
  act: DraftAct;
  index: number;
  catalog: DraftCatalog;
  invalid: Record<string, unknown>;
  onChange: (a: DraftAct) => void;
  onRemove: () => void;
}) {
  const id = `${stepId}-act-${act.id}`;
  const actors = useMemo<Subject[]>(() => catalog.actors.map((a) => ({ path: a, label: a, kind: "actor", group: "actor", type: "actor" })), [catalog.actors]);
  const input = (path: string) => catalog.inputActions.find((s) => s.path === path);
  return (
    <div className="hub-draft-act">
      {act.verb === "other" ? (
        <span className="hub-draft-other"><Sentence parts={actSentence(act)} /> <span className="dim small">{DRAFT_COPY.otherKept}</span></span>
      ) : (
        <>
          <select aria-label={`Action ${index + 1}`} value={act.verb} onChange={(e) => onChange({ ...act, verb: e.target.value as ActVerb })}>
            {VERBS.map((v) => <option key={v} value={v}>{DRAFT_COPY.verbs[v]}</option>)}
          </select>
          {(act.verb === "press" || act.verb === "hold") && (
            <Picker
              id={id}
              label="Input action"
              value={act.action}
              shown={act.action ? <span className="mono hub-draft-subject" title={act.action}>{input(act.action)?.label ?? act.action.split("/").pop()}</span> : null}
              placeholder={DRAFT_COPY.needsInput}
              searchLabel="Search input actions"
              subjects={catalog.inputActions}
              invalid={invalid}
              onPick={(path) => onChange({ ...act, action: path })}
            />
          )}
          {act.verb === "hold" && (
            <>
              <span className="hub-draft-inline">
                <span className="dim small">{DRAFT_COPY.holdValue}</span>
                <input className="mono hub-draft-num-input" aria-label="Value held" value={act.value} title="1 for a button; 0, 1 for a stick" onChange={(e) => onChange({ ...act, value: e.target.value })} />
              </span>
              <span className="hub-draft-inline">
                <span className="dim small">{DRAFT_COPY.holdFor}</span>
                <input className="mono hub-draft-num-input" inputMode="decimal" aria-label="Seconds held" value={act.seconds} {...invalid} onChange={(e) => onChange({ ...act, seconds: e.target.value })} />
                <span className="dim small">{DRAFT_COPY.seconds}</span>
              </span>
            </>
          )}
          {act.verb === "wait" && (
            <span className="hub-draft-inline">
              <input id={id} className="mono hub-draft-num-input" inputMode="decimal" aria-label="Seconds to wait" value={act.seconds} {...invalid} onChange={(e) => onChange({ ...act, seconds: e.target.value })} />
              <span className="dim small">{DRAFT_COPY.seconds}</span>
            </span>
          )}
          {act.verb === "place" && (
            <Picker id={id} label="Actor" value={act.at} shown={act.at ? <span className="mono hub-draft-subject">{act.at}</span> : null} placeholder={DRAFT_COPY.needsActor} searchLabel="Search actors in the level" subjects={actors} allowTyped invalid={invalid} onPick={(path) => onChange({ ...act, at: path })} />
          )}
          {act.verb === "console" && (
            <input id={id} className="mono hub-draft-command" aria-label="Console command" placeholder="stat fps" value={act.command} {...invalid} onChange={(e) => onChange({ ...act, command: e.target.value })} />
          )}
        </>
      )}
      <button className="ghost icon-button hub-draft-act-remove" aria-label={`Remove action ${index + 1}`} title="Remove action" onClick={onRemove}><HubIcon name="close" size={11} /></button>
    </div>
  );
}

// ---------- Problems ----------

function ProblemLine({ id, problem, step, onFix, onInPie }: { id?: string; problem: DraftProblem; step: DraftStep | undefined; onFix: (candidate: string) => void; onInPie?: () => void }) {
  const fixes = problem.candidates.slice(0, 4);
  return (
    <div className={`hub-draft-problem kind-${problem.kind}`} id={id}>
      <StatusMark look={problem.kind === "incomplete" ? { glyph: "queued", tone: "idle", label: "" } : { glyph: "fail", tone: "bad", label: "" }} size={12} />
      <span className="hub-draft-problem-text">{problem.message}</span>
      {(fixes.length > 0 || (onInPie && inPieHelps(problem, step))) && (
        <span className="hub-draft-fixes">
          {fixes.length > 0 && <span className="dim small">Use</span>}
          {fixes.map((c) => <button key={c} className="hub-draft-fix mono" onClick={() => onFix(c)} title={c}>{candidateLabel(problem, c)}</button>)}
          {onInPie && inPieHelps(problem, step) && <button className="ghost small-button hub-draft-inpie" onClick={onInPie}>{DRAFT_COPY.inPie}</button>}
        </span>
      )}
    </div>
  );
}

// ---------- The picker ----------

/**
 * A searchable list of what a step can name, grouped as SUBJECT_GROUPS says,
 * each row with its type. Arrows move, Enter picks, Escape closes. With
 * `allowTyped`, what is typed can be used as it is, for a value the open
 * level does not have yet.
 */
function Picker({ id, label, value, shown, placeholder, searchLabel, subjects, allowTyped, invalid, onPick }: {
  id: string;
  label: string;
  value: string;
  shown: ReactNode;
  placeholder: string;
  searchLabel: string;
  subjects: readonly Subject[];
  allowTyped?: boolean;
  invalid?: Record<string, unknown>;
  onPick: (path: string, subject: Subject | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (open ? searchSubjects(subjects, q) : []), [open, subjects, q]);
  const typed = allowTyped && q.trim() && !rows.some((r) => r.path === q.trim()) ? q.trim() : null;
  const total = rows.length + (typed ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => setAt(0), [q]);

  const close = () => {
    setOpen(false);
    setQ("");
    button.current?.focus();
  };
  const pick = (i: number) => {
    if (i < rows.length) onPick(rows[i].path, rows[i]);
    else if (typed) onPick(typed, null);
    close();
  };
  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    setAt(next);
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${next}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };

  let lastGroup = "";
  return (
    <div className="hub-draft-picker" ref={root}>
      <button
        id={id}
        ref={button}
        className="hub-draft-pick"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={value ? undefined : `${label}: ${placeholder}`}
        {...invalid}
        onClick={() => setOpen((x) => !x)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); }
        }}
      >
        {value && shown ? shown : <span className="dim">{placeholder}</span>}
        <svg className="hub-draft-caret" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
      </button>
      {open && (
        <div className="hub-draft-pop">
          <input
            autoFocus
            value={q}
            placeholder={searchLabel}
            aria-label={searchLabel}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={total ? `${listId}-${at}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); moveTo(at + 1); }
              else if (e.key === "ArrowUp") { e.preventDefault(); moveTo(at - 1); }
              else if (e.key === "Enter") { e.preventDefault(); if (total) pick(at); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
              else if (e.key === "Tab") setOpen(false);
            }}
          />
          <div className="hub-draft-pop-list" role="listbox" id={listId} ref={list} aria-label={label}>
            {rows.map((s, i) => {
              const head = s.group !== lastGroup ? SUBJECT_GROUPS.find((g) => g.id === s.group)?.label : null;
              lastGroup = s.group;
              return (
                <div key={`${s.group}:${s.path}`}>
                  {head && <div className="hub-draft-pop-group" role="presentation">{head}</div>}
                  <div
                    id={`${listId}-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={i === at}
                    className={`hub-draft-pop-row${i === at ? " on" : ""}${s.path === value ? " current" : ""}`}
                    onMouseMove={() => i !== at && setAt(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(i)}
                  >
                    <span className="mono hub-draft-pop-name">{s.label}</span>
                    {s.kind === "input" && <span className="hub-draft-pop-path mono">{s.path}</span>}
                    <span className="hub-draft-type">{s.enumValues ? `${s.type} (${s.enumValues.length})` : s.type}</span>
                  </div>
                </div>
              );
            })}
            {typed && (
              <div id={`${listId}-${rows.length}`} data-i={rows.length} role="option" aria-selected={at === rows.length} className={`hub-draft-pop-row typed${at === rows.length ? " on" : ""}`} onMouseMove={() => setAt(rows.length)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(rows.length)}>
                <span className="hub-draft-pop-name">{DRAFT_COPY.useTyped(typed)}</span>
                <span className="hub-draft-pop-path">{DRAFT_COPY.useTypedNote}</span>
              </div>
            )}
            {total === 0 && <p className="dim small hub-draft-pop-empty">{DRAFT_COPY.noValues}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
