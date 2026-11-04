/**
 * Plugins read only, and Diagnostics with its editor controls and event log,
 * as a paired phone sees them.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { REMOTE_PLUGINS_NOTE } from "@ue-mcp-studio/client-core";
import { PluginsScreen } from "../src/screens/plugins/PluginsScreen";
import { DiagnosticsSection } from "../src/screens/diagnostics/DiagnosticsSection";
import { renderArea, settled } from "./area-b";

describe("Plugins", () => {
  it("lists the installed plugins and the catalog read only, under the note", async () => {
    renderArea("plugins-remote", <PluginsScreen />);
    await settled();
    expect(screen.getByText(REMOTE_PLUGINS_NOTE)).toBeTruthy();
    expect(screen.getByText("ue-mcp-meshy")).toBeTruthy();
    expect(screen.getByText("missing")).toBeTruthy();
    expect(screen.getAllByText("installed").length).toBe(2);
    for (const word of ["Install", "Update", "Remove"]) expect(screen.queryByText(word)).toBeNull();
  });

  it("opens a plugin's details, and searches the catalog", async () => {
    renderArea("plugins-remote-details", <PluginsScreen />);
    await settled();
    fireEvent.click(screen.getAllByLabelText("Details")[0]);
    await settled();
    expect(screen.getByText("Hide details")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "voxel" } });
    await settled();
    expect(screen.getByText("No plugin matches.")).toBeTruthy();
  });

  it("says what is empty, what failed, and an older ue-mcp", async () => {
    let v = renderArea("plugins-remote-empty", <PluginsScreen />);
    await settled();
    expect(screen.getByText("No plugins in this project yet. Browse the catalog below.")).toBeTruthy();
    v.unmount();
    v = renderArea("plugins-remote-error", <PluginsScreen />);
    await settled();
    expect(screen.getByText(/is not answered/)).toBeTruthy();
    v.unmount();
    renderArea("plugins-remote-unsupported", <PluginsScreen />);
    await settled();
    expect(screen.getByText(/Managing plugins here needs ue-mcp 1.4.0-beta.2 or later/)).toBeTruthy();
  });

  it("reads the installed list again when another client changes it", async () => {
    const { sent, emit } = renderArea("plugins-remote", <PluginsScreen />);
    await settled();
    const before = sent.filter((s) => s.path === "/v1/plugins").length;
    await emit("plugins.changed", {});
    await settled();
    expect(sent.filter((s) => s.path === "/v1/plugins").length).toBe(before + 1);
  });
});

describe("Diagnostics", () => {
  it("shows the editor and daemon, and starts nothing while the editor runs", async () => {
    renderArea("settings-diagnostics", <DiagnosticsSection />);
    await settled();
    expect(screen.getByText("StudioE2E")).toBeTruthy();
    expect(screen.getByLabelText("Start").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("Restart").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("restarts the editor from the phone", async () => {
    const { writes } = renderArea("settings-diagnostics", <DiagnosticsSection />);
    await settled();
    fireEvent.click(screen.getByLabelText("Restart"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ method: "POST", path: "/v1/editor/restart" }));
  });

  it("says how the editor went away, and offers Start", async () => {
    renderArea("settings-diagnostics-no-editor", <DiagnosticsSection />);
    await settled();
    expect(screen.getByText(/crashed at/)).toBeTruthy();
    expect(screen.getByLabelText("Start").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("logs events newest first, opens a payload, and filters", async () => {
    const { emit } = renderArea("settings-diagnostics", <DiagnosticsSection />);
    await settled();
    expect(screen.getByText("No events yet.")).toBeTruthy();
    await emit("editor.connected", { project: "StudioE2E" });
    await emit("studio.remote.available", {});
    await settled();
    const types = screen.getAllByText(/^(editor\.connected|studio\.remote\.available)$/).map((e) => e.textContent);
    expect(types).toEqual(["studio.remote.available", "editor.connected"]);
    fireEvent.click(screen.getByLabelText("Payload of editor.connected"));
    expect(screen.getByText(/"project": "StudioE2E"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter events"), { target: { value: "remote" } });
    await settled();
    expect(screen.queryByText("editor.connected")).toBeNull();
  });
});
