/** remotePath: what a paired browser may reach on the computer, and what it never may. */
import { describe, expect, it } from "vitest";
import { remoteBodyAllowed, remotePath } from "../src/index.js";

describe("remotePath", () => {
  it("allows Studio's UI and API and refuses the rest", () => {
    expect(remotePath("GET", "/ui/")).toBe("/ui/");
    expect(remotePath("GET", "/v1/update?channel=beta")).toBe("/v1/update?channel=beta");
    expect(remotePath("POST", "/v1/ext/studio/sessions/1/messages")).toBe("/v1/ext/studio/sessions/1/messages");
    // Compacting keeps the whole transcript, so a paired phone may ask for it like any message.
    expect(remotePath("POST", "/v1/ext/studio/sessions/1/compact")).toBe("/v1/ext/studio/sessions/1/compact");
    expect(remotePath("POST", "/v1/editor/restart")).toBe("/v1/editor/restart");
    // The file viewer reads a file; opening one in an app on the computer stays there.
    expect(remotePath("GET", "/v1/ext/studio/files/read?path=.wiki%2FDecisions.md")).toBe("/v1/ext/studio/files/read?path=.wiki%2FDecisions.md");
    // A reply's images load the same way on a paired phone and browser as on the computer.
    expect(remotePath("GET", "/v1/ext/studio/files/image?path=Saved%2FShots%2Fstep02.jpg")).toBe("/v1/ext/studio/files/image?path=Saved%2FShots%2Fstep02.jpg");
    for (const [m, p] of [
      ["POST", "/v1/mcp"],
      ["POST", "/v1/shutdown"],
      ["POST", "/v1/handoff"],
      ["POST", "/v1/update/apply"],
      ["POST", "/v1/plugins/install"],
      ["POST", "/v1/ext/studio/window"],
      ["POST", "/v1/ext/studio/files/open"],
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

  it("lets ids and paths with slashes through as data: playtest verdicts and Git diffs", () => {
    const run = encodeURIComponent("draft:/Game/PIEStudio/Scripts/TS_Door");
    expect(remotePath("POST", `/v1/ext/studio/qa/runs/${run}/verdict`)).toBe(`/v1/ext/studio/qa/runs/${run}/verdict`);
    expect(remotePath("GET", `/v1/ext/studio/qa/runs/${run}/status?since_seq=3`)).toBe(`/v1/ext/studio/qa/runs/${run}/status?since_seq=3`);
    const file = encodeURIComponent("Content/Props/Door/BP_Door.uasset");
    expect(remotePath("GET", `/v1/ext/studio/vcs/diff?path=${file}`)).toBe(`/v1/ext/studio/vcs/diff?path=${file}`);
    const script = encodeURIComponent("/Game/PIEStudio/Scripts/TS_Door");
    expect(remotePath("GET", `/v1/ext/studio/qa/playtests/script?script=${script}`)).toBe(`/v1/ext/studio/qa/playtests/script?script=${script}`);
  });

  it("refuses encoded parts that step out of a segment or hide a denied route", () => {
    for (const [m, p] of [
      ["POST", "/v1/ext/studio/sessions/x%2F..%2F..%2Fremote%2Fpair"],
      ["POST", "/v1/ext/studio/qa/runs/..%2Fremote/verdict"],
      ["GET", "/v1/ext/studio/sessions/%2F..%2F"],
      ["GET", "/v1/ext/studio/vcs/diff?path=..%2F..%2Fsecret.txt"],
      ["GET", "/v1/ext/studio/vcs/diff?path=Content%2F..%2F..%2Fsecret.txt"],
      ["GET", "/v1/ext/studio/vcs/diff?path=..%5Csecret.txt"],
      ["GET", "/v1/ext/studio/vcs/diff?path=a%5C..%5Cb"],
      ["GET", "/v1/ext/studio/vcs/diff?path=a%00b"],
      ["GET", "/v1/ext/studio/vcs/diff?path=%E0%A4%A"],
      ["POST", "/v1/ext/studio/updates%2Fstudio"],
      ["POST", "/v1/ext/studio/x/..%2Fupdates%2Fstudio"],
      ["PUT", "/v1/ext/studio/endpoints%2Fabc"],
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
      ["GET", "/v1/ext/studio/remote/lock"],
      ["PUT", "/v1/ext/studio/remote/lock"],
      ["PUT", "/v1/ext/studio/remote/lock/pin"],
      ["DELETE", "/v1/ext/studio/remote/lock/pin"],
      ["POST", "/v1/ext/studio/remote/lock/forget"],
      ["POST", "/v1/ext/studio/REMOTE/lock/forget"],
      ["POST", "/v1/ext/studio/remote/lock%2Fforget"],
      ["POST", "/v1/ext/studio/remote%2Flock%2Fforget"],
      ["POST", "/v1/ext/studio/x/..%2Fremote/lock/forget"],
      ["POST", "/v1/ext/studio/lock/../remote/lock/forget"],
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

  it("lets a paired browser read the ue-mcp account and its sign-in methods, and change none of it", () => {
    for (const p of ["/v1/ext/studio/auth/methods", "/v1/ext/studio/account", "/v1/ext/studio/account/profile", "/v1/ext/studio/account/github/link"]) {
      expect(remotePath("GET", p), p).toBe(p);
    }
    for (const m of ["POST", "PUT", "DELETE", "delete"]) {
      for (const p of [
        "/v1/ext/studio/auth/email/start",
        "/v1/ext/studio/auth/email/verify",
        "/v1/ext/studio/account/email",
        "/v1/ext/studio/account/email/start",
        "/v1/ext/studio/account/email/verify",
        "/v1/ext/studio/account/github",
        "/v1/ext/studio/account/github/link",
        "/v1/ext/studio/Account/GitHub",
        "/v1/ext/studio/x/../auth/email/start",
      ]) expect(remotePath(m, p), `${m} ${p}`).toBeNull();
    }
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
