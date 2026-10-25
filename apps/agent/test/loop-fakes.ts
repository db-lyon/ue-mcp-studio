/** The playtest loop's support with a faked daemon: checkpoints over FakeCheckpoints, a budget, and the notifications it sent. */
import type { PlaytestBudget, QaLoop, QaRun, TimelineMark } from "@ue-mcp-studio/shared";
import type { QaLoopSupport } from "../src/qa.js";
import { FakeCheckpoints } from "./checkpoint-fake.js";

export interface FakeLoopSupport extends QaLoopSupport {
  cp: FakeCheckpoints;
  marks: Array<{ sessionId: string; mark: TimelineMark }>;
  notified: Array<{ sessionId: string; loop: QaLoop; run: QaRun }>;
  /** Set to make checkpoints unavailable, with this reason. */
  missing: string | null;
  budgetNow: PlaytestBudget;
}

export function fakeLoopSupport(cp = new FakeCheckpoints()): FakeLoopSupport {
  cp.enabled = true;
  const f: FakeLoopSupport = {
    cp,
    marks: [],
    notified: [],
    missing: null,
    budgetNow: { minutes: 60, tokens: 1_000_000 },
    checkpoints: {
      unavailable: () => f.missing,
      checkpoint: async (label) => cp.create(label),
      changes: async (from, to) => (await cp.changes(from, to)).changes,
      restore: async (checkpoint, paths, force) => {
        const r = await cp.restore(checkpoint, { ...(paths ? { paths } : {}), ...(force ? { force } : {}) });
        return {
          restored: r.restored.map((x) => x.path),
          conflicts: r.refused.filter((x) => x.reason === "edited-outside").map((x) => x.path),
          missing: r.refused.filter((x) => x.reason === "not-recorded").map((x) => x.path),
          before: r.before,
          after: r.after,
        };
      },
      mark: (sessionId, mark) => void f.marks.push({ sessionId, mark }),
    },
    budget: () => f.budgetNow,
    notify: (sessionId, loop, run) => void f.notified.push({ sessionId, loop, run }),
    tickMs: 5,
  };
  return f;
}

/** Until a condition holds, or two seconds pass. */
export async function until(f: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
}
