import { useEffect, useMemo, useState } from "react";
import type { CacheExplainer, PlanMeter, PriceTable, TokenKinds, UsageGroup, UsageSummary, UsageWarning } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Card, Seg, tokens, useMessage } from "./controls";

type Period = "today" | "7d" | "30d" | "month";
const PERIODS: ReadonlyArray<{ id: Period; name: string }> = [
  { id: "today", name: "Today" },
  { id: "7d", name: "7 days" },
  { id: "30d", name: "30 days" },
  { id: "month", name: "This month" },
];
const GROUPS: ReadonlyArray<{ id: UsageGroup; name: string }> = [
  { id: "agent", name: "Agent" },
  { id: "model", name: "Model" },
  { id: "vendor", name: "Vendor" },
  { id: "route", name: "Route" },
  { id: "source", name: "Source" },
];
/** A round top for the scale: 1, 2 or 5 times a power of ten, at or above n. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= n) ?? 10 * p);
}

/** Series past this many fold into Other, so every colour stays tellable apart. */
const MAX_SERIES = 7;

/** A period as local midnights: from inclusive, to exclusive. */
export function periodRange(p: Period, now = new Date()): { from: Date; to: Date } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(day.getTime() + 86_400_000);
  if (p === "today") return { from: day, to };
  if (p === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
  return { from: new Date(day.getTime() - (p === "7d" ? 6 : 29) * 86_400_000), to };
}

