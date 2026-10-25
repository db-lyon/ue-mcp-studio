/**
 * Plan meters: the limit windows each sign-in reports, kept as last
 * reported. The Claude sign-in reports them as the Agent SDK's rate-limit
 * events; the ChatGPT sign-in in its responses' limit headers. A route that
 * never reported says so: nothing here is estimated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanWindow } from "@ue-mcp-studio/shared";

type Route = "claude" | "chatgpt";

interface Saved {
  reportedAt: string;
  windows: Record<string, PlanWindow>;
}

const LABELS: Record<string, string> = {
  five_hour: "Five-hour window",
  seven_day: "Weekly",
  seven_day_opus: "Weekly, Opus",
  seven_day_sonnet: "Weekly, Sonnet",
  seven_day_overage_included: "Weekly, with extra usage",
  overage: "Extra usage",
  primary: "Short window",
  secondary: "Long window",
};

/** A window's label, with its length when the route says it. */
const label = (kind: string, minutes?: number): string => {
  if (kind === "primary" || kind === "secondary") {
    if (minutes && minutes % 1440 === 0) return `${minutes / 1440 === 7 ? "Weekly" : `${minutes / 1440}-day`} window`;
    if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  }
  return LABELS[kind] ?? kind.replace(/_/g, " ");
};

/** ChatGPT's limit headers on a response, as windows; empty when it sent none. */
export function chatgptWindows(headers: { get(name: string): string | null }, now = Date.now()): PlanWindow[] {
  const out: PlanWindow[] = [];
  for (const kind of ["primary", "secondary"] as const) {
    const used = headers.get(`x-codex-${kind}-used-percent`);
    if (used === null) continue;
    const pct = Number(used);
    const minutes = Number(headers.get(`x-codex-${kind}-window-minutes`) ?? NaN);
    const after = Number(headers.get(`x-codex-${kind}-reset-after-seconds`) ?? NaN);
    out.push({
      kind,
      label: label(kind, Number.isFinite(minutes) ? minutes : undefined),
      used: Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : null,
      resetsAt: Number.isFinite(after) ? new Date(now + after * 1000).toISOString() : null,
      status: Number.isFinite(pct) && pct >= 100 ? "rejected" : "allowed",
    });
  }
  return out;
}

/** The SDK's rate-limit event as a window. */
export function claudeWindow(i: { type?: string; utilization?: number; resetsAt?: number; status: string }): PlanWindow {
  const kind = i.type ?? "five_hour";
  return {
    kind,
    label: label(kind),
    used: typeof i.utilization === "number" ? Math.max(0, Math.min(1, i.utilization > 1 ? i.utilization / 100 : i.utilization)) : null,
    // The SDK reports reset times in seconds since the epoch.
    resetsAt: typeof i.resetsAt === "number" ? new Date(i.resetsAt < 1e12 ? i.resetsAt * 1000 : i.resetsAt).toISOString() : null,
    status: i.status === "rejected" ? "rejected" : i.status === "allowed_warning" ? "warning" : i.status === "allowed" ? "allowed" : "unknown",
  };
}

export class PlanStore {
  private readonly file: string;

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(dataDir, "plans.json");
  }

  private read(): Partial<Record<Route, Saved>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<Record<Route, Saved>>;
    } catch {
      return {};
    }
  }

  report(route: Route, windows: PlanWindow[]): void {
    if (!windows.length) return;
    const all = this.read();
    const cur = all[route] ?? { reportedAt: "", windows: {} };
    for (const w of windows) cur.windows[w.kind] = w;
    cur.reportedAt = this.now().toISOString();
    all[route] = cur;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  /** The windows last reported, a window whose reset time has passed shown as reset. */
  get(route: Route): { reportedAt: string | null; windows: PlanWindow[] } {
    const s = this.read()[route];
    if (!s) return { reportedAt: null, windows: [] };
    const now = this.now().getTime();
    const windows = Object.values(s.windows).map((w) => (w.resetsAt && new Date(w.resetsAt).getTime() <= now ? { ...w, used: 0, status: "allowed" as const, resetsAt: null } : w));
    return { reportedAt: s.reportedAt, windows };
  }
}
