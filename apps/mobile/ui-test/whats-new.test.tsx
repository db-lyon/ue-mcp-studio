/** What's new on the phone: the accordions, the notes with their folds, and a part whose notes could not be read. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dimensions, Linking, Pressable, ScrollView } from "react-native";
import { WhatsNewSheet, whatsNewBodyMax } from "../src/screens/updates/WhatsNewSheet";
import { renderArea, settled } from "./area-b";

describe("What's new", () => {
  it("shows only the releases newer than installed under each version, and hides a part with nothing newer", async () => {
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.24 to 0.1.24-beta.27")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.27")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.getByText("No notes for this release.")).toBeTruthy();
    expect(screen.queryByText("Bridge plugin (UE_MCP_Bridge)")).toBeNull();
  });

  it("drops the heading restating a version, draws headings plainly, and folds <details> with its markdown inside", async () => {
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    // "## v0.1.24-beta.27" restates the version under its own heading: only the version row says it.
    expect(screen.getAllByText("0.1.24-beta.27")).toHaveLength(1);
    expect(screen.getByText("Features")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/<\/?(details|summary|b|script)>|window\.hacked/);
    // The fold is closed until tapped, then shows its list.
    expect(screen.queryByText(/reports a modal's pickers/)).toBeNull();
    fireEvent.click(screen.getByText("Editor dialogs"));
    expect(screen.getByText(/reports a modal's pickers/)).toBeTruthy();
  });

  it("scrolls each open part's notes in a box of its own under the fixed title, with what Android needs to scroll it", async () => {
    // A phone's window: jsdom has no layout, so react-native-web would read a height of 0 from the page.
    const size = { width: 412, height: 900 };
    const el = document.documentElement;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.height });
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => size.width });
    window.dispatchEvent(new Event("resize"));
    expect(Dimensions.get("window").height).toBe(size.height);
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    const list = screen.getByTestId("whats-new-body");
    const head = screen.getByTestId("whats-new-head");
    const card = screen.getByTestId("whats-new");
    expect(list.contains(head)).toBe(false);
    expect(head.querySelector('[aria-label="Close"]')).not.toBeNull();
    // The card is bounded by a number from the window, not a percentage, and the list shrinks to it and scrolls.
    expect(card.style.maxHeight).toMatch(/^\d+px$/);
    expect(["auto", "scroll"]).toContain(getComputedStyle(list).overflowY);
    expect(getComputedStyle(list).flexShrink).toBe("1");

    // The open part's notes: a scroll box with a numeric maxHeight of about half the screen.
    const studio = screen.getByTestId("whats-new-part-body-studio");
    const max = whatsNewBodyMax(size.height);
    expect(studio.style.maxHeight).toBe(`${max}px`);
    expect(max / size.height).toBeGreaterThanOrEqual(0.5);
    expect(max / size.height).toBeLessThanOrEqual(0.6);
    expect(["auto", "scroll"]).toContain(getComputedStyle(studio).overflowY);
    expect(studio.contains(screen.getByText("Editor dialogs"))).toBe(true);
    fireEvent.click(screen.getByText("Editor dialogs"));
    expect(studio.contains(screen.getByText(/reports a modal's pickers/))).toBe(true);

    // A second part opens with its own box; the list of headers around them still scrolls.
    fireEvent.click(screen.getByText("Editor plugin (UE_MCP_Studio)"));
    const plugin = screen.getByTestId("whats-new-part-body-plugin");
    expect(plugin.style.maxHeight).toBe(`${max}px`);
    expect(list.contains(studio) && list.contains(plugin)).toBe(true);

    // Android: every scroll view nests (the inner one scrolls before the list) and none sits inside a touchable.
    for (const s of [list, studio, plugin]) {
      expect(s.getAttribute("data-nested-scroll-enabled")).toBe("true");
      expect(s.hasAttribute("data-inside-pressable")).toBe(false);
    }
    expect(card.querySelector("[data-inside-pressable]")).toBeNull();
    // Back to the page's own (prototype) sizes for the tests after this one.
    delete (el as unknown as Record<string, unknown>).clientHeight;
    delete (el as unknown as Record<string, unknown>).clientWidth;
    window.dispatchEvent(new Event("resize"));
  });

  it("marks a scroll view inside a touchable, the arrangement that never scrolled on the phone", () => {
    render(
      <Pressable onPress={() => undefined}>
        <ScrollView testID="wrapped" nestedScrollEnabled />
      </Pressable>,
    );
    expect(screen.getByTestId("wrapped").getAttribute("data-inside-pressable")).toBe("true");
  });

  it("gives an open part a smaller share of a short screen", () => {
    expect(whatsNewBodyMax(900)).toBe(495);
    expect(whatsNewBodyMax(600) / 600).toBeLessThan(0.5);
  });

  it("closes from the backdrop, which sits behind the card rather than around it", async () => {
    const onClose = vi.fn();
    renderArea("settings-whats-new", <WhatsNewSheet onClose={onClose} />);
    await settled();
    const backdrop = screen.getByTestId("whats-new-backdrop");
    expect(backdrop.contains(screen.getByTestId("whats-new"))).toBe(false);
    fireEvent.click(screen.getByTestId("whats-new-part-body-studio"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when a part's notes could not be read, with Retry and the release page", async () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    fireEvent.click(screen.getByText("Editor plugin (UE_MCP_Studio)"));
    expect(screen.getByText("Could not load the release notes: GitHub is limiting requests right now.")).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Release page").at(-1)!);
    expect(open).toHaveBeenCalledWith("https://github.com/db-lyon/ue-mcp-studio-plugin/releases");
    open.mockRestore();
  });
});
