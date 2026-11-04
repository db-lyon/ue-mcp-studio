/**
 * A project for screen tests: a fake Studio API (every route a vi.fn the test
 * can answer), an event emitter standing in for the daemon's stream, and the
 * navigation stack the screens push onto.
 */
import type { ReactNode } from "react";
import { vi } from "vitest";
import { act, render } from "@testing-library/react";
import { createLock, type StreamEvent, type StudioApi, type Transport } from "@ue-mcp-studio/client-core";
import type { SessionDetail } from "@ue-mcp-studio/shared";
import type { Project } from "../src/connection";
import { ProjectContext, type ProjectNav, type Route } from "../src/nav";

export type FakeApi = { [K in keyof StudioApi]: ReturnType<typeof vi.fn> };

const NAMES: Array<keyof StudioApi> = [
  "health", "sessions", "newSession", "sessionSync", "callResult", "send", "queue", "removeQueued", "sendQueued", "stop", "saveDraft", "approve", "dialogs", "answerDialog",
  "settings", "saveSettings", "models", "reviewStatus", "setSessionReview", "reviewDiff", "reviewKeep", "reviewRevert", "reviewUndo", "timelineRestore", "timelineUndo", "vcs", "vcsChanges", "vcsDiff",
  "editQueued", "updateSession", "deleteSession", "markSeen", "dismissAgents", "editMessage", "uploadAttachment", "stopSubagent", "compact", "flow", "action", "playtest",
  "flows", "actions", "searchMentions", "forms", "answerForm", "bytes", "reviewNativeDiff",
];

export function fakeApi(): FakeApi {
  const api = {} as FakeApi;
  for (const n of NAMES) api[n] = vi.fn(() => new Promise(() => undefined));
  api.reviewImageUrl = vi.fn((name: string) => `/v1/ext/studio/review/images/${name}`);
  api.reviewThumbnailUrl = vi.fn((id: string) => `/v1/ext/studio/review/thumbnails/${id}`);
  api.saveDraft.mockResolvedValue({});
  api.dialogs.mockResolvedValue({ now: Date.now(), dialogs: [] });
  return api;
}

export function fakeProject(transport?: Transport) {
  const listeners = new Set<(e: StreamEvent) => void>();
  const t: Transport = transport ?? (async () => ({ status: 200, headers: {}, body: null }));
  const project: Project = {
    device: { id: "dev1", name: "Lyra", online: true, computerKey: "k", lastSeen: "2026-11-04T12:00:00Z" },
    transport: t,
    lock: createLock(t),
    live: "live",
    dropCause: null,
    onEvent: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  let id = 0;
  const emit = (type: string, data: Record<string, unknown>) =>
    act(() => {
      for (const l of listeners) l({ id: ++id, type, at: new Date().toISOString(), data });
    });
  return { project, emit };
}

export function renderInProject(ui: ReactNode, api = fakeApi(), project = fakeProject().project) {
  const pushed: Route[] = [];
  const nav: ProjectNav = { project, api: api as unknown as StudioApi, push: (r) => pushed.push(r), pop: vi.fn() };
  const view = render(<ProjectContext.Provider value={nav}>{ui}</ProjectContext.Provider>);
  return { ...view, api, nav, pushed };
}

export function session(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    title: "Door that opens",
    status: "idle",
    createdAt: "2026-11-04T12:00:00Z",
    updatedAt: "2026-11-04T12:05:00Z",
    waitingCause: null,
    archived: false,
    agents: { total: 0, running: 0 },
    awaiting: 0,
    transcript: [],
    touched: [],
    draft: "",
    seen: [],
    dismissed: [],
    queue: [],
    error: null,
    approvals: [],
    ...over,
  } as SessionDetail;
}

/** Let pending promises settle inside act. */
export const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
