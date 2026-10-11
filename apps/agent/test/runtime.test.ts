import { describe, expect, it } from "vitest";
import { extractFromTar } from "../src/runtime.js";

function entry(name: string, body: Buffer, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write(type, 156);
  return Buffer.concat([h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
}

describe("Claude runtime package", () => {
  it("takes the binary out of the package tarball, past other files and a pax path record", () => {
    const long = `package/${"d/".repeat(60)}claude.exe`;
    const tar = Buffer.concat([
      entry("package/package.json", Buffer.from("{}")),
      entry("PaxHeader", Buffer.from(`${long.length + 9} path=${long}\n`), "x"),
      entry("ignored-short-name", Buffer.from("BIN")),
      entry("package/claude.exe", Buffer.from("EXE")),
      Buffer.alloc(1024),
    ]);
    expect(extractFromTar(tar, long)?.toString()).toBe("BIN");
    expect(extractFromTar(tar, "package/claude.exe")?.toString()).toBe("EXE");
    expect(extractFromTar(tar, "package/missing")).toBeNull();
  });
});
