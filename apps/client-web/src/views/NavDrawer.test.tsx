// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ sessions: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { NavDrawer, type NavTab } from "./NavDrawer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const session = (id: string, title: string, archived = false) => ({
  id, title, archived, status: "idle", createdAt: "", updatedAt: "", waitingCause: null, agents: { total: 0, running: 0 }, awaiting: 0,
});

function setup(open = true, tab: NavTab = "Chat", updates = 0, playtestsWaiting = 0) {
  m.sessions.mockResolvedValue({ sessions: [session("a", "Glowing material"), session("b", "Old work", true), session("c", "Niagara fire")] });
  const props = { onClose: vi.fn(), onTab: vi.fn(), onSession: vi.fn(), onNewSession: vi.fn() };
  const { container } = render(
    <NavDrawer open={open} tab={tab} session="c" updates={updates} playtestsWaiting={playtestsWaiting} {...props}>
      <button>Docs</button>
    </NavDrawer>,
  );
  return { ...props, root: container.querySelector(".drawer-root")! };
}

describe("the navigation drawer", () => {
  it("lists the tabs, marks the current one, and carries the bar's tools", () => {
    setup(true, "Plugins", 2);
    expect(screen.getByText("Plugins").closest("button")?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Chat").closest("button")?.getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Settings").closest("button")?.querySelector(".tab-dot")).not.toBeNull();
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  it("hides the Playtests page for now, even while playtests need the user", () => {
    setup(true, "Chat", 0, 2);
    expect(screen.queryByText("Playtests")).toBeNull();
  });

  it("lists the recent sessions when it opens, leaving archived ones out, and marks the open one", async () => {
    setup();
    await screen.findByText("Glowing material");
    expect(screen.queryByText("Old work")).toBeNull();
    expect(screen.getByText("Niagara fire").closest("button")?.classList.contains("active")).toBe(true);
  });

  it("reads nothing while closed", () => {
    const { root } = setup(false);
    expect(m.sessions).not.toHaveBeenCalled();
    expect(root.classList.contains("open")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens a session, a tab or a new session, and closes after each", async () => {
    const p = setup();
    fireEvent.click(await screen.findByText("Glowing material"));
    expect(p.onSession).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByText("Plugins"));
    expect(p.onTab).toHaveBeenCalledWith("Plugins");
    fireEvent.click(screen.getByText("New session"));
    expect(p.onNewSession).toHaveBeenCalledOnce();
    expect(p.onClose).toHaveBeenCalledTimes(3);
  });

  it("closes from the scrim and from Escape", () => {
    const p = setup();
    fireEvent.click(document.querySelector(".drawer-scrim")!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
