/** The subagents a turn runs at once, and the queue past that limit (#164). */
import { describe, expect, it } from "vitest";
import { SubagentSlots } from "../src/subagent-slots.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("subagent slots", () => {
  it("start 2 of 5 at once and the rest in order as each finishes", async () => {
    const slots = new SubagentSlots(2);
    const started: string[] = [];
    const waited: string[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) void slots.acquire(id, () => waited.push(id)).then((ok) => ok && started.push(id));
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(waited).toEqual(["c", "d", "e"]);
    expect(slots.counts).toEqual({ running: 2, waiting: 3 });
    slots.release("a");
    slots.release("a");
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    for (const id of ["b", "c", "d"]) slots.release(id);
    await tick();
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(slots.counts).toEqual({ running: 1, waiting: 0 });
  });

  it("cancel one waiting, or all of them as Stop does", async () => {
    const slots = new SubagentSlots(1);
    await slots.acquire("a");
    const b = slots.acquire("b");
    const c = slots.acquire("c");
    const d = slots.acquire("d");
    expect(slots.cancel("c")).toBe(true);
    expect(slots.cancel("a")).toBe(false);
    expect(await c).toBe(false);
    slots.cancelAll();
    expect([await b, await d]).toEqual([false, false]);
    expect(slots.counts).toEqual({ running: 1, waiting: 0 });
  });

  it("treat a limit below 1 as 1, so a call never waits forever", async () => {
    const slots = new SubagentSlots(0);
    expect(await slots.acquire("a")).toBe(true);
  });

  it("with -1, start every one at once and queue none (#173)", async () => {
    const slots = new SubagentSlots(-1);
    let waited = 0;
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => slots.acquire(`s${i}`, () => waited++)));
    expect(all.every(Boolean)).toBe(true);
    expect(waited).toBe(0);
    expect(slots.counts).toEqual({ running: 20, waiting: 0 });
  });
});
