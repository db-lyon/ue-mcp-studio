import { useMemo } from "react";

/** One step as ue-mcp.yml declares it (flow(plan)'s `definition.steps`). */
export interface DeclaredStep {
  task?: string;
  flow?: string;
  options?: Record<string, unknown>;
  when?: unknown;
  ignore_failure?: boolean;
  [key: string]: unknown;
}

/** One step of the ordered plan. */
export interface PlannedStep {
  stepNumber: number;
  type: string;
  name: string;
  skipped?: boolean;
}

export type StepState = "running" | "done" | "failed" | "skipped";

interface Node {
  id: string;
  number: number;
  title: string;
  detail: string;
  refs: string[];
  layer: number;
  row: number;
}

const W = 220;
const H = 54;
const GAP_X = 70;
const GAP_Y = 14;
const PAD = 16;
/** Steps per column when a flow is drawn as its run order. */
const CHAIN_ROWS = 8;

const REF = /\$\{steps\.([^.}]+)/g;

/** Step ids this step's options or condition read from, by ${steps.N...}. */
function refsOf(step: DeclaredStep, known: Set<string>): string[] {
  const text = JSON.stringify({ options: step.options ?? {}, when: step.when ?? null });
  const out = new Set<string>();
  for (const m of text.matchAll(REF)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

/** A short line naming what the step acts on: the first string option that looks like a name or path. */
function detailOf(step: DeclaredStep): string {
  const o = step.options ?? {};
  for (const key of ["name", "path", "systemPath", "assetPath", "functionPath", "materialPath", "label", "command"]) {
    if (typeof o[key] === "string") return `${key}: ${o[key] as string}`;
  }
  const first = Object.entries(o).find(([, v]) => typeof v === "string" || typeof v === "number");
  return first ? `${first[0]}: ${String(first[1])}` : "";
}

/**
 * Lay the steps out by data dependency: a step sits one column right of the
 * latest step it reads from, so a column holds steps that could run together.
 * A flow whose steps read nothing from each other is drawn as its run order,
 * wrapped into columns.
 */
function layout(definition: Record<string, DeclaredStep> | null, plan: PlannedStep[]): { nodes: Node[]; chain: boolean } {
  let nodes: Node[];
  if (definition) {
    const ids = Object.keys(definition).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const known = new Set(ids);
    nodes = ids.map((id, i) => {
      const s = definition[id];
      return {
        id,
        number: i + 1,
        title: s.task ?? (s.flow ? `flow: ${s.flow}` : "step"),
        detail: detailOf(s),
        refs: refsOf(s, known),
        layer: 0,
        row: 0,
      };
    });
  } else {
    nodes = plan.map((p) => ({ id: String(p.stepNumber), number: p.stepNumber, title: p.name, detail: "", refs: [], layer: 0, row: 0 }));
  }
  const chain = nodes.every((n) => n.refs.length === 0);
  if (chain) {
    nodes.forEach((n, i) => {
      n.layer = Math.floor(i / CHAIN_ROWS);
      n.row = i % CHAIN_ROWS;
    });
    return { nodes, chain };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) n.layer = n.refs.length ? 1 + Math.max(...n.refs.map((r) => byId.get(r)!.layer)) : 0;
  const rows = new Map<number, number>();
  for (const n of nodes) {
    n.row = rows.get(n.layer) ?? 0;
    rows.set(n.layer, n.row + 1);
  }
  return { nodes, chain };
}

/** The flow as a node graph: steps as nodes, ${steps.N...} references as edges, run state as color. */
export function FlowGraph({
  definition,
  plan,
  states,
  selected,
  onSelect,
}: {
  definition: Record<string, DeclaredStep> | null;
  plan: PlannedStep[];
  states: Record<number, StepState>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, chain } = useMemo(() => layout(definition, plan), [definition, plan]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const x = (n: Node) => PAD + n.layer * (W + GAP_X);
  const y = (n: Node) => PAD + n.row * (H + GAP_Y);
  const width = PAD * 2 + (Math.max(0, ...nodes.map((n) => n.layer)) + 1) * (W + GAP_X) - GAP_X;
  const height = PAD * 2 + (Math.max(0, ...nodes.map((n) => n.row)) + 1) * (H + GAP_Y) - GAP_Y;

  const edges: { from: Node; to: Node }[] = chain
    ? nodes.slice(1).map((to, i) => ({ from: nodes[i], to }))
    : nodes.flatMap((to) => to.refs.map((r) => ({ from: byId.get(r)!, to })));

  return (
    <div className="graph">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Flow steps as a graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="graph-arrow" />
          </marker>
        </defs>
        {edges.map(({ from, to }) => {
          const d = chain
            ? from.layer === to.layer
              ? `M${x(from) + W / 2},${y(from) + H} L${x(to) + W / 2},${y(to)}`
              : `M${x(from) + W},${y(from) + H / 2} C${x(from) + W + GAP_X},${y(from) + H / 2} ${x(to) - GAP_X},${y(to) + H / 2} ${x(to)},${y(to) + H / 2}`
            : (() => {
                const x1 = x(from) + W, y1 = y(from) + H / 2, x2 = x(to), y2 = y(to) + H / 2, mid = (x1 + x2) / 2;
                return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
              })();
          return <path key={`${from.id}-${to.id}`} d={d} className={chain ? "graph-edge chain" : "graph-edge"} markerEnd="url(#arrow)" />;
        })}
        {nodes.map((n) => {
          const state = states[n.number];
          return (
            <g
              key={n.id}
              transform={`translate(${x(n)},${y(n)})`}
              className={`graph-node ${state ?? ""} ${selected === n.id ? "selected" : ""}`}
              onClick={() => onSelect(n.id)}
            >
              <rect width={W} height={H} rx="6" />
              <text x="12" y="21" className="graph-num">{n.number}</text>
              <text x="34" y="21" className="graph-title">{clip(n.title, 23)}</text>
              <text x="12" y="40" className="graph-detail">{clip(n.detail, 34)}</text>
              {state && <circle cx={W - 14} cy="16" r="4" className="graph-state" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
