// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  settings: vi.fn(async () => ({ route: null })),
  feedbackEnvironment: vi.fn(async () => ({ body: "" })),
  crash: { agents: true },
}));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/AgentsSection", () => ({
  AgentsSection: () => {
    if (m.crash.agents) throw new TypeError("Cannot read properties of undefined (reading 'imageSize')");
    return <div>AgentsSection body</div>;
  },
}));
vi.mock("./settings/ModelsSection", () => ({ ModelsSection: () => <div>ModelsSection body</div> }));
vi.mock("./settings/ApprovalsSection", () => ({ ApprovalsSection: () => <div>ApprovalsSection body</div> }));
vi.mock("./settings/ProjectSection", () => ({ ProjectSection: () => <div>ProjectSection body</div> }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./Status", () => ({ StatusView: () => <div>Status</div> }));
vi.mock("./Logs", () => ({ LogsView: () => <div>Logs</div> }));
import { ErrorBoundary, crashReport } from "./ErrorBoundary";
import { SettingsHub, type SettingsSection } from "./SettingsHub";

afterEach(() => {
  cleanup();
  m.crash.agents = true;
  vi.restoreAllMocks();
});

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

function Boom({ when }: { when: () => boolean }) {
  if (when()) throw new Error("boom in render");
  return <p>Fine now</p>;
}

describe("ErrorBoundary", () => {
  it("shows a plain message, the error text, Reload and Report in place of the part that threw", () => {
    quiet();
    render(
      <div>
        <p>Outside</p>
        <ErrorBoundary what="This section"><Boom when={() => true} /></ErrorBoundary>
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toContain("This section could not be shown.");
    expect(screen.getByText("boom in render")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report this problem" })).toBeTruthy();
    expect(screen.getByText("Outside")).toBeTruthy();
  });

  it("Reload mounts the part again", () => {
    quiet();
    let broken = true;
    render(<ErrorBoundary what="This section"><Boom when={() => broken} /></ErrorBoundary>);
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("Fine now")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Report opens feedback filled in with where it broke and the stack", async () => {
    quiet();
    render(<ErrorBoundary what="This section" where="Settings > Agents"><Boom when={() => true} /></ErrorBoundary>);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Report this problem" })));
    const dialog = screen.getByRole("dialog", { name: "Send feedback" });
    expect((dialog.querySelector("input[aria-label=Title]") as HTMLInputElement).value).toBe("Settings > Agents could not be shown: boom in render");
    const description = (dialog.querySelector("textarea") as HTMLTextAreaElement).value;
    expect(description).toContain("Error: boom in render");
    expect(description).toContain("at Boom");
  });

  it("keeps a report inside what the feedback route takes", () => {
    const e = new Error("x");
    e.stack = "y".repeat(60_000);
    const r = crashReport("Settings > Models", e, null);
    expect(r.description.length).toBeLessThan(50_000);
    expect(r.description).toContain("(shortened)");
  });
});

describe("Settings with a section that throws", () => {
  const open = async (section: SettingsSection, onSection = vi.fn()) => {
    let rerender!: (ui: ReactElement) => void;
    await act(async () => {
      rerender = render(<SettingsHub daemon={{} as never} section={section} onSection={onSection} onTheme={vi.fn()} />).rerender;
    });
    return (s: SettingsSection) => act(async () => rerender(<SettingsHub daemon={{} as never} section={s} onSection={onSection} onTheme={vi.fn()} />));
  };

  it("shows the crash in the section, and the rail still opens the others", async () => {
    quiet();
    const onSection = vi.fn();
    const go = await open("agents", onSection);
    expect(screen.getByRole("alert").textContent).toContain("This section could not be shown.");
    expect(screen.getByText(/reading 'imageSize'/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Models & accounts/ }));
    expect(onSection).toHaveBeenLastCalledWith("models");
    await go("models");
    expect(screen.getByText("ModelsSection body")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opening the crashed section again tries it again", async () => {
    quiet();
    const go = await open("agents");
    await go("general");
    m.crash.agents = false;
    await go("agents");
    expect(screen.getByText("AgentsSection body")).toBeTruthy();
  });
});
