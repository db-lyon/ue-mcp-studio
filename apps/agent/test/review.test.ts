/**
 * Per-turn review against a faked daemon checkpoints API: the checkpoints
 * around a turn, the review entry and the timeline, Keep, Revert and its undo,
 * a conflict, Restore to here and its undo, and the switch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { assetPathOf, readableValue, refineAssetDiff, reviewGroupOf, unifiedLines, type AssetDiff, type TurnReview } from "@ue-mcp-studio/shared";
import { NO_CHECKPOINTS, ReviewBroker, type ReviewHost } from "../src/review.js";
import { SessionStore, type StoredSession } from "../src/sessions.js";
import { AgentRunner } from "../src/runner.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { FakeCheckpoints } from "./checkpoint-fake.js";

let root: string;
let store: SessionStore;
let cp: FakeCheckpoints;
let calls: Array<{ category: string; action: string; args?: Record<string, unknown> }>;
let published: Array<{ type: string; data?: Record<string, unknown> }>;

const hostOf = (checkpoints: FakeCheckpoints | undefined = cp): ReviewHost => ({
  checkpoints,
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  callAction: async (category, action, args) => {
    calls.push({ category, action, args });
    if (category === "asset" && action === "save") cp.dirty = [];
    return { isError: false, content: [{ type: "text", text: "{}" }] };
  },
  events: { publish: (type, data) => void published.push({ type, data }) },
  log: { warn() {} },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-review-"));
  store = new SessionStore(path.join(root, "data"));
  cp = new FakeCheckpoints();
  cp.files.set("Content/Props/SM_Box.uasset", "box v1");
  cp.files.set("Config/DefaultGame.ini", "Speed=1");
  calls = [];
  published = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A session with one user message and its turn begun. */
function sessionWithTurn(text = "Make the box bigger"): StoredSession {
  const s = store.create();
  s.transcript.push({ kind: "user", text, at: "2026-10-24T10:00:00.000Z" });
  s.turn = { start: 0, mutations: 0, targets: [], playtest: false };
  store.save(s);
  return s;
}

const reviewOf = (s: StoredSession): TurnReview | undefined => {
  const e = store.get(s.id)!.transcript.find((t) => t.kind === "review");
  return e?.kind === "review" ? e.review : undefined;
};

/** A turn that changes the box and the config, between the two checkpoints. */
async function reviewedTurn(broker: ReviewBroker): Promise<{ s: StoredSession; review: TurnReview }> {
  const s = sessionWithTurn();
  await broker.turnStarted(s);
  cp.files.set("Content/Props/SM_Box.uasset", "box v2");
  cp.files.set("Config/DefaultGame.ini", "Speed=2");
  cp.files.set("Source/Game/Door.cpp", "int x;");
  await broker.turnEnded(s);
  return { s, review: reviewOf(s)! };
}

