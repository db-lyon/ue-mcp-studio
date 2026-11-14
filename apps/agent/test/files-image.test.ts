/** GET /files/image, the route a reply's markdown images load through, against a fake daemon API and real files. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import * as jpeg from "jpeg-js";
import { IMAGE_READ_MAX_BYTES, POSTER_MAX_BYTES, localImagePath, projectImagePosterUrl, projectImageUrl } from "@ue-mcp-studio/shared";
import { registerNativeRoutes } from "../src/native-routes.js";
import { gifBytes } from "./image-fixtures.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
let root: string;
let project: string;
let posters: string;
let image: (query: Record<string, string>) => Promise<Reply>;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const write = (abs: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-files-image-"));
  project = path.join(root, "Game");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  posters = path.join(root, "data", "posters");
  const routes = new Map<string, (req: { body?: unknown; query: Record<string, string> }) => Reply | Promise<Reply>>();
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
    posters,
  });
  image = async (query) => routes.get("GET /files/image")!({ query });
});

describe("GET /files/image", () => {
  it("serves a project image by its relative or absolute path, with its type", async () => {
    const shot = path.join(project, "Saved", "MCPObservations", "run", "captures", "step02.jpg");
    write(shot, PNG);
    for (const p of ["Saved/MCPObservations/run/captures/step02.jpg", shot]) {
      const r = await image({ path: p });
      expect(r.status ?? 200).toBe(200);
      expect(r.headers?.["content-type"]).toBe("image/jpeg");
      expect(Buffer.compare(r.body as Buffer, PNG)).toBe(0);
    }
  });

  it("refuses what is not an image, what is outside the project, and what is too large", async () => {
    write(path.join(project, "notes.txt"), "x");
    expect((await image({ path: "notes.txt" })).status).toBe(415);
    write(path.join(root, "outside.png"), PNG);
    expect((await image({ path: path.join(root, "outside.png") })).status).toBe(403);
    expect((await image({ path: path.join(root, "outside.png"), poster: "1" })).status).toBe(403);
    expect((await image({ path: "missing.png" })).status).toBe(404);
    const big = path.join(project, "big.png");
    write(big, "");
    fs.truncateSync(big, IMAGE_READ_MAX_BYTES + 1);
    expect((await image({ path: "big.png" })).status).toBe(413);
  });

  it("with poster=1, answers the first frame as a small JPEG, kept in the data folder and made once", async () => {
    write(path.join(project, "Saved", "Captures", "run.gif"), gifBytes(720, 366));
    const r = await image({ path: "Saved/Captures/run.gif", poster: "1" });
    expect(r.status ?? 200).toBe(200);
    expect(r.headers?.["content-type"]).toBe("image/jpeg");
    const body = r.body as Buffer;
    expect(body.length).toBeLessThanOrEqual(POSTER_MAX_BYTES);
    const decoded = jpeg.decode(body);
    expect([decoded.width, decoded.height]).toEqual([480, 244]);
    expect(fs.readdirSync(posters)).toHaveLength(1);
    // The project's own folder gains nothing.
    expect(fs.readdirSync(path.join(project, "Saved", "Captures"))).toEqual(["run.gif"]);
    const again = await image({ path: "Saved/Captures/run.gif", poster: "1" });
    expect(Buffer.compare(again.body as Buffer, body)).toBe(0);
  });

  it("answers 422 for a poster of a file that does not decode", async () => {
    write(path.join(project, "broken.png"), PNG);
    expect((await image({ path: "broken.png", poster: "1" })).status).toBe(422);
  });
});

describe("which markdown images the chat loads from the project", () => {
  it("takes project, absolute and file:// image paths, and leaves web images and other files alone", () => {
    expect(localImagePath("Saved/Shots/a%20b.png")).toBe("Saved/Shots/a b.png");
    expect(localImagePath("C:/Game/Saved/x.JPG")).toBe("C:/Game/Saved/x.JPG");
    expect(localImagePath("file:///C:/Game/Saved/x.webp")).toBe("C:/Game/Saved/x.webp");
    expect(localImagePath("https://example.com/x.png")).toBeNull();
    expect(localImagePath("data:image/png;base64,AAAA")).toBeNull();
    expect(localImagePath("Saved/notes.md")).toBeNull();
    expect(projectImageUrl("Saved/a b.png")).toBe("/v1/ext/studio/files/image?path=Saved%2Fa%20b.png");
    expect(projectImagePosterUrl("Saved/a b.png")).toBe("/v1/ext/studio/files/image?path=Saved%2Fa%20b.png&poster=1");
  });
});
