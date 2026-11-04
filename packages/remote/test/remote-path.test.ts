/** remotePath: what a paired browser may reach on the computer, and what it never may. */
import { describe, expect, it } from "vitest";
import { remoteBodyAllowed, remotePath } from "../src/index.js";

describe("remotePath", () => {
  it("allows Studio's UI and API and refuses the rest", () => {
    expect(remotePath("GET", "/ui/")).toBe("/ui/");
    expect(remotePath("GET", "/v1/update?channel=beta")).toBe("/v1/update?channel=beta");
    expect(remotePath("POST", "/v1/ext/studio/sessions/1/messages")).toBe("/v1/ext/studio/sessions/1/messages");
    expect(remotePath("POST", "/v1/editor/restart")).toBe("/v1/editor/restart");
    for (const [m, p] of [
      ["POST", "/v1/mcp"],
      ["POST", "/v1/shutdown"],
      ["POST", "/v1/handoff"],
      ["POST", "/v1/update/apply"],
      ["POST", "/v1/plugins/install"],
      ["POST", "/v1/ext/studio/window"],
      ["GET", "/v1/ext/remote/status"],
      ["POST", "/v1/health"],
      ["GET", "/ui/../v1/mcp"],
      ["GET", "/ui/%2e%2e/v1/mcp"],
      ["GET", "/ui/%2E%2E%2Fv1%2Fmcp"],
      ["GET", "/ui\..\v1"],
      ["GET", "//evil.example/ui/"],
      ["GET", "http://evil.example/ui/"],
      ["GET", "/v1/ext/studio/../../mcp"],
    ]) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
  });

  it("refuses every remote-control route, however the path is spelled", () => {
    for (const [m, p] of [
      ["GET", "/v1/ext/studio/remote"],
      ["GET", "/v1/ext/studio/remote/"],
      ["GET", "/v1/ext/studio/remote/status"],
      ["PUT", "/v1/ext/studio/remote/config"],
      ["POST", "/v1/ext/studio/remote/pair"],
      ["GET", "/v1/ext/studio/remote/phones"],
      ["DELETE", "/v1/ext/studio/remote/phones/abc"],
      ["delete", "/v1/ext/studio/remote/phones/abc"],
      ["POST", "/v1/ext/studio/remote/pair?x=1"],
      ["POST", "/v1/ext/studio/remote/pair/"],
      ["POST", "/v1/ext/studio/Remote/pair"],
      ["POST", "/v1/ext/studio/REMOTE/pair"],
      ["POST", "/v1/ext/studio/./remote/pair"],
      ["POST", "/v1/ext/studio/sessions/../remote/pair"],
      ["POST", "/v1/ext/studio/x/../remote/config"],
      ["POST", "/v1/ext/studio//remote/pair"],
      ["POST", "/v1/ext/studio/remote%2fpair"],
      ["POST", "/v1/ext/studio/%2e%2e/studio/remote/pair"],
      ["POST", "/v1/ext/studio/remote#/pair"],
    ]) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
  });

  it("lets a paired browser read the plugins and the catalog, and nothing that changes them", () => {
    expect(remotePath("GET", "/v1/plugins")).toBe("/v1/plugins");
    expect(remotePath("GET", "/v1/plugins/catalog")).toBe("/v1/plugins/catalog");
    for (const [m, p] of [
      ["POST", "/v1/plugins/install"],
      ["POST", "/v1/plugins/update"],
      ["POST", "/v1/plugins/uninstall"],
      ["POST", "/v1/plugins"],
      ["PUT", "/v1/plugins"],
      ["DELETE", "/v1/plugins"],
      ["POST", "/v1/plugins/catalog"],
      ["GET", "/v1/plugins/install"],
      ["GET", "/v1/plugins/update"],
      ["GET", "/v1/plugins/uninstall"],
      ["GET", "/v1/plugins/catalog/../install"],
      ["GET", "/v1/plugins/%2e%2e/shutdown"],
      ["GET", "/v1/plugins/"],
      ["GET", "/v1/plugins/catalog/x"],
    ]) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
  });

  it("lets a paired browser read update status and refuses every update, install and channel change", () => {
    expect(remotePath("GET", "/v1/ext/studio/updates")).toBe("/v1/ext/studio/updates");
    expect(remotePath("GET", "/v1/ext/studio/updates/run")).toBe("/v1/ext/studio/updates/run");
    expect(remotePath("GET", "/v1/update")).toBe("/v1/update");
    expect(remotePath("GET", "/v1/install")).toBe("/v1/install");
    expect(remotePath("POST", "/v1/ext/studio/version-notice/keep")).toBe("/v1/ext/studio/version-notice/keep");
    expect(remotePath("GET", "/v1/ext/studio/refusal")).toBe("/v1/ext/studio/refusal");
    const steps = ["studio", "plugin", "ueMcp", "restart", "deferred/now", "channel", "anything"];
    const refused: Array<[string, string]> = [];
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "post"]) for (const s of steps) refused.push([m, `/v1/ext/studio/updates/${s}`]);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "put"]) {
      refused.push([m, "/v1/ext/studio/updates"], [m, "/v1/ext/studio/updates/"], [m, "/v1/ext/studio/updates/run"], [m, "/v1/ext/studio/updates/run/"]);
    }
    refused.push(
      ["POST", "/v1/ext/studio/Updates/studio"],
      ["POST", "/v1/ext/studio/UPDATES/plugin"],
      ["POST", "/v1/ext/studio/updates/studio/"],
      ["POST", "/v1/ext/studio/updates/studio?now=1"],
      ["POST", "/v1/ext/studio/updates/run/../studio"],
      ["POST", "/v1/ext/studio/x/../updates/ueMcp"],
      ["POST", "/v1/ext/studio/./updates/restart"],
      ["POST", "/v1/ext/studio//updates/studio"],
      ["POST", "/v1/ext/studio/updates%2fstudio"],
      ["POST", "/v1/ext/studio/updates/%2e%2e/updates/studio"],
      ["PUT", "/v1/ext/studio/updates/channel?x=1"],
      ["POST", "/v1/ext/studio/updates/deferred/now/"],
      ["POST", "/v1/ext/studio/refusal/update"],
      ["POST", "/v1/ext/studio/Refusal/Update/"],
      ["POST", "/v1/ext/studio/version-notice/update"],
      ["POST", "/v1/ext/studio/Version-Notice/update/"],
      ["POST", "/v1/update/apply"],
      ["POST", "/v1/update"],
      ["POST", "/v1/install"],
    );
    for (const [m, p] of refused) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
  });

  it("lets a paired browser read endpoints, sign-ins and ue-mcp.yml, and change none of them", () => {
    for (const p of ["/v1/ext/studio/endpoints", "/v1/ext/studio/signin/claude", "/v1/ext/studio/config", "/v1/ext/studio/context-strategy"]) {
      expect(remotePath("GET", p), p).toBe(p);
    }
    const refused: Array<[string, string]> = [];
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "put"]) {
      for (const p of [
        "/v1/ext/studio/endpoints",
        "/v1/ext/studio/endpoints/",
        "/v1/ext/studio/endpoints/abc",
        "/v1/ext/studio/endpoints/abc/models",
        "/v1/ext/studio/signin/claude",
        "/v1/ext/studio/signin/chatgpt",
        "/v1/ext/studio/signin/studio",
        "/v1/ext/studio/config",
        "/v1/ext/studio/config/",
        "/v1/ext/studio/context-strategy",
      ]) refused.push([m, p]);
    }
    refused.push(
      ["PUT", "/v1/ext/studio/Config"],
      ["PUT", "/v1/ext/studio/CONFIG/"],
      ["POST", "/v1/ext/studio/Endpoints"],
      ["POST", "/v1/ext/studio/sessions/../endpoints"],
      ["PUT", "/v1/ext/studio/x/../config"],
      ["PUT", "/v1/ext/studio/./config?x=1"],
      ["POST", "/v1/ext/studio/SignIn/claude"],
      ["POST", "/v1/ext/studio/signin%2fclaude"],
      ["PUT", "/v1/ext/studio//config"],
    );
    for (const [m, p] of refused) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
  });

  it("refuses the settings fields that move prompts, keys or approvals, and keeps everyday ones", () => {
    const body = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
    const settings = "/v1/ext/studio/settings";
    for (const ok of [{ model: "claude-opus-5-5" }, { effort: "high" }, { theme: "editor" }, { composerHeight: 200 }, { provider: "anthropic", routeOrder: ["claude", "key"] }, { reviewTurns: true }, {}]) {
      expect(remoteBodyAllowed("PUT", settings, body(ok)), JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      { gatewayUrl: "https://evil.example" },
      { keys: { anthropic: "sk-x" } },
      { signOut: "studio" },
      { approvals: { shell: "anywhere" } },
      { askBeforeChanges: false },
      { dialogPolicy: "auto" },
      { model: "x", gatewayUrl: "https://evil.example" },
    ]) expect(remoteBodyAllowed("PUT", settings, body(bad)), JSON.stringify(bad)).toBe(false);
    for (const p of ["/v1/ext/studio/Settings", "/v1/ext/studio/settings/"]) expect(remoteBodyAllowed("put", p, body({ keys: {} })), p).toBe(false);
    for (const junk of ["not json", "[]", "null", '"x"', "1"]) expect(remoteBodyAllowed("PUT", settings, body(junk)), junk).toBe(false);
    expect(remoteBodyAllowed("PUT", settings, undefined)).toBe(true);
    expect(remoteBodyAllowed("POST", "/v1/ext/studio/sessions/1/messages", body({ keys: 1 }))).toBe(true);
    expect(remoteBodyAllowed("GET", settings, undefined)).toBe(true);
  });

  it("still allows Studio routes that only start with the same letters", () => {
    expect(remotePath("GET", "/v1/ext/studio/remotes")).toBe("/v1/ext/studio/remotes");
    expect(remotePath("GET", "/v1/ext/studio/sessions/remote")).toBe("/v1/ext/studio/sessions/remote");
    expect(remotePath("GET", "/v1/ext/studio/updatesx")).toBe("/v1/ext/studio/updatesx");
  });
});