describe("the checkpoints around a turn", () => {
  it("checkpoints before and after, turning checkpoints on, and lists each change as an item, grouped", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true, now: () => "2026-10-24T10:01:00.000Z" });
    const { s, review } = await reviewedTurn(broker);
    expect(cp.log.slice(0, 3)).toEqual(["state", "setEnabled true", "create Before: Make the box bigger"]);
    expect(cp.log).toContain("create After: Make the box bigger");
    expect(review.items.map((i) => [i.path, i.status, i.group, i.state])).toEqual([
      ["Config/DefaultGame.ini", "modified", "config", "pending"],
      ["Content/Props/SM_Box.uasset", "modified", "asset", "pending"],
      ["Source/Game/Door.cpp", "added", "source", "pending"],
    ]);
    expect(review.items[1]).toMatchObject({ asset: "/Game/Props/SM_Box.SM_Box", summary: "1 change: Content box v1 to box v2", native: { available: true } });
    expect(review.items[0]).toMatchObject({ summary: "1 line added, 1 removed", native: { available: false } });
    expect(review.items[0].native!.reason).toMatch(/no diff view in Unreal/);
    // The editor is never asked for a picture: the daemon's asset diff carries them.
    expect(calls.filter((c) => c.category === "editor")).toEqual([]);
    expect(store.get(s.id)!.timeline).toEqual([{ checkpoint: review.after, label: "Make the box bigger", at: "2026-10-24T10:01:00.000Z", kind: "turn", turn: 0 }]);
    expect(published.some((p) => p.type === "transcript.added" && p.data?.sessionId === s.id)).toBe(true);
  });

  it("diffs the packages the daemon deferred after the card is posted, updating each summary", async () => {
    cp.assetDiffLimit = 1;
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    cp.files.set("Content/A.uasset", "a");
    cp.files.set("Content/B.uasset", "b");
    cp.unloadable.add("Content/B.uasset");
    await broker.turnEnded(s);
    const review = reviewOf(s)!;
    expect(cp.log.filter((l) => l.startsWith("assetDiff"))).toEqual(["assetDiff Content/B.uasset"]);
    expect(review.items.find((i) => i.path === "Content/A.uasset")).toMatchObject({ summary: "New StaticMesh", native: { available: true } });
    expect(review.items.find((i) => i.path === "Content/B.uasset")).toMatchObject({
      summary: "Could not diff: the package could not be loaded for diff: bad header",
      diffError: "the package could not be loaded for diff: bad header",
      native: { available: false },
    });
    expect(published.filter((p) => p.type === "review.changed" && p.data?.reviewId === review.id).length).toBeGreaterThan(0);
  });

  it("says a package is not diffed when the daemon has no asset diffs", async () => {
    class Legacy extends FakeCheckpoints {
      override async changes(from: string, to?: string) {
        const r = await super.changes(from, to);
        for (const c of r.changes) delete c.assetDiff;
        delete r.assetDiffs;
        return r;
      }
    }
    const legacy = Object.assign(new Legacy(), { assetDiff: undefined, openNativeDiff: undefined, thumbnail: undefined });
    legacy.files = cp.files;
    const broker = new ReviewBroker({ host: hostOf(legacy), store, defaultOn: () => true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    cp.files.set("Content/Props/SM_Box.uasset", "box v2");
    await broker.turnEnded(s);
    const review = reviewOf(s)!;
    const item = review.items.find((i) => i.kind === "package")!;
    expect(item.summary).toBe("Not diffed: this ue-mcp has no asset diffs. Update ue-mcp.");
    expect(item.native).toEqual({ available: false, reason: "This ue-mcp cannot open Unreal's diff. Update ue-mcp." });
    expect(await broker.nativeDiff(s.id, review.id, { path: item.path })).toMatchObject({ status: 409 });
  });

  it("opens Unreal's diff of an item: before and after, or the asset as it is now when the turn added it", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    cp.files.set("Content/Props/SM_Box.uasset", "box v2");
    cp.files.set("Content/Props/SM_New.uasset", "new");
    await broker.turnEnded(s);
    const review = reviewOf(s)!;
    expect(await broker.nativeDiff(s.id, review.id, { path: "Content/Props/SM_Box.uasset" })).toEqual({ opened: "window", windowTitle: "Diff of Content/Props/SM_Box.uasset" });
    expect(await broker.nativeDiff(s.id, review.id, { path: "Content/Props/SM_New.uasset" })).toEqual({ opened: "editor" });
    const before = review.before.replace(/^0+/, "");
    const after = review.after.replace(/^0+/, "");
    expect(cp.log.filter((l) => l.startsWith("openNativeDiff"))).toEqual([
      `openNativeDiff Content/Props/SM_Box.uasset ${before} ${after}`,
      `openNativeDiff Content/Props/SM_New.uasset ${before} current`,
    ]);
    expect(await broker.nativeDiff(s.id, review.id, { path: "Nope" })).toMatchObject({ status: 400 });
  });

  it("serves a version's picture from the daemon, by id", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const file = path.join(root, "thumb.png");
    fs.writeFileSync(file, "png bytes");
    cp.thumbnails.set("c".repeat(40), file);
    expect(broker.thumbnail("c".repeat(40))).toEqual({ type: "image/png", bytes: Buffer.from("png bytes") });
    expect(broker.thumbnail("d".repeat(40))).toBeNull();
    expect(broker.thumbnail("../etc")).toBeNull();
  });

  it("marks a turn that changed nothing on the timeline, with no review card", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    await broker.turnEnded(s);
    expect(reviewOf(s)).toBeUndefined();
    expect(store.get(s.id)!.timeline).toHaveLength(1);
  });

  it("takes no checkpoints with the session's switch off, or the default off", async () => {
    const off = new ReviewBroker({ host: hostOf(), store, defaultOn: () => false });
    const s = sessionWithTurn();
    await off.turnStarted(s);
    await off.turnEnded(s);
    expect(cp.log).toEqual([]);
    const on = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const t = sessionWithTurn();
    t.review = false;
    await on.turnStarted(t);
    expect(cp.log).toEqual([]);
    expect(t.reviewing).toBeNull();
  });

  it("saves the packages the turn left unsaved before its checkpoint after", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    s.turn!.targets.push({ kind: "asset", path: "/Game/Props/SM_Box.SM_Box", saved: false });
    cp.dirty = ["/Game/Props/SM_Box", "/Game/Other/Unrelated"];
    cp.files.set("Content/Props/SM_Box.uasset", "box v2");
    await broker.turnEnded(s);
    expect(calls.filter((c) => c.category === "asset")).toEqual([{ category: "asset", action: "save", args: { assetPaths: ["/Game/Props/SM_Box"] } }]);
    expect(cp.log.filter((l) => l.startsWith("create After"))).toHaveLength(2);
  });

  it("reviews nothing when the daemon has no checkpoints, and says why", async () => {
    const broker = new ReviewBroker({ host: { ...hostOf(), checkpoints: undefined }, store, defaultOn: () => true });
    expect(broker.status()).toEqual({ available: false, reason: NO_CHECKPOINTS, default: true });
    const s = sessionWithTurn();
    await broker.turnStarted(s);
    expect(s.reviewing).toBeNull();
  });

  it("drops Studio's override when the last session turns review off", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => false });
    const s = store.create();
    await broker.setSession(s.id, true);
    expect(cp.log).toEqual([]);
    cp.enabled = true;
    await broker.setSession(s.id, false);
    expect(cp.log).toContain("setEnabled null");
  });
});

