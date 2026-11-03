/** remotePath: what a paired browser may reach on the computer, and what it never may. */
import { describe, expect, it } from "vitest";
import { remotePath } from "../src/index.js";

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

  it("still allows Studio routes that only start with the same letters", () => {
    expect(remotePath("GET", "/v1/ext/studio/remotes")).toBe("/v1/ext/studio/remotes");
    expect(remotePath("GET", "/v1/ext/studio/sessions/remote")).toBe("/v1/ext/studio/sessions/remote");
  });
});
