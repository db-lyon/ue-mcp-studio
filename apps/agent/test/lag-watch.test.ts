import { afterEach, describe, expect, it, vi } from "vitest";
import { LAG_REPORT_MS, LAG_TICK_MS, watchLag } from "../src/remote/routes.js";

afterEach(() => vi.useRealTimers());

describe("watchLag", () => {
  it("reports a stall of the event loop with its length, and not ordinary ticks", () => {
    vi.useFakeTimers();
    let clock = 0;
    const seen: number[] = [];
    const stop = watchLag((ms) => seen.push(ms), () => clock);
    for (let i = 0; i < 8; i++) {
      clock += LAG_TICK_MS;
      vi.advanceTimersByTime(LAG_TICK_MS);
    }
    expect(seen).toEqual([]);
    // The process was busy for three seconds: the next tick fires that late.
    clock += LAG_TICK_MS + 3000;
    vi.advanceTimersByTime(LAG_TICK_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(LAG_REPORT_MS);
    stop();
  });

  it("reports at most once every ten seconds", () => {
    vi.useFakeTimers();
    let clock = 0;
    const seen: number[] = [];
    const stop = watchLag((ms) => seen.push(ms), () => clock);
    for (let i = 0; i < 3; i++) {
      clock += LAG_TICK_MS + 2000;
      vi.advanceTimersByTime(LAG_TICK_MS);
    }
    expect(seen).toHaveLength(1);
    stop();
  });
});