describe("Keep and Revert", () => {
  it("reverts one item and leaves the turn's other changes in place, then undoes the revert", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const { s, review } = await reviewedTurn(broker);
    const r = await broker.revert(s.id, review.id, { paths: ["Config/DefaultGame.ini"] });
    expect("review" in r && r.outcome.restored).toEqual(["Config/DefaultGame.ini"]);
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=1");
    expect(cp.files.get("Content/Props/SM_Box.uasset")).toBe("box v2");
    const item = reviewOf(s)!.items.find((i) => i.path === "Config/DefaultGame.ini")!;
    expect(item.state).toBe("reverted");
    expect(store.get(s.id)!.timeline!.at(-1)).toMatchObject({ kind: "restore", label: "Reverted DefaultGame.ini", undo: item.undo });

    const u = await broker.undoRevert(s.id, review.id, { path: "Config/DefaultGame.ini" });
    expect("review" in u).toBe(true);
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=2");
    expect(reviewOf(s)!.items.find((i) => i.path === "Config/DefaultGame.ini")!.state).toBe("pending");
  });

  it("keeps an item without touching the project", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const { s, review } = await reviewedTurn(broker);
    const before = cp.log.length;
    broker.keep(s.id, review.id, { paths: ["Source/Game/Door.cpp"] });
    expect(cp.log.length).toBe(before);
    expect(reviewOf(s)!.items.find((i) => i.path === "Source/Game/Door.cpp")!.state).toBe("kept");
  });

  it("reverts every item at once, deleting what the turn added", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const { s, review } = await reviewedTurn(broker);
    await broker.revert(s.id, review.id, { paths: review.items.map((i) => i.path) });
    expect(cp.files.has("Source/Game/Door.cpp")).toBe(false);
    expect(cp.files.get("Content/Props/SM_Box.uasset")).toBe("box v1");
    expect(reviewOf(s)!.items.every((i) => i.state === "reverted")).toBe(true);
  });

  it("never reverts a file the user edited after the agent without the confirmed force", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const { s, review } = await reviewedTurn(broker);
    cp.editedOutside.add("Config/DefaultGame.ini");
    cp.files.set("Config/DefaultGame.ini", "Speed=9");
    const r = await broker.revert(s.id, review.id, { paths: ["Config/DefaultGame.ini"] });
    expect("outcome" in r && r.outcome.conflicts).toEqual(["Config/DefaultGame.ini"]);
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=9");
    expect(reviewOf(s)!.items.find((i) => i.path === "Config/DefaultGame.ini")).toMatchObject({ state: "pending", conflict: true });

    await broker.revert(s.id, review.id, { paths: ["Config/DefaultGame.ini"], force: true });
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=1");
    expect(reviewOf(s)!.items.find((i) => i.path === "Config/DefaultGame.ini")).toMatchObject({ state: "reverted" });
    expect(reviewOf(s)!.items.find((i) => i.path === "Config/DefaultGame.ini")!.conflict).toBeUndefined();
  });

  it("reads an item's diff from the daemon", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const { s, review } = await reviewedTurn(broker);
    const pkg = await broker.diff(s.id, review.id, "Content/Props/SM_Box.uasset");
    expect("change" in pkg && pkg.change.assetDiff).toMatchObject({ state: "ready", before: { facts: [{ name: "Content", value: "box v1" }] } });
    const d = await broker.diff(s.id, review.id, "Config/DefaultGame.ini");
    expect("change" in d && unifiedLines(d.change.diff!)).toEqual([{ op: "-", text: "Speed=1" }, { op: "+", text: "Speed=2" }]);
    expect(await broker.diff(s.id, review.id, "Nope.txt")).toMatchObject({ status: 404 });
  });
});

