// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SLOT_NAMES, type SlotContribution, type SlotName } from "@ue-mcp-studio/extension-api";
import { clearSlots, register, slotItems } from "./registry";
import { Slot } from "./Slot";
import { publishEvent } from "./events";

afterEach(() => {
  cleanup();
  clearSlots();
  vi.restoreAllMocks();
});

/** A contribution that writes its context into its element and records each call. */
function recorder<S extends SlotName>(id: string, extra: Partial<SlotContribution<S>> = {}) {
  const calls: Array<{ call: string; ctx?: Record<string, unknown> }> = [];
  const contribution: SlotContribution<S> = {
    id,
    mount(el, ctx) {
      calls.push({ call: "mount", ctx: ctx as never });
      el.textContent = `${id}:${JSON.stringify((ctx as { status?: string }).status ?? null)}`;
      return {
        update(next) {
          calls.push({ call: "update", ctx: next as never });
          el.textContent = `${id}:${JSON.stringify((next as { status?: string }).status ?? null)}`;
        },
        unmount() {
          calls.push({ call: "unmount" });
        },
      };
    },
    ...extra,
  };
  return { contribution, calls };
}

describe("the slot registry", () => {
  it("takes exactly the slots the extension API names", () => {
    for (const slot of SLOT_NAMES) expect(() => register(slot, recorder(`c-${slot.replace(".", "-")}`).contribution, "pro")).not.toThrow();
    expect(() => register("nowhere" as SlotName, recorder("x").contribution, "pro")).toThrow(/unknown slot/);
  });

  it("refuses names that cannot be used in a hash or an attribute, and a contribution with no mount", () => {
    expect(() => register("toolbar.action", recorder("a b").contribution, "pro")).toThrow(/id/);
    expect(() => register("toolbar.action", recorder("ok").contribution, "pro/x")).toThrow(/extension/);
    expect(() => register("toolbar.action", { id: "nomount" } as never, "pro")).toThrow(/mount/);
  });

  it("orders by order, then registration, and the same id again replaces the earlier one", () => {
    register("toolbar.action", recorder("late", { order: 5 }).contribution, "pro");
    register("toolbar.action", recorder("first").contribution, "pro");
    register("toolbar.action", recorder("second").contribution, "other");
    register("toolbar.action", recorder("early", { order: -1 }).contribution, "pro");
    expect(slotItems("toolbar.action").map((i) => i.key)).toEqual(["pro:early", "pro:first", "other:second", "pro:late"]);
    register("toolbar.action", recorder("first", { title: "again" }).contribution, "pro");
    expect(slotItems("toolbar.action").map((i) => i.key)).toEqual(["pro:early", "other:second", "pro:first", "pro:late"]);
    expect(slotItems("toolbar.action").find((i) => i.key === "pro:first")?.contribution.title).toBe("again");
    expect(slotItems("session.panel")).toEqual([]);
  });
});

