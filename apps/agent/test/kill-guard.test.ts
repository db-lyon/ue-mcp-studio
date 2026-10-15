/**
 * The shell's kill guard: which kills a command asks for, and which of them
 * would close another project's editor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { guardShellCommand, isEditorProcess, killRefusal, killTargets, lookupProcesses, projectOf, type ProcInfo } from "../src/kill-guard.js";

describe("killTargets", () => {
  it("reads PIDs from taskkill, Git Bash's doubled slashes included", () => {
    expect(killTargets("taskkill //PID 59828 //F; taskkill //PID 29992 //F; taskkill //PID 70448 //F")).toEqual({ pids: [59828, 29992, 70448], image: null });
    expect(killTargets("taskkill /F /PID 123 /T").pids).toEqual([123]);
  });

  it("reads PIDs from Stop-Process, kill, wmic and pskill", () => {
    expect(killTargets("Stop-Process -Id 11,12 -Force").pids).toEqual([11, 12]);
    expect(killTargets("Stop-Process 13").pids).toEqual([13]);
    expect(killTargets("kill -9 14").pids).toEqual([14]);
    expect(killTargets("wmic process where processid=15 delete").pids).toEqual([15]);
    expect(killTargets("wmic process where \"ProcessId=16\" call terminate").pids).toEqual([16]);
    expect(killTargets("pskill -t 17").pids).toEqual([17]);
    expect(killTargets("(Get-Process -Id 18).Kill()").pids).toEqual([18]);
  });

  it("reports an editor named by image", () => {
    expect(killTargets("taskkill //IM UnrealEditor.exe //F").image).toBe("UnrealEditor.exe");
    expect(killTargets("Get-Process UnrealEditor | Stop-Process -Force").image).toBe("UnrealEditor");
    expect(killTargets("Stop-Process -Name UnrealEditor-Cmd").image).toBe("UnrealEditor-Cmd");
    expect(killTargets("wmic process where name='CrashReportClientEditor.exe' delete").image).toBe("CrashReportClientEditor.exe");
    expect(killTargets("pkill UnrealEditor").image).toBe("UnrealEditor");
  });

  it("leaves commands that kill nothing alone", () => {
    expect(killTargets("git log -n 5")).toEqual({ pids: [], image: null });
    expect(killTargets("tasklist | grep UnrealEditor")).toEqual({ pids: [], image: null });
    expect(killTargets("tasklist | grep UnrealEditor; taskkill //PID 42 //F")).toEqual({ pids: [42], image: null });
  });
});

describe("killRefusal", () => {
  const own = ["C:\\Projects\\Vale\\Vale.uproject"];
  const editor = (pid: number, cmd: string, name = "UnrealEditor.exe"): ProcInfo => ({ pid, name, commandLine: cmd });

  it("allows this project's editor", () => {
    expect(killRefusal([editor(1, "\"C:\\UE\\UnrealEditor.exe\" \"C:/Projects/Vale/Vale.uproject\" -log")], own)).toBeNull();
  });

  it("refuses another project's editor, naming the PID and the project", () => {
    const r = killRefusal([editor(29992, "\"C:\\UE\\UnrealEditor.exe\" \"D:\\Work\\Other\\Other.uproject\"")], own);
    expect(r).toContain("PID 29992");
    expect(r).toContain("Other (D:\\Work\\Other\\Other.uproject)");
    expect(r).toContain("editor_restart");
  });

  it("refuses an editor-cmd or crash reporter that does not name this project", () => {
    expect(killRefusal([editor(2, "UnrealEditor-Cmd.exe D:\\Other\\Other.uproject -run=x", "UnrealEditor-Cmd.exe")], own)).toContain("PID 2");
    expect(killRefusal([editor(3, "CrashReportClientEditor.exe -Unattended", "CrashReportClientEditor.exe")], own)).toContain("PID 3");
  });

  it("leaves other processes alone", () => {
    expect(killRefusal([{ pid: 4, name: "node.exe", commandLine: "node D:\\Other\\Other.uproject" }], own)).toBeNull();
    expect(isEditorProcess("UnrealEditor")).toBe(true);
    expect(isEditorProcess("UnrealEditorServices.exe")).toBe(false);
  });

  it("reads the project from a command line", () => {
    expect(projectOf("\"C:\\UE\\UnrealEditor.exe\" \"D:\\My Work\\Other.uproject\" -log")).toBe("D:\\My Work\\Other.uproject");
    expect(projectOf("UnrealEditor.exe")).toBeNull();
  });
});

describe("guardShellCommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-kill-"));
    fs.writeFileSync(path.join(dir, "Vale.uproject"), "{}");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const procs = (): ProcInfo[] => [
    { pid: 59828, name: "UnrealEditor.exe", commandLine: `UnrealEditor.exe "${path.join(dir, "Vale.uproject")}"` },
    { pid: 29992, name: "UnrealEditor.exe", commandLine: "UnrealEditor.exe \"D:\\Other\\Other.uproject\"" },
    { pid: 70448, name: "node.exe", commandLine: "node server.js" },
  ];
  const lookup = async (pids: number[]) => procs().filter((p) => pids.includes(p.pid));

  it("refuses the session's command, which named another project's editor", async () => {
    const r = await guardShellCommand("taskkill //PID 59828 //F; taskkill //PID 29992 //F; taskkill //PID 70448 //F", dir, lookup);
    expect(r).toContain("PID 29992");
    expect(r).toContain("Other");
  });

  it("allows this project's editor and other processes", async () => {
    expect(await guardShellCommand("taskkill //PID 59828 //F; taskkill //PID 70448 //F", dir, lookup)).toBeNull();
  });

  it("refuses an image-name kill without a lookup", async () => {
    const r = await guardShellCommand("taskkill /IM UnrealEditor.exe /F", dir, async () => {
      throw new Error("not called");
    });
    expect(r).toContain("by image name");
  });

  it("does not look up commands that kill nothing", async () => {
    expect(await guardShellCommand("git status", dir, async () => {
      throw new Error("not called");
    })).toBeNull();
  });

  it("refuses when the lookup fails", async () => {
    const r = await guardShellCommand("taskkill //PID 1 //F", dir, async () => {
      throw new Error("no CIM");
    });
    expect(r).toContain("could not check");
  });
});

describe("lookupProcesses", () => {
  it("reads this process's name and command line", async () => {
    const [me] = await lookupProcesses([process.pid]);
    expect(me.pid).toBe(process.pid);
    expect(me.name.toLowerCase()).toContain("node");
    expect(me.commandLine.length).toBeGreaterThan(0);
  }, 20_000);
});
