/**
 * Atomic writes against a rename Windows refuses while another process has
 * the destination open: tried again, and a session save that still fails is
 * kept in memory and never throws out of its caller.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PendingWrites, atomicIo, renameRetrying, writeFileAtomic } from "../src/atomic-write.js";
import { SessionStore } from "../src/sessions.js";
import { fromPackage, installCrashGuard } from "../src/crash-guard.js";

const realRename = atomicIo.rename;
const realPause = atomicIo.pause;
let dir: string;
let refusals: number;
let renames: number;

const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-atomic-"));
  refusals = 0;
  renames = 0;
  atomicIo.pause = () => {};
  // Refuse the next `refusals` renames as Windows does while the destination is open elsewhere.
  atomicIo.rename = (from, to) => {
    renames++;
    if (refusals > 0) {
      refusals--;
      throw eperm();
    }
    realRename(from, to);
  };
});

afterEach(() => {
  atomicIo.rename = realRename;
  atomicIo.pause = realPause;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a refused rename", () => {
  it("is tried again and goes through once the lock is let go", () => {
    refusals = 3;
    const file = path.join(dir, "a.json");
    writeFileAtomic(file, "{\"v\":1}");
    expect(fs.readFileSync(file, "utf-8")).toBe("{\"v\":1}");
    expect(renames).toBe(4);
    expect(fs.readdirSync(dir)).toEqual(["a.json"]);
  });

  it("throws once its pauses run out, leaving the previous file and no temporary one", () => {
    const file = path.join(dir, "a.json");
    writeFileAtomic(file, "old");
    refusals = 100;
    expect(() => writeFileAtomic(file, "new")).toThrow(/EPERM/);
    expect(fs.readFileSync(file, "utf-8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["a.json"]);
  });

  it("is not tried again for an error a lock does not explain", () => {
    atomicIo.rename = () => {
      renames++;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(() => renameRetrying("x", "y")).toThrow(/ENOENT/);
    expect(renames).toBe(1);
  });
});

describe("the session store on a refused rename", () => {
  const sessionFile = (id: string) => path.join(dir, "sessions", `${id}.json`);
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(sessionFile(id), "utf-8")) as { draft: string };

  it("saves after a few refusals as if nothing happened", () => {
    const store = new SessionStore(dir, () => {});
    const s = store.create();
    s.draft = "kept";
    refusals = 2;
    store.save(s);
    expect(onDisk(s.id).draft).toBe("kept");
    expect(store.unsaved()).toEqual([]);
  });

  it("keeps a save that keeps failing in memory without throwing, and writes it on the next change", () => {
    const logged: string[] = [];
    const store = new SessionStore(dir, (msg) => logged.push(msg));
    const s = store.create();
    s.draft = "first";
    store.save(s);
    refusals = 1000;
    s.draft = "while locked";
    expect(() => store.save(s)).not.toThrow();
    expect(store.unsaved()).toEqual([sessionFile(s.id)]);
    expect(store.get(s.id)!.draft).toBe("while locked");
    expect(onDisk(s.id).draft).toBe("first");
    // Said once, not on every try.
    s.draft = "still locked";
    store.save(s);
    expect(logged.filter((m) => m.startsWith("could not write"))).toHaveLength(1);

    // The lock goes; the next save of another session writes this one too, from what is in memory then.
    refusals = 0;
    const other = store.create();
    other.draft = "other";
    store.save(other);
    expect(store.unsaved()).toEqual([]);
    expect(onDisk(s.id).draft).toBe("still locked");
    expect(logged.some((m) => m.startsWith("wrote"))).toBe(true);
    expect(new SessionStore(dir, () => {}).get(s.id)!.draft).toBe("still locked");
  });

  it("does not bring back a session deleted while its save waited", () => {
    const store = new SessionStore(dir, () => {});
    const s = store.create();
    s.draft = "x";
    store.save(s);
    refusals = 1000;
    s.draft = "y";
    store.save(s);
    refusals = 0;
    store.delete(s.id);
    store.flush();
    expect(fs.existsSync(sessionFile(s.id))).toBe(false);
  });
});

describe("pending writes", () => {
  it("try again on their own after a while", async () => {
    let fail = true;
    let wrote = 0;
    const w = new PendingWrites({ log: () => {}, retryMs: 10 });
    expect(w.write("f", () => {
      if (fail) throw eperm();
      wrote++;
    })).toBe(false);
    fail = false;
    for (let i = 0; i < 100 && !wrote; i++) await new Promise((r) => setTimeout(r, 10));
    expect(wrote).toBe(1);
    expect(w.pending()).toEqual([]);
    w.dispose();
  });
});

describe("the crash guard", () => {
  const pkg = path.join(dir ?? os.tmpdir(), "extensions", "studio@1.0.0");
  const ours = () => {
    const e = new Error("EPERM");
    e.stack = `Error: EPERM\n    at t.save (file:///${pkg.replace(/\\/g, "/")}/dist/index.js:443:2400)\n    at Socket.emit (node:events:514:20)`;
    return e;
  };

  it("knows Studio's own errors by their stack", () => {
    expect(fromPackage(ours(), pkg)).toBe(true);
    expect(fromPackage(new Error("elsewhere"), pkg)).toBe(false);
    expect(fromPackage("no stack", pkg)).toBe(false);
  });

  it("logs and contains Studio's errors, and leaves the daemon's own to end it as before", () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const proc = {
      on: (ev: string, h: (e: unknown) => void) => void (handlers[ev] = h),
      off: (ev: string) => void delete handlers[ev],
      listenerCount: () => 1,
    } as unknown as Pick<NodeJS.Process, "on" | "off" | "listenerCount">;
    const warned: string[] = [];
    const exits: number[] = [];
    const errors = console.error;
    console.error = () => {};
    try {
      const remove = installCrashGuard({ dir: pkg, log: { warn: (m) => warned.push(m) }, proc, exit: (c) => exits.push(c) });
      handlers.uncaughtException(ours());
      handlers.unhandledRejection(ours());
      expect(warned).toHaveLength(2);
      expect(exits).toEqual([]);
      handlers.uncaughtException(new Error("the daemon's own"));
      expect(exits).toEqual([1]);
      remove();
      expect(Object.keys(handlers)).toEqual([]);
    } finally {
      console.error = errors;
    }
  });
});
