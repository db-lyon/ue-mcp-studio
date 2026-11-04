// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// A locked computer holds Studio's first requests until the PIN is in, so the
// version check never answers and Studio never loads: the lock must show anyway.
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({}, { get: () => pending }), ApiError: class extends Error {} };
});
vi.mock("./state", () => ({ useDaemon: () => ({ events: [], health: null, streaming: false, error: null, refresh: () => {} }) }));
vi.mock("./views/Refused", () => ({ useRefusal: () => undefined, RefusedScreen: () => null }));
vi.mock("./views/remote/RemoteLock", () => ({ RemoteLock: () => <div role="dialog" aria-label="Studio is locked" /> }));
import { App } from "./App";

afterEach(cleanup);

describe("a paired browser on a locked computer", () => {
  it("shows the lock screen while Studio's first requests wait for the PIN", () => {
    render(<App />);
    expect(screen.getByRole("dialog", { name: "Studio is locked" })).toBeTruthy();
  });
});
