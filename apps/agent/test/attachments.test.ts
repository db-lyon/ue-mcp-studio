import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore, contentFor, safeName } from "../src/attachments.js";
import { toChatRequest } from "../src/openai-compat.js";

const store = () => new AttachmentStore(fs.mkdtempSync(path.join(os.tmpdir(), "studio-att-")));
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

describe("attachments", () => {
  it("saves a file under the session and reads it back by id, never by a path the page sends", () => {
    const s = store();
    const a = s.save("sess", { name: "..\..\evil/notes.txt", type: "text/plain", data: b64("hello") });
    expect(a).toMatchObject({ name: "notes.txt", type: "text/plain", size: 5 });
    expect(fs.readFileSync(a.path, "utf-8")).toBe("hello");
    expect(s.get("sess", a.id)?.path).toBe(a.path);
    expect(s.get("other", a.id)).toBeNull();
    expect(s.get("sess", "../../x")).toBeNull();
    s.removeSession("sess");
    expect(s.get("sess", a.id)).toBeNull();
  });

  it("refuses an empty file", () => {
    expect(() => store().save("s", { name: "a.png", type: "image/png", data: "" })).toThrow(/empty/);
  });

  it("keeps names Windows can store", () => {
    expect(safeName('a:b*c?.png')).toBe("a_b_c_.png");
  });

  it("gives the model an image, a PDF or a text file as itself, and anything else by its path", () => {
    const s = store();
    const png = s.save("x", { name: "ref.png", type: "image/png", data: b64(Buffer.from([1, 2, 3])) });
    const pdf = s.save("x", { name: "spec.pdf", type: "application/pdf", data: b64("%PDF") });
    const txt = s.save("x", { name: "config.ini", type: "", data: b64("[a]\nb=1") });
    const fbx = s.save("x", { name: "rock.fbx", type: "application/octet-stream", data: b64("FBX") });
    const kinds = (a: Parameters<typeof contentFor>[0]) => contentFor(a).map((b) => (b as { type: string }).type);
    expect(kinds(png)).toEqual(["text", "image"]);
    expect(kinds(pdf)).toEqual(["text", "document"]);
    expect(contentFor(txt)[1]).toEqual({ type: "text", text: "[a]\nb=1" });
    const only = contentFor(fbx);
    expect(only).toHaveLength(1);
    expect((only[0] as { text: string }).text).toContain(fbx.path);
    expect((only[0] as { text: string }).text).toMatch(/import it into the project with ue-mcp/);
  });

  it("sends an image to an OpenAI-compatible model as a data URL beside the text", () => {
    const req = toChatRequest({
      sessionId: "s", model: "m", system: [{ type: "text", text: "sys" }], tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] } as never],
    });
    expect(req.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] });
  });
});
