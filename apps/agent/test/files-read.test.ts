/** GET /files/read, the file viewer's route, against a fake daemon API and real files. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { FILE_READ_MAX_BYTES, FILE_SHOW_BYTES, type FileReadResponse } from "@ue-mcp-studio/shared";
import { registerNativeRoutes } from "../src/native-routes.js";

type Reply = { status?: number; body?: unknown };
let root: string;
let project: string;
let home: string;
let read: (query: Record<string, string>) => Reply;

const write = (abs: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-files-read-"));
  project = path.join(root, "Game");
  home = path.join(root, "home");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const routes = new Map<string, (req: { body?: unknown; query: Record<string, string> }) => Reply>();
  const api = { projectDir: project, route: (m: string, p: string, h: never) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
  registerNativeRoutes(api, {
    enabled: () => true,
    main: () => ({ vendor: "anthropic", model: "m", route: null }),
    routesFor: () => [],
    runsOverApi: () => false,
    modelName: (m) => m,
    worker: () => ({ model: "m", effort: "high", starts: "asked" }),
    home: () => home,
    owners: () => new Map(),
    top: root,
    open: () => {},
  });
  read = (query) => routes.get("GET /files/read")!({ query });
});

const ok = (r: Reply) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as FileReadResponse;
};
const error = (r: Reply) => (r.body as { error: string }).error;

describe("GET /files/read", () => {
  it("reads a project file by its relative path, and says where it is", () => {
    write(path.join(project, ".wiki", "Decisions.md"), "# Decisions\nUse PCG.");
    expect(ok(read({ path: ".wiki/Decisions.md" }))).toEqual({ path: ".wiki/Decisions.md", text: "# Decisions\nUse PCG.", size: 20 });
    expect(ok(read({ path: path.join(project, ".wiki", "Decisions.md") })).path).toBe(".wiki/Decisions.md");
  });

  it("resolves a link inside a viewed file against that file's folder", () => {
    write(path.join(project, ".wiki", "Index.md"), "[d](Decisions.md)");
    write(path.join(project, ".wiki", "Decisions.md"), "D");
    write(path.join(project, "README.md"), "R");
    expect(ok(read({ path: "Decisions.md", from: ".wiki/Index.md" })).path).toBe(".wiki/Decisions.md");
    expect(ok(read({ path: "../README.md", from: ".wiki/Index.md" })).text).toBe("R");
  });

  it("reads the agents' own folders in the home folder, and nothing else there", () => {
    write(path.join(home, ".claude", "CLAUDE.md"), "Mine.");
    write(path.join(home, ".ssh", "id_rsa"), "KEY");
    expect(ok(read({ path: "~/.claude/CLAUDE.md" }))).toMatchObject({ path: "~/.claude/CLAUDE.md", text: "Mine." });
    const r = read({ path: "~/.ssh/id_rsa" });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("KEY");
  });

  it("refuses ../ steps out of the project, however they are spelled", () => {
    write(path.join(root, "secret.txt"), "SECRET");
    write(path.join(project, ".wiki", "Index.md"), "x");
    for (const query of [
      { path: "../secret.txt" },
      { path: "..\\secret.txt" },
      { path: ".wiki/../../secret.txt" },
      { path: "../../secret.txt", from: ".wiki/Index.md" },
      { path: "secret.txt", from: "../x.md" },
      { path: "~/../secret.txt" },
    ]) {
      const r = read(query);
      expect(r.status, JSON.stringify(query)).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("SECRET");
    }
  });

  it("refuses an absolute path outside the project", () => {
    write(path.join(root, "secret.txt"), "SECRET");
    expect(read({ path: path.join(root, "secret.txt") }).status).toBe(403);
    expect(read({ path: path.resolve("/", "Windows", "win.ini") }).status).toBe(403);
    expect(read({ path: "/etc/passwd" }).status).toBe(403);
  });

  it("refuses a symlink in the project that leads out of it", () => {
    write(path.join(root, "outside", "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(root, "outside"), path.join(project, "linked"), "junction");
    const r = read({ path: "linked/secret.txt" });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
  });

  it("refuses a binary file", () => {
    write(path.join(project, "Content", "Door.uasset"), Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0, 1, 2]));
    const r = read({ path: "Content/Door.uasset" });
    expect(r.status).toBe(415);
    expect(error(r)).toBe("Content/Door.uasset is not a text file.");
  });

  it("refuses a file over the size cap, and shows a long one up to its limit", () => {
    write(path.join(project, "huge.log"), Buffer.alloc(FILE_READ_MAX_BYTES + 1, 0x61));
    const r = read({ path: "huge.log" });
    expect(r.status).toBe(413);
    expect(error(r)).toMatch(/^huge\.log is 4\.0 MB; Studio shows files up to 4 MB\.$/);
    write(path.join(project, "long.log"), Buffer.alloc(FILE_SHOW_BYTES + 10, 0x62));
    const long = ok(read({ path: "long.log" }));
    expect(long).toMatchObject({ size: FILE_SHOW_BYTES + 10, truncated: true });
    expect(long.text).toHaveLength(FILE_SHOW_BYTES);
  });

  it("answers 404 with a clear message for a missing file", () => {
    const r = read({ path: ".wiki/Nope.md" });
    expect(r.status).toBe(404);
    expect(error(r)).toBe(".wiki/Nope.md does not exist.");
  });

  it("refuses a folder, an empty path and a control character", () => {
    fs.mkdirSync(path.join(project, "Source"));
    expect(read({ path: "Source" }).status).toBe(400);
    expect(read({}).status).toBe(400);
    expect(read({ path: "a\u0000.md" }).status).toBe(400);
  });

  it("reads UTF-16 text with its byte order mark, and drops a UTF-8 one", () => {
    write(path.join(project, "Config", "Wide.ini"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[Core]\nA=1", "utf16le")]));
    write(path.join(project, "Bom.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Hi")]));
    expect(ok(read({ path: "Config/Wide.ini" })).text).toBe("[Core]\nA=1");
    expect(ok(read({ path: "Bom.md" })).text).toBe("# Hi");
  });
});
