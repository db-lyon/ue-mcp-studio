// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; url: string }> = [];

function serve(agentVersion: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url });
    const body = url.endsWith("/about") ? { agentVersion, daemonVersion: "1.4.3", uiVersion: agentVersion, projectDir: "P" } : { opened: "window", pid: 1 };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
}

function host(windowVersion: string | undefined, studioWindow = true) {
  window.ue = { studioWindow, studio: { restarteditor: async () => false, enableplugin: async () => false, openprojectfolder: async () => false, getstatus: async () => JSON.stringify({ windowVersion }) } };
}

async function run() {
  vi.resetModules();
  return (await import("./window-version")).replaceStaleWindow();
}

const opened = () => calls.filter((c) => c.method === "POST" && c.url === "/v1/ext/studio/window").length;

beforeEach(() => {
  calls.length = 0;
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ue;
});

describe("an older window exe after an update", () => {
  it("is replaced by opening the window again", async () => {
    host("0.1.4");
    serve("0.1.5");
    expect(await run()).toBe(true);
    expect(opened()).toBe(1);
  });

  it("is left alone when it matches Studio", async () => {
    host("0.1.5");
    serve("0.1.5");
    expect(await run()).toBe(false);
    expect(opened()).toBe(0);
  });

  it("is tried once per page, so a launch that fails does not repeat", async () => {
    host("0.1.4");
    serve("0.1.5");
    await run();
    expect(await run()).toBe(false);
    expect(opened()).toBe(1);
  });

  it("is not asked for outside Studio's own window", async () => {
    host("0.1.4", false);
    serve("0.1.5");
    expect(await run()).toBe(false);
    expect(opened()).toBe(0);
  });
});
