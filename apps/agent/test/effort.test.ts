import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";

// How each vendor takes the level is pi-ai's (the durable harness sends it as the thinking level); the setting is Studio's.
describe("the effort setting", () => {
  const store = () => ((d) => new SettingsStore(d, path.join(d, "keys")))(fs.mkdtempSync(path.join(os.tmpdir(), "studio-effort-")));

  it("starts at high and keeps a chosen level", () => {
    const s = store();
    expect(s.effort()).toBe("high");
    s.update({ effort: "max" });
    expect(s.view().effort).toBe("max");
  });

  it("refuses an unknown level", () => {
    expect(() => store().update({ effort: "huge" as never })).toThrow(/effort must be one of/);
  });
});
