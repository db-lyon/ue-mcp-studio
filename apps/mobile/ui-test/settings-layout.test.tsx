/**
 * Settings and Diagnostics laid out as the web client lays them out at phone
 * width: the measures the parity shots found off, held here so they stay put.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { EditorStatus } from "../src/screens/editor/EditorStatus";
import { Radio, lightRadio } from "../src/screens/settings/controls";
import { ThemeProvider } from "../src/ui";
import { renderArea, settled } from "./area-b";
import { fakeApi, renderInProject, settle } from "./helpers";

describe("settings controls", () => {
  it("draws a chosen radio light where its accent is too dark for the dark disc, as Chrome does", () => {
    expect(lightRadio("#0070e0")).toBe(true);
    expect(lightRadio("#e8720c")).toBe(false);
    const { container } = renderInProject(
      <ThemeProvider name="editor">
        <Radio on />
      </ThemeProvider>,
    );
    const discs = [...container.querySelectorAll("div")].map((d) => d.style.backgroundColor);
    expect(discs).toContain("rgb(255, 255, 255)");
  });
});

const section = (scenario: string, name: string, theme: "ue-mcp" | "editor" | "editor-orange" = "ue-mcp") =>
  renderArea(scenario, (daemon) => <SettingsScreen daemon={daemon} section={name} onSection={() => {}} onTheme={() => {}} />, theme);

describe("Settings > Agents", () => {
  it("stacks a long choice's options one under another with no gap between them", async () => {
    section("settings-agents", "agents");
    await settled();
    const radios = screen.getAllByRole("radio").filter((r) => ["Never", "When you ask", "When work splits into independent parts"].includes(r.getAttribute("aria-label") ?? ""));
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(getComputedStyle(r).marginTop).toMatch(/^(0px)?$/);
    expect(getComputedStyle(radios[1]).borderTopWidth).toBe("1px");
  });

  it("draws the model picker's label in the editor themes' button type", async () => {
    section("settings-agents-not-connected", "agents", "editor-orange");
    await settled();
    expect(screen.getByText("Choose a model").style.lineHeight).toBe("14.390625px");
    expect(screen.getAllByText("▾")[0].style.lineHeight).toBe("12px");
  });

  it("keeps the model picker's own 500 12px/1 in ue-mcp", async () => {
    section("settings-agents-not-connected", "agents");
    await settled();
    expect(screen.getByText("Choose a model").style.lineHeight).toBe("12px");
    expect(screen.getAllByText("▾")[0].style.lineHeight).toBe("10px");
  });

  it("sets the model a subagent's file names in the system monospace", async () => {
    section("settings-agents", "agents");
    await settled();
    const code = screen.getByText("haiku");
    expect(getComputedStyle(code).fontFamily).toContain("monospace");
    expect(code.parentElement?.textContent).toBe("Haiku 5.5 (file says haiku)");
  });
});

describe("Diagnostics", () => {
  it("gives a payload line the 44px a summary takes on a touch screen", async () => {
    const { emit } = section("settings-diagnostics", "diagnostics");
    await settled();
    await emit("editor.connected", { project: "StudioE2E" });
    await settled();
    const payload = screen.getByLabelText("Payload of editor.connected");
    expect(getComputedStyle(payload).minHeight).toBe("44px");
    fireEvent.click(payload);
    expect(screen.getByText(/"project": "StudioE2E"/)).toBeTruthy();
  });

  it("collapses the Editors heading's margin into the buttons' when no editor is listed", async () => {
    const a = fakeApi();
    a.daemonHealth.mockResolvedValue({ version: "1.4.0", apiVersion: 1, pid: 1, startedAt: "2026-10-28T10:00:00Z", clients: 0, inflight: 0, ui: null, projectRoot: "c:/p", extensions: [], editors: [] });
    renderInProject(<EditorStatus />, a);
    await settle();
    await settle();
    const actions = screen.getByText("Start").closest("[role=button]")!.parentElement!;
    expect(getComputedStyle(actions).marginTop).toBe("2px");
  });
});
