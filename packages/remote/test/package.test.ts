/** The remote package: publishable under MIT, and the wire constants the relay depends on. */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPUTER_KEY_HEADER, CONNECTOR_PATH, DEVICE_HEADER, DEVICE_NAME_HEADER, E2E_VERSION, MAX_REQUEST_BYTES, MAX_SKEW_MS, PAIR_SECRET_TTL_MS } from "../src/index.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));

describe("@ue-mcp-studio/remote", () => {
  it("is publishable under MIT and ships only its build and license", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toEqual(["dist", "LICENSE"]);
    expect(fs.readFileSync(path.join(dir, "LICENSE"), "utf-8")).toMatch(/^MIT License/);
  });

  it("keeps the wire constants the relay was built against", () => {
    expect({ E2E_VERSION, MAX_SKEW_MS, PAIR_SECRET_TTL_MS, MAX_REQUEST_BYTES }).toEqual({ E2E_VERSION: 1, MAX_SKEW_MS: 120_000, PAIR_SECRET_TTL_MS: 600_000, MAX_REQUEST_BYTES: 8 * 1024 * 1024 });
    expect([CONNECTOR_PATH, DEVICE_HEADER, DEVICE_NAME_HEADER, COMPUTER_KEY_HEADER]).toEqual(["/connect", "x-ue-mcp-device", "x-ue-mcp-device-name", "x-ue-mcp-computer-key"]);
  });
});
