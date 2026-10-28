/** scripts/usage-parity finds ue-mcp where npm installed it, hoisted or not. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error a plain .mjs script with no types
import { ueMcpPackageDir } from "../../../scripts/usage-parity/ue-mcp-path.mjs";

let repo: string;
const install = (dir: string, version: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ue-mcp", version }));
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-parity-"));
  fs.mkdirSync(path.join(repo, "apps", "agent"), { recursive: true });
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("the usage-parity script's ue-mcp", () => {
  it("is the hoisted copy in the repo's node_modules", () => {
    install(path.join(repo, "node_modules", "ue-mcp"), "1.0.0");
    expect(ueMcpPackageDir(repo)).toBe(path.join(repo, "node_modules", "ue-mcp"));
  });

  it("is the agent's own copy when npm kept one there", () => {
    install(path.join(repo, "node_modules", "ue-mcp"), "1.0.0");
    install(path.join(repo, "apps", "agent", "node_modules", "ue-mcp"), "2.0.0");
    expect(ueMcpPackageDir(repo)).toBe(path.join(repo, "apps", "agent", "node_modules", "ue-mcp"));
  });

  it("says where it looked when there is none", () => {
    expect(() => ueMcpPackageDir(repo)).toThrow(/run npm ci. Looked in .*agent.node_modules.ue-mcp/);
  });
});
