import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { StudioApi } from "@ue-mcp-studio/client-core";
import type { ModelCatalog, StudioSettings, TranscriptEntry } from "@ue-mcp-studio/shared";
import { SessionScreen } from "../src/screens/Session";
import { ModelPicker } from "../src/ModelPicker";
import { fakeApi, fakeProject, renderInProject, session, settle } from "./helpers";
import { render } from "@testing-library/react";

const at = "2026-11-04T12:00:00Z";
const settings = { provider: "anthropic", model: "claude-x", effort: "high", connected: { claude: true } } as unknown as StudioSettings;
const catalog: ModelCatalog = {
  signedIn: { claude: true, chatgpt: false, studio: false } as ModelCatalog["signedIn"],
  providers: [
    { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-x", name: "Claude X", signIns: ["claude"] }] },
    { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt-y", name: "GPT Y", signIns: ["chatgpt"] }] },
  ] as ModelCatalog["providers"],
};

function setup(over: Parameters<typeof session>[0] = {}) {
  const api = fakeApi();
  api.sessionSync.mockResolvedValue(session(over));
  api.settings.mockResolvedValue(settings);
  api.models.mockResolvedValue(catalog);
  const { project, emit } = fakeProject();
  const view = renderInProject(<SessionScreen id="s1" />, api, project);
  return { ...view, api, emit };
}

describe("SessionScreen", () => {
  it("draws the thread: the owner's message, the reply as markdown, and each tool call", async () => {
    const transcript: TranscriptEntry[] = [
      { kind: "user", text: "Make the door open", at },
      { kind: "tool", call: { id: "c1", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create" }, outcome: "done", startedAt: at, endedAt: at } },
      { kind: "assistant", text: "Done. The **door** opens.", at },
    ];
    setup({ transcript });
    await settle();
    expect(screen.getByText("Door that opens")).toBeTruthy();
    expect(screen.getByText("Make the door open")).toBeTruthy();
    expect(screen.getByText("blueprint.create")).toBeTruthy();
    expect(screen.getByText("door")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("sends a message when idle", async () => {
    const { api } = setup();
    api.send.mockResolvedValue({ sessionId: "s1" });
    await settle();
    fireEvent.change(screen.getByPlaceholderText("Ask for something in the editor, or drop files here"), { target: { value: "Add a lamp" } });
    fireEvent.click(screen.getByText("Send"));
    expect(api.send).toHaveBeenCalledWith("s1", "Add a lamp", false);
    await settle();
  });

  it("queues, sends now or stops while a turn runs", async () => {
    const { api } = setup({ status: "running" });
    api.queue.mockResolvedValue({});
    api.stop.mockResolvedValue({});
    await settle();
    expect(screen.getByText("Working")).toBeTruthy();
    const box = screen.getByPlaceholderText("The agent is working. Write the next message to queue it.");
    fireEvent.change(box, { target: { value: "Then the window" } });
    fireEvent.click(screen.getByText("Queue"));
    expect(api.queue).toHaveBeenCalledWith("s1", "Then the window");
    await settle();
    fireEvent.click(screen.getByText("Stop"));
    expect(api.stop).toHaveBeenCalledWith("s1");
    await settle();
  });

  it("lists queued messages with Send and Remove", async () => {
    const { api } = setup({ queue: [{ id: "q1", text: "Paint it red", attachments: [], at }] });
    api.removeQueued.mockResolvedValue({});
    await settle();
    expect(screen.getByText("Paint it red")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove"));
    expect(api.removeQueued).toHaveBeenCalledWith("s1", "q1");
    await settle();
  });

  it("shows a call waiting for approval as a card", async () => {
    setup({ status: "waiting", approvals: [{ id: "a1", toolUseId: "t1", tool: "shell", parent: null, command: "rm -rf Saved", at }] });
    await settle();
    expect(screen.getByText("$ rm -rf Saved")).toBeTruthy();
    expect(screen.getByText("Allow")).toBeTruthy();
  });

  it("streams the turn's text and reloads when the entry lands", async () => {
    const { api, emit } = setup({ status: "running" });
    await settle();
    emit("studio.turn.delta", { sessionId: "s1", text: "Working on " });
    emit("studio.turn.delta", { sessionId: "s1", text: "it" });
    expect(screen.getByText("Working on it")).toBeTruthy();
    const calls = api.sessionSync.mock.calls.length;
    emit("studio.transcript.added", { sessionId: "s1" });
    await settle();
    expect(api.sessionSync.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.queryByText("Working on it")).toBeNull();
  });

  it("opens a turn's review and the checkpoints", async () => {
    const review = { id: "r1", turn: 0, before: "a", after: "b", at, items: [{ path: "x.uasset", status: "modified" as const, kind: "package" as const, group: "asset" as const, state: "pending" as const }] };
    const { pushed } = setup({ transcript: [{ kind: "review", review }] });
    await settle();
    expect(screen.getByText("1 change, 1 to decide")).toBeTruthy();
    fireEvent.click(screen.getByText("Review"));
    fireEvent.click(screen.getByText("Checkpoints"));
    expect(pushed).toEqual([{ name: "review", sessionId: "s1", review }, { name: "checkpoints", sessionId: "s1" }]);
  });
});

describe("ModelPicker", () => {
  it("names the model and effort, picks a runnable model, and greys out the rest", async () => {
    const api = fakeApi();
    api.models.mockResolvedValue(catalog);
    const saves: unknown[] = [];
    render(<ModelPicker api={api as unknown as StudioApi} settings={settings} onSave={async (u) => void saves.push(u)} />);
    await settle();
    fireEvent.click(screen.getByText(/Claude X/));
    expect(screen.getByText("Connect on your computer")).toBeTruthy();
    fireEvent.click(screen.getByText("GPT Y"));
    expect(saves).toEqual([]);
    fireEvent.click(screen.getByText("Max"));
    await settle();
    expect(saves).toEqual([{ effort: "max" }]);
  });
});
