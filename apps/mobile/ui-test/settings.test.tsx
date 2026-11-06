/**
 * Settings as a paired phone sees it: the section list with each section's
 * state, every section, what is read only and what still changes, and the
 * theme switching the app.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { REMOTE_CHANGE_NOTE } from "@ue-mcp-studio/client-core";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { openFileInline } from "../src/screens/settings/NativePanel";
import { renderArea, settled } from "./area-b";

const open = (scenario: string, section: string | null, onSection = vi.fn(), onTheme = vi.fn()) => ({ ...renderArea(scenario, (daemon) => <SettingsScreen daemon={daemon} section={section} onSection={onSection} onTheme={onTheme} />), onTheme });

describe("Settings > the section list", () => {
  it("lists every group and section, with each section's state, and Remote control since the computer refuses its routes", async () => {
    const onSection = vi.fn();
    open("settings-list", null, onSection);
    await settled();
    for (const name of ["General", "Remote control", "Agents", "Models & accounts", "Approvals & review", "Project", "Diagnostics"]) expect(screen.getByLabelText(name)).toBeTruthy();
    expect(screen.getByText("Sonnet 5.5 on Claude sign-in, project files on")).toBeTruthy();
    expect(screen.getByText("1 sign-in, 0 keys")).toBeTruthy();
    expect(screen.getByText("Ready, Micro")).toBeTruthy();
    expect(screen.getByText("Editor connected, ue-mcp 1.4.11-beta.4")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Agents"));
    expect(onSection).toHaveBeenCalledWith("agents");
  });

  it("marks what needs attention: nothing connected", async () => {
    open("settings-models-nothing", null);
    await settled();
    expect(screen.getAllByLabelText("Nothing connected").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("No model connected").length).toBeGreaterThan(0);
  });

  it("opens a section under All settings, an old name at its new section", async () => {
    const onSection = vi.fn();
    open("settings-general", "appearance", onSection);
    await settled();
    expect(screen.getByText("General")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("All settings"));
    expect(onSection).toHaveBeenCalledWith(null);
  });
});

describe("Settings > General", () => {
  it("switches the app's theme at once and saves it on the computer", async () => {
    const { onTheme, writes } = open("settings-general", "general", vi.fn(), vi.fn());
    await settled();
    fireEvent.click(screen.getByLabelText("Editor orange"));
    await settled();
    expect(onTheme).toHaveBeenCalledWith("editor-orange");
    expect(writes()).toContainEqual(expect.objectContaining({ method: "PUT", path: "/v1/ext/studio/settings", json: { theme: "editor-orange" } }));
  });

  it("shows the updates read only: what is newer, no Update, the channel off, the note", async () => {
    const { writes } = open("settings-general-remote", "general");
    await settled(6);
    expect(screen.getByText("Update available")).toBeTruthy();
    expect(screen.getByText("Ready to install: Studio 0.1.25-beta.19.")).toBeTruthy();
    expect(screen.queryByLabelText("Update")).toBeNull();
    expect(screen.getByText("Updates run from Studio on the computer.")).toBeTruthy();
    const before = writes().length;
    fireEvent.click(screen.getByLabelText("Beta"));
    await settled();
    expect(writes().length).toBe(before);
  });

  it("names the signed-in account without Sign out, and Manage plan for the plan", async () => {
    open("settings-general-paid", "general");
    await settled();
    expect(screen.getByText("Signed in as @dev")).toBeTruthy();
    expect(screen.queryByText("Sign out")).toBeNull();
    expect(screen.getByLabelText("Manage plan")).toBeTruthy();
  });

  it("keeps the account on its own line beside the dot, with Manage plan and the login note on the line under it", async () => {
    open("settings-general-login-paid", "general");
    await settled();
    const line = screen.getByTestId("account-line");
    const actions = screen.getByTestId("account-actions");
    // The first line is the dot and the account text, nothing else: no button squeezing it into a column.
    expect(line.children).toHaveLength(2);
    expect(line.textContent).toBe("ue-mcp account Signed in as @db-lyon");
    expect(line.contains(screen.getByLabelText("Manage plan"))).toBe(false);
    // The text takes the whole line beside the dot (flex 1), not an 80% basis Yoga shrinks to share a line.
    const grow = line.children[1] as HTMLElement;
    expect(getComputedStyle(grow).flexGrow).toBe("1");
    expect(getComputedStyle(grow).flexBasis).not.toBe("80%");
    expect(actions.contains(screen.getByLabelText("Manage plan"))).toBe(true);
    expect(actions.textContent).toContain("from ue-mcp login");
    expect(line.nextElementSibling).toBe(actions);
  });

  it("an email account: the address without @, and its ways to sign in read only", async () => {
    open("settings-account-email-only", "general");
    await settled();
    expect(screen.getByTestId("account-line").textContent).toBe("ue-mcp account Signed in as dev@example.com");
    const methods = screen.getByTestId("account-methods");
    expect(methods.textContent).toContain("Ways to sign in");
    expect(methods.textContent).toContain("Emaildev@example.com");
    expect(methods.textContent).toContain("GitHubNot linked");
    for (const action of ["Link GitHub", "Remove email", "Add email", "Unlink GitHub", "Sign out"]) expect(screen.queryByText(action)).toBeNull();
  });

  it("both linked: the GitHub login and the address, read only", async () => {
    open("settings-account-both", "general");
    await settled();
    expect(screen.getByTestId("account-line").textContent).toBe("ue-mcp account Signed in as @octocat");
    const methods = screen.getByTestId("account-methods");
    expect(methods.textContent).toContain("Emailcat@example.com");
    expect(methods.textContent).toContain("GitHub@octocat");
  });

  it("a GitHub-only account says it has no email, with no Add email on the phone", async () => {
    open("settings-account-github-only", "general");
    await settled();
    expect(screen.getByTestId("account-methods").textContent).toContain("EmailNo email");
    expect(screen.queryByText("Add email")).toBeNull();
  });

  it("says a signed-out account signs in on the computer", async () => {
    open("settings-general-signing-in", "general");
    await settled();
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.getByText(REMOTE_CHANGE_NOTE)).toBeTruthy();
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });
});

describe("Settings > Remote control", () => {
  it("says it is set up on the computer, once the computer refuses its routes", async () => {
    open("settings-remote-pin-on", "remote");
    await settled();
    expect(screen.getByText("Remote control is turned on and paired from the computer running the project, not from a paired device.")).toBeTruthy();
    expect(screen.queryByLabelText("Lock Studio on paired devices")).toBeNull();
  });
});

describe("Settings > Agents", () => {
  it("shows the main agent, the worker and the project's Claude files", async () => {
    open("settings-agents", "agents");
    await settled(6);
    expect(screen.getByText("Main agent")).toBeTruthy();
    expect(screen.getByLabelText("Worker model: Same as main agent")).toBeTruthy();
    expect(screen.getByText(/Read by: Claude sign-in\./)).toBeTruthy();
    // Each name is drawn once more off screen, hidden from screen readers, to measure whether Open file fits beside it.
    expect(screen.getAllByText("level-dresser")).toHaveLength(2);
    expect(screen.getAllByText("naming-conventions")).toHaveLength(2);
  });

  it("stacks the worker's Starts choices with no space between them (.seg.seg-stack)", async () => {
    open("settings-agents", "agents");
    await settled(6);
    const choices = ["Never", "When you ask", "When work splits into independent parts"].map((n) => screen.getByRole("radio", { name: n }));
    for (const c of choices) expect(getComputedStyle(c).marginTop).toMatch(/^(0px|)$/);
  });

  it("gives each subagent and skill description the row's full width, with a small Open file at the end of the name line", async () => {
    open("settings-agents-long", "agents");
    await settled(6);
    for (const path of [".claude/agents/level-dresser.md", "~/.claude/skills/triage-all"]) {
      const button = screen.getByLabelText(`Open ${path}`);
      const nameLine = button.parentElement!;
      expect(nameLine.getAttribute("data-testid")).toBe("agent-file-name");
      expect(nameLine.lastElementChild).toBe(button);
      // Drawn 30 px tall; its hit slop makes the target 44.
      expect(getComputedStyle(button).height).toBe("30px");
      // The description is the row's own child after the name line, not a column beside the button.
      const row = nameLine.parentElement!;
      expect(row.getAttribute("data-testid")).toBe("agent-file-row");
      expect(getComputedStyle(row).flexDirection).toBe("column");
      const description = nameLine.nextElementSibling as HTMLElement;
      expect(description.contains(button)).toBe(false);
      expect(description.textContent).toMatch(/^(Places props|Drive every open PR)/);
    }
  });

  it("puts Open file on the name line only when the name, the gap and the button fit the row", () => {
    expect(openFileInline(120, 330, 72)).toBe(true);
    expect(openFileInline(248, 330, 72)).toBe(true);
    expect(openFileInline(249, 330, 72)).toBe(false);
    expect(openFileInline(330, 330, 72)).toBe(false);
    // Before the first layout: on the name line.
    expect(openFileInline(0, 0, 0)).toBe(true);
  });

  it("changes the screenshot size from the phone", async () => {
    const { writes } = open("settings-agents", "agents");
    await settled(6);
    fireEvent.click(screen.getByLabelText(/^Full 2000/));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ path: "/v1/ext/studio/settings", json: { usage: { imageSize: "full" } } }));
  });

  it("says nothing is connected and links to Models", async () => {
    const onSection = vi.fn();
    open("settings-agents-not-connected", "agents", onSection);
    await settled(6);
    fireEvent.click(screen.getByText("Connect a sign-in or API key"));
    expect(onSection).toHaveBeenCalledWith("models");
  });

  it("hides the files when the project's agent files are off", async () => {
    open("settings-agents-files-off", "agents");
    await settled(6);
    expect(screen.queryByText("Instruction files")).toBeNull();
  });
});

describe("Settings > Models & accounts", () => {
  it("draws sign-ins, keys and endpoints read only under the note, the route order still changes", async () => {
    const { writes } = open("endpoints-populated", "models");
    await settled(6);
    expect(screen.getAllByText(REMOTE_CHANGE_NOTE).length).toBeGreaterThan(0);
    for (const b of screen.getAllByLabelText("Add key")) expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText("Local Ollama").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Edit")[0].getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByLabelText("Keys first"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ json: { routeOrder: "keys-first" } }));
  });

  it("says when the endpoints cannot be read", async () => {
    open("endpoints-error", "models");
    await settled(6);
    expect(screen.getByText(/Could not read the endpoints:/)).toBeTruthy();
  });
});

describe("Settings > Approvals & review", () => {
  it("keeps the ask-first rules read only and lets the phone change review", async () => {
    const { writes } = open("settings-approvals", "approvals");
    await settled(6);
    expect(screen.getAllByLabelText("Ask")[0].getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByLabelText("Review each turn"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ json: { reviewTurns: false } }));
  });

  it("says what each rule does as the code does it", async () => {
    open("settings-approvals", "approvals");
    await settled(6);
    expect(screen.getByText("What needs your approval in this project. Applies to every agent.")).toBeTruthy();
    expect(screen.getByText("Stop, start, restart or rebuild the editor")).toBeTruthy();
    expect(screen.getByText("An open editor dialog blocks editor calls until it is answered.")).toBeTruthy();
    expect(screen.getAllByText(/Editor calls are refused until you answer it in the editor\./).length).toBeGreaterThan(0);
    expect(screen.getByText(/With no Cancel or Keep button, it keeps waiting\./)).toBeTruthy();
  });
});

describe("Settings > Project", () => {
  it("shows a bridge needing a rebuild, and Rebuild asks first", async () => {
    open("settings-project-rebuild", "project");
    await settled(6);
    expect(screen.getByText("The bridge plugin needs a rebuild.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Rebuild"));
    expect(screen.getByLabelText("Close the editor and rebuild")).toBeTruthy();
    expect(screen.getByText(/builds the project's C\+\+ including the bridge plugin.*Unsaved changes get the editor's save prompt before it closes\./)).toBeTruthy();
  });

  it("shows ue-mcp.yml read only, highlighted, under Advanced", async () => {
    open("settings-project-yaml", "project");
    await settled(6);
    fireEvent.click(screen.getByText("Advanced: ue-mcp.yml"));
    await settled();
    expect(screen.getByText("ue-mcp.yml")).toBeTruthy();
    expect(screen.getByLabelText("Save").getAttribute("aria-disabled")).toBe("true");
  });

  it("says an environment override wins", async () => {
    open("settings-project-attention", "project");
    await settled(6);
    expect(screen.getByText("UE_MCP_CONTEXT_STRATEGY=full")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });
});

describe("Settings with older and empty answers", () => {
  it.each(["general", "agents", "models", "approvals", "project", "diagnostics"])("%s renders from an older agent's answers and from empty ones", async (section) => {
    for (const scenario of [`settings-old-${section}`, `settings-empty-${section}`]) {
      const v = open(scenario, section);
      await settled(6);
      expect(v.container.textContent?.length).toBeGreaterThan(20);
      v.unmount();
    }
  });
});
