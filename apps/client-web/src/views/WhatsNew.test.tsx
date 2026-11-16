// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsNewButton, WhatsNewDialog } from "./WhatsNew";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const studio = {
  part: "studio", name: "Studio", installed: "0.1.3", previous: "0.1.1", more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp-studio/releases",
  entries: [
    { version: "0.1.4", available: true, publishedAt: "2026-11-15T00:00:00Z", url: "https://github.com/db-lyon/ue-mcp-studio/releases/tag/v0.1.4", body: "- Waiting change" },
    { version: "0.1.3", available: false, publishedAt: null, url: "https://github.com/db-lyon/ue-mcp-studio/releases/tag/v0.1.3", body: "## Fixes\n\n- **Bold** fix <script>window.hacked = 1</script> [docs](https://ue-mcp.com) [bad](javascript:alert(1))" },
  ],
};
const plugin = { part: "plugin", name: "Editor plugin (UE_MCP_Studio)", installed: "0.1.0", previous: null, entries: [], more: 0, error: "GitHub answered 500", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio-plugin/releases" };
const bridge = { part: "bridge", name: "Bridge plugin (UE_MCP_Bridge)", installed: "1.4.1", previous: null, entries: [], more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp/releases" };

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
  it("opens from the card and shows an accordion per part with notes, hiding the empty ones", async () => {
    serve([{ channel: "stable", components: [studio, plugin, bridge] }]);
    render(<WhatsNewButton />);
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    expect(screen.getByText("Editor plugin (UE_MCP_Studio)")).toBeTruthy();
    expect(screen.queryByText("Bridge plugin (UE_MCP_Bridge)")).toBeNull();
    expect(screen.getByText("0.1.1 to 0.1.3, 0.1.4 available")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "0.1.4" })).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    // Markdown renders, raw HTML does not, and only safe links stay links.
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("docs").getAttribute("href")).toBe("https://ue-mcp.com");
    expect(screen.getByText("bad").getAttribute("href") ?? "").not.toMatch(/javascript/i);
  });

  it("offers Retry and the release page when a part's notes could not be read, and asks GitHub again", async () => {
    const urls = serve([{ channel: "stable", components: [plugin] }, { channel: "stable", components: [{ ...plugin, error: undefined, entries: [{ version: "0.1.0", body: "Now read", available: false }] }] }]);
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

  it("says Nothing new when no part has notes, and that this Studio cannot read them without the route", async () => {
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
