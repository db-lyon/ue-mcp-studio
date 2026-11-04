/**
 * RemoteReadOnly, the web client's disabled fieldset.remote-readonly: the note,
 * then what it covers at 70% with nothing pressable, and the settings sections
 * that draw their computer-only parts under it.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Pressable, Text } from "react-native";
import { REMOTE_CHANGE_NOTE as CORE_NOTE } from "@ue-mcp-studio/client-core";
import { REMOTE_CHANGE_NOTE, RemoteReadOnly } from "../src/views/settings/RemoteReadOnly";
import { ThemeProvider } from "../src/ui";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { renderArea, settled } from "./area-b";

const draw = (ui: React.ReactNode) => render(<ThemeProvider name="ue-mcp">{ui}</ThemeProvider>);

describe("RemoteReadOnly", () => {
  it("exports the note client-core words", () => {
    expect(REMOTE_CHANGE_NOTE).toBe(CORE_NOTE);
  });

  it("draws the note above its children, dimmed and not pressable", () => {
    const press = vi.fn();
    draw(
      <RemoteReadOnly>
        <Pressable accessibilityRole="button" accessibilityLabel="Save" onPress={press}>
          <Text>Save</Text>
        </Pressable>
      </RemoteReadOnly>,
    );
    const note = screen.getByText(REMOTE_CHANGE_NOTE);
    const wrap = screen.getByTestId("remote-readonly");
    expect(wrap.firstElementChild?.textContent).toBe(REMOTE_CHANGE_NOTE);
    expect(note).toBeTruthy();
    const covered = wrap.lastElementChild as HTMLElement;
    expect(getComputedStyle(covered).opacity).toBe("0.7");
    expect(getComputedStyle(covered).pointerEvents).toBe("none");
  });

  it("with remote false, draws the children alone", () => {
    draw(
      <RemoteReadOnly remote={false}>
        <Text>Save</Text>
      </RemoteReadOnly>,
    );
    expect(screen.queryByText(REMOTE_CHANGE_NOTE)).toBeNull();
    expect(screen.queryByTestId("remote-readonly")).toBeNull();
    expect(screen.getByText("Save")).toBeTruthy();
  });
});

describe("Settings sections under RemoteReadOnly, as the web client's", () => {
  const open = (scenario: string, section: string) => renderArea(scenario, (daemon) => <SettingsScreen daemon={daemon} section={section} onSection={vi.fn()} onTheme={vi.fn()} />);
  const covered = () => screen.queryAllByTestId("remote-readonly");

  it("Models & accounts: sign-ins, API keys and custom endpoints in one read-only block, the model table outside it", async () => {
    open("settings-models-remote", "models");
    await settled();
    expect(covered()).toHaveLength(1);
    const block = covered()[0];
    expect(block.textContent).toContain("Sign-ins");
    expect(block.textContent).toContain("API keys");
    expect(block.textContent).toContain("Custom endpoints");
    expect(block.textContent).not.toContain("Route order");
  });

  it("Approvals & review: the Ask first rules and the dialog policy, the playtest starts outside", async () => {
    open("settings-approvals-remote", "approvals");
    await settled();
    expect(covered()).toHaveLength(2);
    expect(covered()[0].textContent).not.toContain("Starting playtests");
    expect(covered()[1].textContent).toContain("If unanswered");
  });

  it("Project: the context strategy, and ue-mcp.yml once Advanced is open", async () => {
    open("settings-project-remote", "project");
    await settled();
    expect(covered()).toHaveLength(1);
    expect(covered()[0].textContent).toContain("Micro");
    fireEvent.click(screen.getByText("Advanced: ue-mcp.yml"));
    await settled();
    expect(covered()).toHaveLength(2);
    expect(covered()[1].textContent).toContain("Project config");
  });
});