describe("the timeline", () => {
  it("restores to a turn's checkpoint, and undoes the restore", async () => {
    const broker = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    const first = sessionWithTurn("first");
    await broker.turnStarted(first);
    cp.files.set("Config/DefaultGame.ini", "Speed=2");
    await broker.turnEnded(first);
    first.transcript.push({ kind: "user", text: "second", at: "2026-10-24T10:05:00.000Z" });
    first.turn = { start: first.transcript.length - 1, mutations: 0, targets: [], playtest: false };
    await broker.turnStarted(first);
    cp.files.set("Config/DefaultGame.ini", "Speed=3");
    await broker.turnEnded(first);

    const marks = store.get(first.id)!.timeline!;
    expect(marks.map((m) => m.label)).toEqual(["first", "second"]);
    const r = await broker.restoreTo(first.id, { checkpoint: marks[0].checkpoint });
    expect("timeline" in r).toBe(true);
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=2");
    const restore = store.get(first.id)!.timeline!.at(-1)!;
    expect(restore).toMatchObject({ kind: "restore", label: "Restored to: first" });

    await broker.undoRestore(first.id, { checkpoint: restore.checkpoint });
    expect(cp.files.get("Config/DefaultGame.ini")).toBe("Speed=3");
    expect(store.get(first.id)!.timeline!.at(-1)!.undone).toBe(true);
    expect(await broker.undoRestore(first.id, { checkpoint: restore.checkpoint })).toMatchObject({ status: 409 });
  });
});

