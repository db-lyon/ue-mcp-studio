/** The newer-Studio notice and its two actions (ue-mcp#1619). */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import { registerVersionNotice, versionNotice } from "../src/version-notice.js";

describe("versionNotice", () => {
  const v = (loaded: string, installed: string[]) => ({ loaded, recorded: loaded, installed });

  it("names the newest installed version when it is newer than this project's", () => {
    expect(versionNotice(v("0.1.23", ["0.1.23", "0.1.24-beta.2", "0.1.24"]), null)).toEqual({ installed: "0.1.24", current: "0.1.23" });
  });

  it("is null on the newest, on a daemon without versions, and after Keep until something newer arrives", () => {
    expect(versionNotice(v("0.1.24", ["0.1.23", "0.1.24"]), null)).toBeNull();
    expect(versionNotice(null, null)).toBeNull();
    expect(versionNotice(v("0.1.23", ["0.1.23", "0.1.24"]), "0.1.24")).toBeNull();
    expect(versionNotice(v("0.1.23", ["0.1.23", "0.1.24", "0.1.25"]), "0.1.24")).toEqual({ installed: "0.1.25", current: "0.1.23" });
  });
});

describe("the version notice routes", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function host(installed: string[]) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-vn-"));
    const routes = new Map<string, ExtensionHandler>();
    const api = {
      dataDir: dir,
      versions: () => ({ loaded: "0.1.23", recorded: "0.1.23", installed }),
      route: (method: string, p: string, h: ExtensionHandler) => void routes.set(`${method} ${p}`, h),
    } as unknown as DaemonExtensionApi;
    const updates: string[] = [];
    registerVersionNotice(api, async (version) => {
      updates.push(version);
      return { status: 202, body: { ok: true, started: true } };
    });
    const call = async (key: string, body?: unknown) => (await routes.get(key)!({ method: "", path: "", params: {}, query: {}, headers: {}, body }))!;
    return { call, updates };
  }

  it("Update runs the Studio step on the installed version, and only an installed one", async () => {
    const { call, updates } = host(["0.1.23", "0.1.25"]);
    expect((await call("GET /version-notice")).body).toEqual({ notice: { installed: "0.1.25", current: "0.1.23" } });
    expect(await call("POST /version-notice/update", { version: "0.1.25" })).toEqual({ status: 202, body: { ok: true, started: true } });
    expect(updates).toEqual(["0.1.25"]);
    expect((await call("POST /version-notice/update", { version: "0.1.99" })).status).toBe(404);
    expect((await call("POST /version-notice/update", { version: "../x" })).status).toBe(400);
    expect(updates).toEqual(["0.1.25"]);
  });

  it("Keep hides the notice for this project until a newer version is installed", async () => {
    const { call, updates } = host(["0.1.23", "0.1.25"]);
    expect((await call("POST /version-notice/keep", { version: "0.1.25" })).body).toEqual({ notice: null });
    expect((await call("GET /version-notice")).body).toEqual({ notice: null });
    expect(updates).toEqual([]);
  });
});
