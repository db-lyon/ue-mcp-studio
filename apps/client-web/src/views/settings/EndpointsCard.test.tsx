// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CustomEndpoint, ModelCatalog } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  endpoints: vi.fn(),
  addEndpoint: vi.fn(),
  saveEndpoint: vi.fn(),
  removeEndpoint: vi.fn(),
  listEndpointModels: vi.fn(),
  settings: vi.fn(),
  models: vi.fn(),
  saveSettings: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m }));
import { EndpointsCard } from "./EndpointsCard";
import { ModelsSection } from "./ModelsSection";
import { runsVia, viaName } from "../ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const box: CustomEndpoint = {
  id: "box",
  name: "Local box",
  baseUrl: "http://localhost:11434/v1",
  hasKey: false,
  models: [{ id: "llama" }, { id: "mine", typed: true }],
  listedAt: "2026-10-26T00:00:00Z",
  listError: null,
};

describe("the custom endpoints card", () => {
  it("says there are none, and adds one with a typed model", async () => {
    m.endpoints.mockResolvedValue({ endpoints: [] });
    m.addEndpoint.mockResolvedValue(box);
    const onChange = vi.fn();
    await act(async () => render(<EndpointsCard onChange={onChange} />));
    expect(screen.getByText("No endpoints.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local box" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://localhost:11434/v1" } });
    fireEvent.change(screen.getByLabelText("Model id"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const form = screen.getByRole("group", { name: "Add an endpoint" });
    await act(async () => fireEvent.click(form.querySelector("button.primary")!));
    expect(m.addEndpoint).toHaveBeenCalledWith({
      name: "Local box",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "qwen", typed: true }],
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("lists an endpoint's models, and shows why its list could not be read", async () => {
    m.endpoints.mockResolvedValue({ endpoints: [{ ...box, listError: "its /models answered 401" }] });
    await act(async () => render(<EndpointsCard onChange={() => {}} />));
    expect(screen.getByText("Local box")).toBeTruthy();
    expect(screen.getByText(/Could not read its models: its \/models answered 401/)).toBeTruthy();
    expect(screen.getByText("mine")).toBeTruthy();
  });

  it("shows what the agent refused", async () => {
    m.endpoints.mockResolvedValue({ endpoints: [box] });
    m.saveEndpoint.mockRejectedValue(new Error("baseUrl must be an http or https URL"));
    await act(async () => render(<EndpointsCard onChange={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "box" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("alert").textContent).toMatch(/http or https/);
  });

  it("reads an endpoint's models again", async () => {
    m.endpoints.mockResolvedValue({ endpoints: [box] });
    m.listEndpointModels.mockResolvedValue(box);
    await act(async () => render(<EndpointsCard onChange={() => {}} />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Read models" })));
    expect(m.listEndpointModels).toHaveBeenCalledWith("box");
  });
});

const catalog = (order: "signins-first" | "keys-first"): ModelCatalog => ({
  signedIn: { claude: true, chatgpt: false, studio: false },
  routeOrder: order,
  providers: [
    { id: "anthropic", name: "Anthropic", connected: true, source: "live", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", signIns: ["claude"] }] },
    { id: "endpoint:box", name: "Local box", connected: true, source: "live", endpoint: { id: "box" }, models: [{ id: "llama", name: "llama", signIns: [] }] },
  ],
});

describe("routes in the picker", () => {
  it("runs a model on a sign-in or a key by the route order, and an endpoint's on the endpoint", () => {
    const c = catalog("signins-first");
    expect(runsVia(c, c.providers[0], c.providers[0].models[0])).toBe("claude");
    const k = catalog("keys-first");
    expect(runsVia(k, k.providers[0], k.providers[0].models[0])).toBe("key");
    expect(runsVia(c, c.providers[1], c.providers[1].models[0])).toBe("endpoint");
    expect(viaName("endpoint", "Local box")).toBe("Local box");
    expect(viaName("key", "Anthropic")).toBe("Anthropic key");
  });
});

describe("Models & accounts", () => {
  it("saves the route order and lists an endpoint's models on the endpoint", async () => {
    const settings = { provider: "anthropic", model: "claude-opus-5-5", route: "claude", routeOrder: "signins-first", gatewayUrl: "", connected: { claude: true, chatgpt: false, studio: false, anthropic: true, openai: false, google: false }, account: null, endpoints: 1 };
    m.settings.mockResolvedValue(settings);
    m.models.mockResolvedValue(catalog("signins-first"));
    m.endpoints.mockResolvedValue({ endpoints: [box] });
    m.signIn.mockResolvedValue({ state: "done", login: "x" });
    m.saveSettings.mockResolvedValue({ ...settings, routeOrder: "keys-first" });
    await act(async () => render(<ModelsSection />));
    expect(screen.getAllByText("Local box").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Custom endpoint")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Keys first" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ routeOrder: "keys-first" });
  });
});