describe("<Slot>", () => {
  it("renders nothing with no contributions", () => {
    const { container } = render(<div id="mount"><Slot name="session.panel" ctx={{ sessionId: "s1", status: "idle" }} /></div>);
    expect(container.innerHTML).toBe('<div id="mount"></div>');
  });

  it("mounts a contribution with its context, updates it, and unmounts it on removal", async () => {
    const { contribution, calls } = recorder<"session.panel">("panel");
    const { container, rerender } = render(<Slot name="session.panel" ctx={{ sessionId: "s1", status: "idle" }} />);
    let remove = () => {};
    act(() => void (remove = register("session.panel", contribution, "pro")));
    const el = container.querySelector('.ext-slot[data-slot="session.panel"][data-ext="pro"][data-contribution="panel"]')!;
    expect(el.textContent).toBe('panel:"idle"');
    expect(calls[0].call).toBe("mount");
    expect(calls[0].ctx).toMatchObject({ sessionId: "s1", status: "idle" });
    expect(typeof (calls[0].ctx!.api as { fetchJson: unknown }).fetchJson).toBe("function");
    expect(typeof (calls[0].ctx!.events as { subscribe: unknown }).subscribe).toBe("function");

    // An equal context sends no update; a changed one does.
    rerender(<Slot name="session.panel" ctx={{ sessionId: "s1", status: "idle" }} />);
    expect(calls.map((c) => c.call)).toEqual(["mount"]);
    rerender(<Slot name="session.panel" ctx={{ sessionId: "s1", status: "running" }} />);
    expect(calls.map((c) => c.call)).toEqual(["mount", "update"]);
    expect(el.textContent).toBe('panel:"running"');

    act(() => remove());
    expect(calls.map((c) => c.call)).toEqual(["mount", "update", "unmount"]);
    expect(container.innerHTML).toBe("");
  });

  it("contains a contribution that throws: it is left out and logged, the others still mount", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = recorder<"toolbar.action">("good");
    register("toolbar.action", { id: "bad", mount: () => { throw new Error("boom"); } }, "pro");
    register("toolbar.action", good.contribution, "pro");
    const { container } = render(<Slot name="toolbar.action" ctx={{}} />);
    expect([...container.querySelectorAll(".ext-slot")].map((e) => e.getAttribute("data-contribution"))).toEqual(["good"]);
    expect(good.calls.map((c) => c.call)).toEqual(["mount"]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("pro:bad") && (c[1] as Error).message === "boom")).toBe(true);
  });

  it("hides and unmounts a contribution whose update throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unmount = vi.fn();
    register("session.panel", { id: "p", mount: () => ({ update: () => { throw new Error("bad update"); }, unmount }) }, "pro");
    const { container, rerender } = render(<Slot name="session.panel" ctx={{ sessionId: "s1", status: "idle" }} />);
    expect(container.querySelector(".ext-slot")).toBeTruthy();
    rerender(<Slot name="session.panel" ctx={{ sessionId: "s1", status: "running" }} />);
    expect(container.querySelector(".ext-slot")).toBeNull();
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it("wraps each contribution when asked, keyed per contribution", () => {
    register("session.panel", recorder("one", { title: "One" }).contribution, "pro");
    register("session.panel", recorder("two").contribution, "pro");
    const { container } = render(
      <Slot name="session.panel" ctx={{ sessionId: "s1", status: "idle" }} wrap={(item, host) => <section data-for={item.key}>{item.contribution.title ?? item.contribution.id}{host}</section>} />,
    );
    expect([...container.querySelectorAll("section")].map((s) => [s.getAttribute("data-for"), s.firstChild?.textContent])).toEqual([["pro:one", "One"], ["pro:two", "two"]]);
  });
});

describe("a contribution's api and events", () => {
  it("requests only under its extension's routes", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    let ctx: { api: { fetchJson: (p: string, i?: object) => Promise<unknown> } } | null = null;
    register("toolbar.action", { id: "t", mount: (_el, c) => ((ctx = c as never), { unmount() {} }) }, "pro");
    render(<Slot name="toolbar.action" ctx={{}} />);
    expect(await ctx!.api.fetchJson("/plan")).toEqual({ ok: 1 });
    await ctx!.api.fetchJson("usage?x=1", { body: { a: 1 } });
    expect(fetch.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([["/v1/ext/pro/plan", "GET"], ["/v1/ext/pro/usage?x=1", "POST"]]);
    await expect(ctx!.api.fetchJson("../studio/settings")).rejects.toThrow(/leaves/);
    await expect(ctx!.api.fetchJson("a/%2e%2e/b")).rejects.toThrow(/leaves/);
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    await expect(ctx!.api.fetchJson("plan")).rejects.toMatchObject({ status: 403, message: "nope" });
  });

  it("hears the daemon events Studio reads until it unsubscribes", () => {
    let ctx: { events: { subscribe: (l: (e: unknown) => void) => () => void } } | null = null;
    register("toolbar.action", { id: "t", mount: (_el, c) => ((ctx = c as never), { unmount() {} }) }, "pro");
    render(<Slot name="toolbar.action" ctx={{}} />);
    const heard: unknown[] = [];
    const stop = ctx!.events.subscribe((e) => heard.push(e));
    const e = { id: 1, type: "studio.session.changed", at: "t", data: { sessionId: "s1" } };
    publishEvent(e);
    stop();
    publishEvent({ ...e, id: 2 });
    expect(heard).toEqual([e]);
  });
});
