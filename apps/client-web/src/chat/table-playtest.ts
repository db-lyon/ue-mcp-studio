/**
 * A playtest written as a markdown table: a column of steps, and a pass
 * condition or a judge column (auto with its check, or manual), often with the
 * player each step is for. Studio reads its rows as a script's steps.
 */
import type { QaExpect, QaScriptStep } from "@ue-mcp-studio/shared";

export interface TableStep {
  instruction: string;
  judge?: "auto" | "manual";
  expect?: QaExpect;
  player?: string;
}

export interface TablePlaytest {
  /** A name for the script, from the heading above the table. */
  name: string | null;
  steps: TableStep[];
}

const STEP_COL = /^(do|steps?|actions?|instructions?|what to do|test|try|what)$/i;
const PASS_COL = /^(pass( when| if| criteria)?|expected( result)?|expect(ation)?|success( when)?|check)$/i;
const JUDGE_COL = /^(judged( by| with)?|judge|how( judged)?|type|auto\s*\/\s*manual|verdict by)$/i;
const PLAYER_COL = /^(player|who|window|role|client)$/i;

const OPS: Record<string, string> = { eq: "eq", "==": "eq", "=": "eq", gt: "gt", ">": "gt", lt: "lt", "<": "lt", increasing: "increasing", increases: "increasing", decreasing: "decreasing", decreases: "decreasing", visible: "visible", exists: "exists" };

const plain = (cell: string): string => cell.replace(/\*\*|__/g, "").replace(/`([^`]*)`/g, "$1").replace(/<br\s*\/?>/gi, " ").trim();

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const inner = t.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

const isRule = (row: string[]): boolean => row.length > 0 && row.every((c) => /^:?-{2,}:?$/.test(c));

/** auto with its check, manual, or neither: "auto: `Door.OpenAngle` gt 80, within 3 s". */
export function judgeOf(cell: string): { judge?: "auto" | "manual"; expect?: QaExpect } {
  const text = cell.trim();
  if (/^manual\b/i.test(plain(text))) return { judge: "manual" };
  const auto = /^auto\b\s*[:\-]?\s*(.*)$/i.exec(plain(text));
  if (!auto) return {};
  const m = /^([A-Za-z_][\w.]*)\s+(eq|gt|lt|==|=|>|<|increasing|increases|decreasing|decreases|visible|exists)(?=\s|,|$)\s*(-?\d+(?:\.\d+)?|true|false)?\s*(?:,?\s*within\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?)?/i.exec(auto[1].trim());
  if (!m) return { judge: "auto" };
  const op = OPS[m[2].toLowerCase()];
  const expect: QaExpect = { value: m[1], op };
  if (m[3] !== undefined && op !== "increasing" && op !== "decreasing") expect.target = /^(true|false)$/i.test(m[3]) ? m[3].toLowerCase() === "true" : Number(m[3]);
  if (m[4] !== undefined) expect.within_ms = Math.round(Number(m[4]) * (m[5] && /^ms$/i.test(m[5]) ? 1 : 1000));
  return { judge: "auto", expect };
}

/** host, client <n>, or none for a step any player takes. */
export function playerOf(cell: string): string | undefined {
  const t = plain(cell).toLowerCase();
  if (/^(host|server|listen server)$/.test(t)) return "host";
  const c = /^client\s*(\d+)?$/.exec(t);
  return c ? `client ${c[1] ?? 1}` : undefined;
}

/** The first playtest table in a reply, or null when it has none. Tables in code blocks do not count. */
export function tablePlaytest(text: string): TablePlaytest | null {
  const lines = text.split(/\r?\n/);
  let fenced = false;
  let heading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^\s{0,3}(?:#{1,6}\s+(.+?)\s*#*\s*$|\*\*(.+?)\*\*:?\s*$)/.exec(line);
    if (h) heading = (h[1] ?? h[2]).trim();
    const head = cells(line);
    const rule = i + 1 < lines.length ? cells(lines[i + 1]) : null;
    if (!head || !rule || !isRule(rule)) continue;
    const names = head.map(plain);
    const stepCol = names.findIndex((n) => STEP_COL.test(n));
    const passCol = names.findIndex((n) => PASS_COL.test(n));
    const judgeCol = names.findIndex((n) => JUDGE_COL.test(n));
    const playerCol = names.findIndex((n) => PLAYER_COL.test(n));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const row = cells(lines[j]);
      if (!row) break;
      rows.push(row);
    }
    if (stepCol < 0 || (passCol < 0 && judgeCol < 0) || rows.length < 2) {
      i = j - 1;
      continue;
    }
    const steps = rows.map((row) => {
      const what = plain(row[stepCol] ?? "");
      const pass = passCol >= 0 ? plain(row[passCol] ?? "") : "";
      const judged = judgeCol >= 0 ? judgeOf(row[judgeCol] ?? "") : {};
      const player = playerCol >= 0 ? playerOf(row[playerCol] ?? "") : undefined;
      return {
        instruction: pass ? `${what.replace(/[.\s]+$/, "")}. Pass when: ${pass}` : what,
        ...judged,
        ...(player ? { player } : {}),
      };
    }).filter((s) => s.instruction.trim());
    if (steps.length >= 2) return { name: heading, steps };
    i = j - 1;
  }
  return null;
}

/**
 * The table's rows as script steps, when every row says how it is judged and
 * every auto row names its check; null when the agent has to fill some in.
 */
export function tableScriptSteps(t: TablePlaytest): QaScriptStep[] | null {
  if (!t.steps.every((s) => s.judge === "manual" || (s.judge === "auto" && s.expect))) return null;
  return t.steps.map((s) => ({
    instruction: s.instruction,
    judge: s.judge!,
    ...(s.expect ? { expect: s.expect } : {}),
    ...(s.player ? { player: s.player } : {}),
  }));
}

/** A script name from a heading, or one with the time when there is none: letters, digits and underscores. */
export function scriptName(heading: string | null, now = new Date()): string {
  const words = (heading ?? "").replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).filter((w) => !/^(playtest|test|plan|draft|for|the|a|an)$/i.test(w));
  const base = words.slice(0, 5).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const stamp = `${now.getHours()}`.padStart(2, "0") + `${now.getMinutes()}`.padStart(2, "0") + `${now.getSeconds()}`.padStart(2, "0");
  return base ? `PT_${base}` : `PT_Playtest_${stamp}`;
}
