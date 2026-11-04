/**
 * Settings, Plugins, Diagnostics, Feedback and update screens under test,
 * against a web visual QA scenario's daemon (the same answers the parity
 * shots use), as the phone reaches it: through the computer's paired-client
 * rules, with the shell's daemon state when a screen takes it. Every
 * request is recorded, so a test can say what was sent.
 */
import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { studioApi, type Transport } from "@ue-mcp-studio/client-core";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS, scenarioTransport } from "../visual-qa/harness";
import { ProjectContext, useProjectNav, type ProjectNav } from "../src/nav";
import { ThemeProvider } from "../src/ui";
import { fakeProject, settle } from "./helpers";
import { useDaemon, type DaemonState } from "../src/state";

/** The shell's daemon state for the open project, as the screens get it. */
function WithDaemon({ render }: { render: (daemon: DaemonState) => ReactNode }) {
  const daemon = useDaemon(useProjectNav().project);
  return <>{render(daemon)}</>;
}

export interface Sent {
  method: string;
  path: string;
  json?: unknown;
  status: number;
}

export function renderArea(scenario: string, ui: ReactNode | ((daemon: DaemonState) => ReactNode), theme: StudioTheme = "ue-mcp") {
  const base = scenarioTransport(SCENARIOS[scenario], theme);
  const sent: Sent[] = [];
  const transport: Transport = async (method, path, options) => {
    const r = await base(method, path, options);
    sent.push({ method, path, json: options?.json, status: r.status });
    return r;
  };
  const { project, emit } = fakeProject(transport);
  const nav: ProjectNav = { project, api: studioApi(project.transport), push: vi.fn(), pop: vi.fn() };
  const onTheme = vi.fn();
  const view = render(
    <ThemeProvider name={theme} onChange={onTheme}>
      <ProjectContext.Provider value={nav}>{typeof ui === "function" ? <WithDaemon render={ui} /> : ui}</ProjectContext.Provider>
    </ThemeProvider>,
  );
  return { ...view, sent, emit, onTheme, writes: () => sent.filter((s) => s.method !== "GET") };
}

/** Lets every pending answer arrive. */
export async function settled(times = 4) {
  for (let i = 0; i < times; i++) await settle();
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
}
