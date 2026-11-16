// @vitest-environment jsdom
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsNewButton, WhatsNewDialog } from "./WhatsNew";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { hacked?: number }).hacked;
});

/** ue-mcp's real 1.4.14-beta.5 notes, with its <details> folds. */
const REAL = fs.readFileSync(path.resolve(__dirname, "../../../../packages/client-core/test/fixtures/ue-mcp-1.4.14-beta.5.md"), "utf-8");

const studio = {
  part: "studio", name: "Studio", installed: "0.1.3", more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp-studio/releases",
  entries: [
    { version: "0.1.5", available: true, publishedAt: "2026-11-15T00:00:00Z", url: "https://github.com/db-lyon/ue-mcp-studio/releases/tag/v0.1.5", body: "- Newest change" },
    { version: "0.1.4", available: true, publishedAt: null, url: "https://github.com/db-lyon/ue-mcp-studio/releases/tag/v0.1.4", body: "## Fixes\n\n- **Bold** fix <script>window.hacked = 1</script> <img src=x onerror=\"window.hacked = 1\"> [docs](https://ue-mcp.com) [bad](javascript:alert(1)) <a href=\"https://ue-mcp.com/x\" onclick=\"window.hacked = 1\">html link</a>" },
  ],
};
const ueMcp = { part: "ueMcp", name: "ue-mcp", installed: "1.4.14-beta.4", more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp/releases", entries: [{ version: "1.4.14-beta.5", available: true, publishedAt: "2026-11-16T00:00:00Z", url: "https://github.com/db-lyon/ue-mcp/releases/tag/v1.4.14-beta.5", body: REAL }] };
const plugin = { part: "plugin", name: "Editor plugin (UE_MCP_Studio)", installed: "0.1.0", entries: [], more: 0, error: "GitHub answered 500", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio-plugin/releases" };
const bridge = { part: "bridge", name: "Bridge plugin (UE_MCP_Bridge)", installed: "1.4.1", entries: [], more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp/releases" };

function serve(answers: unknown[]) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    const body = answers.length > 1 ? answers.shift() : answers[0];
    return body === null ? new Response("", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }));
  return urls;
}

describe("What's new", () => {
  it("opens from the card and shows an accordion per part with something newer, hiding the rest", async () => {
    serve([{ channel: "stable", components: [studio, plugin, bridge] }]);
    render(<WhatsNewButton />);
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    expect(screen.getByText("Editor plugin (UE_MCP_Studio)")).toBeTruthy();
    expect(screen.queryByText("Bridge plugin (UE_MCP_Bridge)")).toBeNull();
    expect(screen.getByText("0.1.3 to 0.1.5")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "0.1.5" })).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    // Each release's link sits in its version row.
    expect(screen.getByRole("heading", { name: "0.1.5" }).parentElement!.querySelector("a")!.textContent).toBe("Release page");
  });

  it("renders markdown and the safe HTML, and nothing that runs", async () => {
    serve([{ channel: "stable", components: [studio] }]);
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Bold")).toBeTruthy());
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onerror], [onclick]")).toBeNull();
    expect([...document.querySelectorAll(".whats-new-notes img")].map((i) => i.getAttribute("src"))).toEqual([]);
    expect(screen.getByText("docs").getAttribute("href")).toBe("https://ue-mcp.com");
    expect(screen.getByText("html link").getAttribute("href")).toBe("https://ue-mcp.com/x");
    // The javascript: link is left as its text, not a link.
    expect([...document.querySelectorAll(".whats-new-notes a")].map((a) => a.textContent)).toEqual(["docs", "html link"]);
    expect([...document.querySelectorAll(".whats-new-notes")].map((n) => n.textContent).join(" ")).toContain("bad");
    expect((window as { hacked?: number }).hacked).toBeUndefined();
  });

  it("draws ue-mcp 1.4.14-beta.5's folds as collapsibles, without the heading restating the version", async () => {
    serve([{ channel: "beta", components: [ueMcp] }]);
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Editor dialogs")).toBeTruthy());
    const fold = screen.getByText("Editor dialogs").closest("details")!;
    expect(fold.className).toBe("whats-new-fold");
    expect(fold.querySelectorAll("li")).toHaveLength(3);
    expect(fold.querySelector("code")!.textContent).toBe("editor(list_dialogs)");
    expect(document.querySelector(".whats-new-notes")!.textContent).not.toMatch(/<\/?(details|summary|b)>/);
    const headings = [...document.querySelectorAll(".whats-new-notes h1, .whats-new-notes h2, .whats-new-notes h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Features"]);
  });

  it("offers Retry and the release page when a part's notes could not be read, and asks GitHub again", async () => {
    const urls = serve([{ channel: "stable", components: [plugin] }, { channel: "stable", components: [{ ...plugin, error: undefined, entries: [{ version: "0.1.1", body: "Now read", available: true }] }] }]);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Could not load the release notes: GitHub answered 500.")).toBeTruthy());
    fireEvent.click(screen.getByText("Release page"));
    expect(open).toHaveBeenCalledWith("https://github.com/db-lyon/ue-mcp-studio-plugin/releases", "_blank", "noopener");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.getByText("Now read")).toBeTruthy());
    expect(urls).toEqual(["/v1/ext/studio/whats-new", "/v1/ext/studio/whats-new?refresh=1"]);
  });

  it("says Nothing new when no part has anything newer, and that this Studio cannot read them without the route", async () => {
    serve([{ channel: "stable", components: [bridge] }]);
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Nothing new.")).toBeTruthy());
    cleanup();
    serve([null]);
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/cannot read release notes yet/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("closes on Escape", async () => {
    serve([{ channel: "stable", components: [] }]);
    const onClose = vi.fn();
    render(<WhatsNewDialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
