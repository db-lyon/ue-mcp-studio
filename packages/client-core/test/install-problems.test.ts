import { describe, expect, it } from "vitest";
import type { StatusReport } from "ue-mcp/daemon";
import { beforeLaunch, problemCopy } from "../src/install-problems.js";

/** A StatusReport with these problem codes; only what the copy reads is filled in. */
function report(codes: string[], engine: string | null = "5.9"): StatusReport {
  return {
    project: { path: "C:/P/P.uproject", name: "P", engine, engineAssociation: engine },
    plugin: { installedVersion: "1.4.16", packagedVersion: "1.4.16", pendingBuild: null },
    problems: codes.map((code) => ({ code, what: `ue-mcp says ${code}`, fix: "Run editor(action='rebuild')." })),
  } as unknown as StatusReport;
}

const mismatch = (r: StatusReport) => problemCopy(r.problems.find((x) => x.code === "bridge_engine_mismatch")!, r);

describe("a bridge built for a different engine build", () => {
  it("says so in plain words and offers Rebuild, which compiles it for this engine", () => {
    const c = mismatch(report(["bridge_engine_mismatch"]));
    expect(c.title).toBe("The bridge plugin was built for a different Unreal build.");
    expect(c.detail).toContain("until it matches your engine. Rebuild compiles it on this computer");
    expect(c.action).toBe("rebuild");
  });

  it("without a C++ compiler, offers no Rebuild and says to install the tools or update the engine", () => {
    const c = mismatch(report(["bridge_engine_mismatch", "no_toolchain"]));
    expect(c.action).toBeUndefined();
    expect(c.detail).toContain("C++ tools");
    expect(c.detail).toContain("newest build of UE 5.9 in the Epic Games Launcher");
    expect(mismatch(report(["bridge_engine_mismatch", "no_toolchain"], null)).detail).toContain("newest build of your engine version");
  });

  it("never shows ue-mcp's agent-facing text or names a tool call", () => {
    for (const codes of [["bridge_engine_mismatch"], ["bridge_engine_mismatch", "no_toolchain"]]) {
      const c = mismatch(report(codes));
      expect(`${c.title} ${c.detail}`).not.toMatch(/ue-mcp says|editor\(|action=/);
      expect(`${c.title} ${c.detail}`).not.toContain("\u2014");
    }
  });
});

describe("what Launch editor does first", () => {
  it("launches when there is no report, no problem, or only problems Unreal does not stop on", () => {
    expect(beforeLaunch(null)).toBeNull();
    expect(beforeLaunch(report([]))).toBeNull();
    expect(beforeLaunch(report(["bridge_build_stale", "bridge_version_mismatch"]))).toBeNull();
    expect(beforeLaunch({ problems: undefined } as unknown as StatusReport)).toBeNull();
  });

  it("offers Rebuild instead of launching when the bridge was built for another engine build", () => {
    const c = beforeLaunch(report(["bridge_build_stale", "bridge_engine_mismatch"]));
    expect(c?.action).toBe("rebuild");
    expect(c?.title).toBe("The bridge plugin was built for a different Unreal build.");
  });

  it("still stops before launching without a compiler, with no Rebuild to offer", () => {
    const c = beforeLaunch(report(["bridge_engine_mismatch", "no_toolchain"]));
    expect(c).not.toBeNull();
    expect(c?.action).toBeUndefined();
  });
});