describe("the review model", () => {
  it("maps packages to object paths and groups them", () => {
    expect(assetPathOf("Content/Props/SM_Box.uasset")).toBe("/Game/Props/SM_Box.SM_Box");
    expect(assetPathOf("Plugins/Fx/Content/NS_Spark.uasset")).toBe("/Fx/NS_Spark.NS_Spark");
    expect(assetPathOf("Config/DefaultGame.ini")).toBeUndefined();
    expect(reviewGroupOf({ path: "Content/Maps/L_Main.umap", kind: "package" })).toBe("level");
    expect(reviewGroupOf({ path: "Content/BP_Door.uasset", kind: "package" })).toBe("blueprint");
    expect(reviewGroupOf({ path: "Content/DA_Thing.uasset", kind: "package", blueprintDiff: {} })).toBe("blueprint");
  });

  it("reads a unified diff, with the unchanged lines between hunks as a gap", () => {
    expect(unifiedLines("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10,1 +10,1 @@\n-y\n+z")).toEqual([
      { op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "c" }, { op: "gap", count: 7 }, { op: "-", text: "y" }, { op: "+", text: "z" },
    ]);
  });

  it("puts a material instance's parameter structs in words, and leaves any other value as the engine wrote it", () => {
    const scalar = (name: string, v: string) => `(ParameterInfo=(Name="${name}",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=0F2C4A1B4E6D8C9A00000000AB12CD34)`;
    expect(readableValue(`(${scalar("Roughness", "0.500000")},${scalar("Metallic", "1.000000")})`)).toBe("Roughness = 0.5, Metallic = 1");
    expect(readableValue(scalar("Roughness", "0.250000"))).toBe("Roughness = 0.25");
    expect(readableValue(`((ParameterInfo=(Name="Tint",Association=GlobalParameter,Index=-1),ParameterValue=(R=1.000000,G=0.250000,B=0.000000,A=1.000000),ExpressionGUID=00000000000000000000000000000000))`)).toBe("Tint = (R\u00a01, G\u00a00.25, B\u00a00, A\u00a01)");
    expect(readableValue(`((ParameterInfo=(Name="Albedo",Association=GlobalParameter,Index=-1),ParameterValue="/Script/Engine.Texture2D'/Game/Textures/T_Rock.T_Rock'",ExpressionGUID=00000000000000000000000000000000))`)).toBe("Albedo = /Game/Textures/T_Rock");
    expect(readableValue("(X=1.000000,Y=2.000000,Z=3.000000)")).toBeNull();
    expect(readableValue("600.000000")).toBeNull();
  });

  it("counts a Blueprint variable once when the engine reports it under My Blueprint and again as a class default", () => {
    const d: AssetDiff = {
      state: "ready", status: "modified", assetClass: "Blueprint", summary: "3 differences: Health Default Value 100 to 150; Health 100.000000 to 150.000000; and 1 more",
      nativeDiff: { available: true },
      sections: [
        { category: "My Blueprint", kind: "properties", engineSource: "", entries: [{ group: "Health", path: "Default Value", property: "DefaultValue", diffType: "PropertyValueChanged", displayString: "Default Value", before: "100", after: "150" }] },
        { category: "Defaults", kind: "properties", engineSource: "", entries: [
          { path: "Health", property: "Health", diffType: "PropertyValueChanged", displayString: "Health", before: "100.000000", after: "150.000000" },
          { path: "Walk Speed", property: "WalkSpeed", diffType: "PropertyValueChanged", displayString: "Walk Speed", before: "600.000000", after: "450.000000" },
        ] },
      ],
    };
    const r = refineAssetDiff(d);
    expect(r.sections!.flatMap((s) => s.entries.map((e) => e.path))).toEqual(["Default Value", "Walk Speed"]);
    expect(r.summary).toBe("2 differences: Health Default Value 100 to 150; Walk Speed 600.000000 to 450.000000");
    // A diff with nothing to fold keeps the summary ue-mcp wrote.
    const plain = { ...d, sections: [d.sections![1]] };
    expect(refineAssetDiff(plain)).toBe(plain);
  });

  it("writes the summary again in words when a record's value is a parameter struct", () => {
    const before = `((ParameterInfo=(Name="Roughness",Association=GlobalParameter,Index=-1),ParameterValue=0.500000,ExpressionGUID=00000000000000000000000000000000))`;
    const d: AssetDiff = {
      state: "ready", status: "modified", assetClass: "MaterialInstanceConstant", summary: "1 difference: Scalar Parameter Values ((ParameterInfo=(Name=\"Roughness\",Association=Glo...", nativeDiff: { available: true },
      sections: [{ category: "Details", kind: "properties", engineSource: "", entries: [{ path: "Scalar Parameter Values", property: "ScalarParameterValues", diffType: "PropertyValueChanged", displayString: "", before, after: before.replace("0.500000", "0.800000") }] }],
    };
    expect(refineAssetDiff(d).summary).toBe("1 difference: Scalar Parameter Values Roughness = 0.5 to Roughness = 0.8");
  });
});

// ── With the runner ──────────────────────────────────────────────────

class EditingModel implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<() => ModelTurn>) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(req);
    return this.turns.shift()!();
  }
}

describe("a reviewed turn in the runner", () => {
  it("checkpoints before the model runs and reviews the turn once it ends", async () => {
    const host: AgentHost = {
      projectDir: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      callAction: async (): Promise<ActionResult> => {
        cp.files.set("Config/DefaultGame.ini", "Speed=5");
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, updated: true }) }] };
      },
      editors: (): EditorStatus[] => [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }],
      editorOperation: async (op) => ({ op }),
      events: { publish: () => undefined as never, subscribe: () => () => {} },
      setBusy: () => {},
      log: { info() {}, warn() {} } as never,
    };
    const review = new ReviewBroker({ host: hostOf(), store, defaultOn: () => true });
    let createdBeforeModel = false;
    const model = new EditingModel([
      () => {
        createdBeforeModel = cp.log.some((l) => l.startsWith("create Before"));
        return { content: [{ type: "tool_use", id: "t1", name: "ue_mcp", input: { action: "call", category: "project", method: "set_config", args: {} } } as never], stopReason: "tool_use" };
      },
      () => ({ content: [{ type: "text", text: "Done.", citations: null } as never], stopReason: "end_turn" }),
    ]);
    const runner = new AgentRunner({ host, store, review, provider: () => model, model: () => "m" });
    const s = store.create();
    await runner.send(s.id, "Set the speed");
    const end = Date.now() + 2000;
    while (!reviewOf(s) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(createdBeforeModel).toBe(true);
    expect(reviewOf(s)!.items.map((i) => i.path)).toEqual(["Config/DefaultGame.ini"]);
    expect(store.get(s.id)!.reviewing).toBeNull();
  });
});