const kind = (n: number | null): string => (n === null ? "not reported" : tokens(n));
const usd = (n: number): string => (n < 0.01 && n > 0 ? "< $0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n: number | null): string => (n === null ? "not reported" : `${Math.round(n * 100)}%`);
const dayLabel = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const since = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** The change against the period before, or why there is none. */
function Change({ now, before }: { now: number; before: number | null | undefined }) {
  if (before === null || before === undefined) return <span className="dim small">no comparison: the period before is not fully recorded</span>;
  if (before === 0) return <span className="dim small">none the period before</span>;
  const d = Math.round(((now - before) / before) * 100);
  return <span className="dim small">{d === 0 ? "same as" : `${d > 0 ? "+" : ""}${d}% against`} the period before</span>;
}

/** The cost against the period before; a period billed only by plan has no cost to compare with. */
function CostChange({ now, previous }: { now: number; previous: UsageSummary["previous"] }) {
  if (previous && previous.cost === null) return <span className="dim small">no cost the period before: every call ran on a plan</span>;
  return <Change now={now} before={previous ? previous.cost : null} />;
}

/**
 * Usage's dashboard: what the ledger recorded for a period, by agent, model,
 * vendor, route or source, with each sign-in's plan meter beside it. Every
 * number comes from the ledger's own records.
 */
export function UsageDashboard({ teamPerDay }: { teamPerDay: number | null }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [group, setGroup] = useState<UsageGroup>("agent");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [plans, setPlans] = useState<PlanMeter[] | null>(null);
  const [warnings, setWarnings] = useState<UsageWarning[]>([]);
  const [cache, setCache] = useState<CacheExplainer[]>([]);
  const [prices, setPrices] = useState<PriceTable | null>(null);
  const msg = useMessage();

  useEffect(() => {
    const r = periodRange(period);
    const q = { from: r.from.toISOString(), to: r.to.toISOString() };
    api.usageSummary({ ...q, groupBy: group }).then(setSummary, msg.fail);
    api.usagePlans(q).then((x) => setPlans(x.plans), () => setPlans([]));
  }, [period, group]);
  useEffect(() => {
    api.usageWarnings().then((x) => setWarnings(x.warnings), () => undefined);
    api.usageCache().then((x) => setCache(x.explainers), () => undefined);
    api.prices().then(setPrices, () => undefined);
  }, []);

  return (
    <>
      {msg.node}
      {warnings.length > 0 && (
        <div className="usage-warnings" role="list" aria-label="Warnings">
          {warnings.map((w) => (
            <div key={w.text} role="listitem" className={`banner small ${w.severity === "bad" ? "bad" : w.severity === "warn" ? "warn" : ""}`}>
              <strong>{w.text}</strong> <span>{w.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div className="usage-filters">
        <Seg label="Period" value={period} options={PERIODS} onChange={setPeriod} />
        <Seg label="Group by" value={group} options={GROUPS} onChange={setGroup} />
      </div>
      {summary && <Tiles s={summary} />}
      {summary?.ledgerStarts
        ? <p className="cfg-note">Studio has recorded usage since {since(summary.ledgerStarts)}{new Date(summary.ledgerStarts) > new Date(summary.from) ? ", so this period is shown from then on" : ""}.</p>
        : summary && <p className="cfg-note">Nothing recorded yet. Every model call from now on is counted here, on every route.</p>}
      {plans && <PlanMeters plans={plans} />}
      {summary && summary.rows.length > 0 && <DayChart s={summary} teamPerDay={period === "today" ? null : teamPerDay} />}
      {summary && summary.rows.length > 0 && <Breakdown s={summary} group={GROUPS.find((g) => g.id === group)!.name} />}
      {summary && summary.sessions.length > 0 && <Sessions s={summary} />}
      {cache.length > 0 && <CacheCard explainers={cache} />}
      {prices && <PricesCard table={prices} onSaved={setPrices} onError={msg.fail} />}
    </>
  );
}

function Tiles({ s }: { s: UsageSummary }) {
  const t = s.total;
  // No calls: nothing was reported or billed, so the tiles say so rather than describing calls that never ran.
  const none = t.calls === 0;
  return (
    <div className="usage-tiles">
      <div className="tile">
        <div className="tile-label">Tokens</div>
        <div className="tile-value num">{tokens(t.budgetTokens)}</div>
        <Change now={t.budgetTokens} before={s.previous?.budgetTokens ?? null} />
        <div className="dim small">Input, cache writes and output, as budgets count them</div>
      </div>
      <div className="tile">
        <div className="tile-label">Read from cache</div>
        <div className="tile-value num">{none ? "-" : pct(t.cachedShare)}</div>
        {none
          ? <span className="dim small">No calls yet</span>
          : s.previous?.cachedShare !== undefined && s.previous?.cachedShare !== null && t.cachedShare !== null
            ? <span className="dim small">{Math.round(s.previous.cachedShare * 100)}% the period before</span>
            : <span className="dim small">of all input the models read</span>}
        {!none && <div className="dim small">{t.tokens.cacheRead === null ? "No route in the period reports cache reads" : `${tokens(t.tokens.cacheRead)} tokens read from cache`}</div>}
      </div>
      <div className="tile">
        <div className="tile-label">Estimated cost</div>
        <div className="tile-value num">{none ? "-" : t.cost === null ? "None" : usd(t.cost)}</div>
        {!none && t.cost !== null && <CostChange now={t.cost} previous={s.previous} />}
        <span className="dim small">{none ? "No calls yet" : t.cost === null ? "Every call ran on a sign-in, billed by plan" : t.costPartial ? "Keys and endpoints only; some calls had no price or ran on a plan" : "On keys and endpoints, from the price table"}</span>
      </div>
      <div className="tile">
        <div className="tile-label">Runs</div>
        <div className="tile-value num">{t.runs.toLocaleString("en-US")}</div>
        <Change now={t.runs} before={s.previous ? s.previous.runs : null} />
        <span className="dim small">{t.calls.toLocaleString("en-US")} model calls</span>
      </div>
    </div>
  );
}

function PlanMeters({ plans }: { plans: PlanMeter[] }) {
  if (plans.length === 0) return null;
  return (
    <Card label="Plans">
      <p className="muted small">How much of each sign-in's plan is used, as the plan last reported it. Studio never estimates a plan's limit.</p>
      {plans.map((p) => (
        <div key={p.route} className="plan">
          <div className="plan-head"><strong>{p.name}</strong> <span className="dim small">{p.reportedAt ? `reported ${new Date(p.reportedAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "has not reported its limits yet"}</span></div>
          {p.windows.map((w) => (
            <div key={w.kind} className="meter-row">
              <span className="meter-label">{w.label}</span>
              <div className="meter" role="meter" aria-label={`${p.name}, ${w.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.used === null ? undefined : Math.round(w.used * 100)}>
                <div className={`meter-fill ${w.status === "rejected" ? "bad" : w.status === "warning" || (w.used ?? 0) >= 0.8 ? "warn" : ""}`} style={{ width: `${Math.round((w.used ?? 0) * 100)}%` }} />
              </div>
              <span className="meter-value num">{w.used === null ? "not reported" : `${Math.round(w.used * 100)}% used`}</span>
              <span className="dim small meter-reset">{w.status === "rejected" ? "limit reached" : w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}</span>
            </div>
          ))}
          <div className="dim small">{(p.tokens.input ?? 0) + (p.tokens.output ?? 0) === 0
            ? "No calls through it in this period."
            : `Studio sent ${tokens(p.tokens.input ?? 0)} input, ${kind(p.tokens.cacheRead)} cached-read, ${kind(p.tokens.cacheWrite)} cache-write and ${tokens(p.tokens.output ?? 0)} output tokens through it in this period.`}</div>
        </div>
      ))}
    </Card>
  );
}

/** Tokens per day, stacked by the grouping; the largest series keep their colour, the rest fold into Other. */
function DayChart({ s, teamPerDay }: { s: UsageSummary; teamPerDay: number | null }) {
  const { keys, labels } = useMemo(() => {
    const top = s.rows.slice(0, s.rows.length > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES);
    const k = top.map((r) => r.key);
    const l = new Map(top.map((r) => [r.key, r.label]));
    if (s.rows.length > top.length) {
      k.push("__other");
      l.set("__other", "Other");
    }
    return { keys: k, labels: l };
  }, [s]);
  const days = s.days.map((d) => {
    const v: Record<string, number> = {};
    for (const [k, n] of Object.entries(d.byKey)) {
      const key = keys.includes(k) ? k : "__other";
      v[key] = (v[key] ?? 0) + n;
    }
    return { day: d.day, v, total: Object.values(v).reduce((a, b) => a + b, 0) };
  });
  const peak = Math.max(1, ...days.map((d) => d.total));
  // A budget far above every day would flatten the bars: then it is named instead of drawn.
  const drawLine = teamPerDay !== null && teamPerDay <= peak * 2;
  const max = niceCeil(Math.max(peak, drawLine ? teamPerDay! : 0) * 1.08);
  return (
    <Card label="Tokens per day">
      <div className="legend" aria-hidden>
        {keys.map((k, i) => <span key={k} className="legend-item"><span className={`swatch s${k === "__other" ? "o" : i + 1}`} />{labels.get(k)}</span>)}
        {drawLine && <span className="legend-item"><span className="swatch line" />Daily budget for all agents</span>}
      </div>
      <div className="daychart-wrap">
      <div className="dayticks" aria-hidden>
        <span>{tokens(max)}</span>
        <span>{tokens(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="daychart" role="img" aria-label={`Tokens per day: ${days.map((d) => `${dayLabel(d.day)} ${tokens(d.total)}`).join(", ")}`}>
        {drawLine && <div className="budget-line" style={{ bottom: `${(teamPerDay / max) * 100}%` }} title={`Daily budget for all agents: ${tokens(teamPerDay)} tokens`} />}
        {days.map((d) => (
          <div key={d.day} className="daycol" title={`${dayLabel(d.day)}: ${tokens(d.total)} tokens${keys.filter((k) => d.v[k]).map((k) => `\n${labels.get(k)}: ${tokens(d.v[k])}`).join("")}`}>
            <div className="daystack" style={{ height: `${(d.total / max) * 100}%` }}>
              {keys.map((k, i) => (d.v[k] ? <div key={k} className={`seg s${k === "__other" ? "o" : i + 1}`} style={{ flexGrow: d.v[k] }} /> : null))}
            </div>
          </div>
        ))}
      </div>
      </div>
      <div className="dayaxis" aria-hidden>
        {/* Labelled from the newest day back, so today always has its label. */}
        {days.map((d, i) => <span key={d.day}>{days.length <= 7 || (days.length - 1 - i) % Math.ceil(days.length / 5) === 0 ? dayLabel(d.day) : ""}</span>)}
      </div>
      {teamPerDay !== null && !drawLine && <p className="cfg-note">The daily budget for all agents, {tokens(teamPerDay)} tokens, is more than twice the busiest day here.</p>}
    </Card>
  );
}

function Breakdown({ s, group }: { s: UsageSummary; group: string }) {
  return (
    <Card label={`By ${group.toLowerCase()}`}>
      <div className="scroll-x">
        <table className="cfg-table blocks usage-table">
          <thead>
            <tr><th>{group}</th><th className="r">Tokens</th><th className="r">Input</th><th className="r">Cached reads</th><th className="r">Cache writes</th><th className="r">Output</th><th className="r">From cache</th><th className="r">Cost</th></tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.key}>
                <td><strong>{r.label}</strong>{r.lastModel && <div className="dim small">{r.runs} run{r.runs === 1 ? "" : "s"}, last on {r.lastModel}</div>}</td>
                <td className="r num" data-label="Tokens">{tokens(r.budgetTokens)}</td>
                <td className="r num" data-label="Input">{kind(r.tokens.input)}</td>
                <td className="r num" data-label="Cached reads">{kind(r.tokens.cacheRead)}</td>
                <td className="r num" data-label="Cache writes">{kind(r.tokens.cacheWrite)}</td>
                <td className="r num" data-label="Output">{kind(r.tokens.output)}</td>
                <td className="r num" data-label="From cache">{pct(r.cachedShare)}</td>
                <td className="r num" data-label="Cost">{r.cost === null ? <span className="dim">plan</span> : <span className="cost">{usd(r.cost)}{r.costPartial && <span className="dim"> partial</span>}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cfg-note">"Not reported" means the vendor does not say; it is never counted as zero. "Partial" means some of the row's calls ran on a plan or had no price, so the cost covers the rest. "Plan" means every call ran on a sign-in.</p>
    </Card>
  );
}

function Sessions({ s }: { s: UsageSummary }) {
  return (
    <Card label="Sessions">
      <ul className="ifiles plain">
        {s.sessions.slice(0, 8).map((x) => (
          <li key={x.id}>
            <div className="ifile-main">
              <strong>{x.title}</strong>
              <div className="readers">{x.turns} turn{x.turns === 1 ? "" : "s"}, {x.agents.length} agent{x.agents.length === 1 ? "" : "s"}, last {new Date(x.last).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
            </div>
            <span className="num">{tokens(x.budgetTokens)}{x.cost !== null ? <span className="dim small"> {usd(x.cost)}</span> : null}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CacheCard({ explainers }: { explainers: CacheExplainer[] }) {
  return (
    <Card label="How each vendor caches">
      <p className="muted small">Cached reads cost far less than fresh input. A prompt that stays the same from the start keeps hitting the cache.</p>
      <div className="cache-grid">
        {explainers.map((c) => (
          <div key={c.vendor} className="cache-col">
            <strong>{c.name}</strong>
            <dl className="fields">
              <dt>What</dt><dd>{c.what}</dd>
              <dt>Who decides</dt><dd>{c.whoDecides}</dd>
              <dt>Cost</dt><dd>{c.cachedReadCost}</dd>
              <dt>How long</dt><dd>{c.howLong}</dd>
            </dl>
            <a className="small" href={c.source} target="_blank" rel="noreferrer">{c.name}'s documentation</a>
          </div>
        ))}
      </div>
    </Card>
  );
}

const RATE_KINDS: ReadonlyArray<{ id: keyof TokenKinds; name: string }> = [
  { id: "input", name: "Input" },
  { id: "cacheRead", name: "Cached read" },
  { id: "cacheWrite", name: "Cache write" },
  { id: "output", name: "Output" },
];

function PricesCard({ table, onSaved, onError }: { table: PriceTable; onSaved: (t: PriceTable) => void; onError: (e: Error) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({ vendor: "", model: "", input: "", cacheRead: "", cacheWrite: "", output: "" });
  const own = table.prices.filter((p) => p.user);
  const save = (list: typeof own) => api.savePrices(list.map(({ vendor, model, perMTok }) => ({ vendor, model, perMTok }))).then(onSaved, onError);
  const rate = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  const add = () => {
    const perMTok = { input: rate(draft.input), cacheRead: rate(draft.cacheRead), cacheWrite: rate(draft.cacheWrite), output: rate(draft.output) };
    void save([...own.filter((p) => !(p.vendor === draft.vendor && p.model === draft.model)), { vendor: draft.vendor.trim(), model: draft.model.trim(), perMTok, asOf: "", source: "" }]).then(() => setDraft({ vendor: "", model: "", input: "", cacheRead: "", cacheWrite: "", output: "" }));
  };
  return (
    <details className="card advanced">
      <summary className="muted small">Prices used for estimated cost, each dated from its vendor's page</summary>
      <div className="scroll-x">
        <table className="cfg-table blocks usage-table">
          <thead><tr><th>Model</th>{RATE_KINDS.map((k) => <th key={k.id} className="r">{k.name}</th>)}<th>Source</th><th /></tr></thead>
          <tbody>
            {[...table.prices].sort((a, b) => Number(!!b.user) - Number(!!a.user) || a.vendor.localeCompare(b.vendor)).map((p) => (
              <tr key={`${p.user ? "u" : "s"}:${p.vendor}:${p.model}`}>
                <td><strong>{p.model}</strong> <span className="dim small">{p.vendor}</span></td>
                {RATE_KINDS.map((k) => <td key={k.id} className="r num" data-label={k.name}>{p.perMTok[k.id] === null ? <span className="dim">not priced</span> : p.perMTok[k.id] === 0 ? <span className="dim">no charge</span> : `$${p.perMTok[k.id]}`}</td>)}
                <td className="small" data-label="Source">{p.user ? "Yours" : <a href={p.source} target="_blank" rel="noreferrer">Vendor's page, {p.asOf}</a>}{p.note && <div className="dim">{p.note}</div>}</td>
                <td>{p.user && <button className="small-button" onClick={() => void save(own.filter((x) => x !== p))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cfg-note">Dollars per million tokens. A model with no price gets no cost, never a guess. Add your own for a custom endpoint or a negotiated rate; yours wins over the shipped one.</p>
      <div className="price-form">
        <input aria-label="Vendor" placeholder="vendor" value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} />
        <input aria-label="Model, or a prefix ending in *" placeholder="model or prefix*" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        {RATE_KINDS.map((k) => <input key={k.id} className="num" inputMode="decimal" aria-label={`${k.name} per million tokens`} placeholder={k.name.toLowerCase()} value={draft[k.id]} onChange={(e) => setDraft({ ...draft, [k.id]: e.target.value })} />)}
        <button disabled={!draft.vendor.trim() || !draft.model.trim()} onClick={add}>Add price</button>
      </div>
    </details>
  );
}
