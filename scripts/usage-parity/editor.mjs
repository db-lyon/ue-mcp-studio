/**
 * The editor side of the measurement: a ue-mcp client, the baseline level the
 * prompts run in, the reset between runs, and the checks that say whether a
 * run did its task. Everything goes through ue-mcp's gateway, as both clients'
 * calls do.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BASE_LEVEL = "/Game/AB/L_ABBase";
export const WORK_LEVEL = "/Game/ABWork/L_Work";

export async function connect(repo, ueMcp, uproject) {
  const sdk = path.join(repo, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
  const { Client } = await import(pathToFileURL(path.join(sdk, "index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "stdio.js")).href);
  const c = new Client({ name: "usage-parity-tools", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [ueMcp, uproject], stderr: "ignore" }));
  const raw = async (args) => {
    const r = await c.callTool({ name: "tools", arguments: args }, undefined, { timeout: 600000 });
    return r.content.map((x) => x.text ?? `[${x.type}]`).join("");
  };
  const call = async (category, method, args = {}) => {
    const text = await raw({ action: "call", category, method, args });
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };
  return { raw, call, close: () => c.close() };
}

/** The editor must already be running on this project: the runner never starts or stops one. */
export async function preflight(u, uproject) {
  const s = await u.call("project", "get_status", {});
  if (s.editorConnected !== true) throw new Error(`No editor is connected for ${uproject}. Start it yourself first; this runner never starts an editor.`);
  const open = s.editorTarget?.projectPath ?? s.project?.path ?? "";
  if (path.resolve(open).toLowerCase() !== path.resolve(uproject).toLowerCase()) throw new Error(`The connected editor has ${open || "an unknown project"} open, not ${uproject}.`);
  return s;
}

/** The level the prompts start from: a floor, a sun, a sky light, an atmosphere and a player start. */
export async function ensureBaseline(u, work) {
  const baseFile = path.join(work, "base.json");
  const exists = ((await u.call("asset", "list", { directory: "/Game/AB", recursive: true })).assets ?? []).some((a) => a.path.startsWith(BASE_LEVEL));
  if (!exists) {
    await u.call("level", "create", { levelPath: BASE_LEVEL, onConflict: "replace", worldPartition: false });
    await u.call("level", "place_actor", { actorClass: "StaticMeshActor", label: "Floor", staticMesh: "/Engine/BasicShapes/Cube.Cube", location: { x: 0, y: 0, z: -5 }, scale: { x: 20, y: 20, z: 0.1 } });
    await u.call("level", "place_actor", { actorClass: "DirectionalLight", label: "Sun", location: { x: 0, y: 0, z: 1000 }, rotation: { pitch: -45, yaw: 30, roll: 0 } });
    await u.call("level", "place_actor", { actorClass: "SkyLight", label: "Sky", location: { x: 0, y: 0, z: 800 } });
    await u.call("level", "place_actor", { actorClass: "SkyAtmosphere", label: "Atmosphere" });
    await u.call("level", "place_actor", { actorClass: "PlayerStart", label: "PlayerStart", location: { x: -500, y: 0, z: 100 } });
    await u.call("level", "save", {});
  } else {
    await u.call("level", "load", { levelPath: BASE_LEVEL, discardUnsaved: true });
  }
  const o = await u.call("level", "get_outliner", {});
  fs.writeFileSync(baseFile, JSON.stringify(o.actors.map((a) => a.label)));
  return o.actors.map((a) => a.label);
}

/** Back to the baseline: the work level open with only the baseline's actors, nothing else under /Game/ABWork. */
export async function reset(u, base) {
  let load = await u.call("level", "load", { levelPath: WORK_LEVEL, discardUnsaved: true });
  if (load.success === false || load.raw) {
    await u.call("level", "load", { levelPath: BASE_LEVEL, discardUnsaved: true });
    await u.call("asset", "duplicate", { sourcePath: BASE_LEVEL, destinationPath: WORK_LEVEL });
    load = await u.call("level", "load", { levelPath: WORK_LEVEL, discardUnsaved: true });
  }
  let o = await u.call("level", "get_outliner", {});
  const extra = o.actors.filter((a) => !base.includes(a.label));
  for (const a of extra) await u.call("level", "delete_actor", { actorPath: a.path });
  await u.call("level", "save", {});
  const stray = ((await u.call("asset", "list", { directory: "/Game/ABWork", recursive: true })).assets ?? []).map((a) => a.path).filter((p) => !p.startsWith(WORK_LEVEL));
  if (stray.length) await u.call("asset", "delete_batch", { assetPaths: stray, force: true });
  o = await u.call("level", "get_outliner", {});
  const left = ((await u.call("asset", "list", { directory: "/Game/ABWork", recursive: true })).assets ?? []).map((a) => a.path);
  const ok = o.worldName === "L_Work" && o.actors.length === base.length && o.actors.every((a) => base.includes(a.label)) && left.length === 1;
  if (!ok) throw new Error(`reset failed: world ${o.worldName}, ${o.actors.length} actors, assets ${left.join(",")}`);
}

/** Whether the run did its task, read back from the editor and the final answer. */
export async function verify(u, base, pid, text) {
  const checks = [];
  const check = (name, ok, got) => checks.push({ name, ok: !!ok, ...(ok ? {} : { got }) });
  const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;
  const at = (loc, x, y, z) => loc && near(loc.x, x) && near(loc.y, y) && near(loc.z, z);
  const color = (s) => {
    const m = /B=(\d+),G=(\d+),R=(\d+)/.exec(s ?? "");
    return m ? { r: +m[3], g: +m[2], b: +m[1] } : null;
  };
  const o = await u.call("level", "get_outliner", {});
  const extra = (o.actors ?? []).filter((a) => !base.includes(a.label));
  const byLabel = (l) => extra.find((a) => a.label === l);
  const comp = async (label, props) => (await u.call("level", "get_component_details", { actorLabel: label, propertyNames: props, includeValues: true })).components ?? [];
  const dirty = JSON.stringify(await u.call("editor", "list_dirty_packages", {}));
  const saved = !/ABWork/.test(dirty);
  check("world is L_Work", o.worldName === "L_Work", o.worldName);
  if (pid === "A") {
    const k = byLabel("KeyLight");
    check("KeyLight is a PointLight", k?.class === "PointLight", k?.class);
    check("KeyLight at (200,0,300)", at(k?.location, 200, 0, 300), k?.location);
    const lc = (await comp("KeyLight", ["Intensity", "LightColor"])).find((c) => /LightComponent/.test(c.class));
    check("intensity 5000", near(lc?.values?.Intensity, 5000), lc?.values?.Intensity);
    const c = color(lc?.values?.LightColor);
    check("warm orange", c && c.r >= 200 && c.r > c.g && c.g > c.b, lc?.values?.LightColor);
    check("only KeyLight added", extra.length === 1, extra.map((a) => a.label));
    check("saved", saved, dirty.slice(0, 300));
  }
  if (pid === "B") {
    check("no actors added", extra.length === 0, extra.map((a) => a.label));
    const assets = (await u.call("asset", "list", { directory: "/Game/ABWork", recursive: true })).assets ?? [];
    check("no assets added", assets.length === 1, assets.map((a) => a.path));
    check("answer names the open level", /L_Work/.test(text), null);
    check("answer names materials", /\bM_\w+/.test(text), null);
    check("answer names actor classes", /StaticMeshActor/.test(text) && /DirectionalLight|SkyLight/.test(text), null);
  }
  if (pid === "C") {
    const assets = ((await u.call("asset", "list", { directory: "/Game/ABWork", recursive: true })).assets ?? []).map((a) => a.path);
    check("M_Glow exists", assets.some((p) => /\/M_Glow(\.|$)/.test(p)), assets);
    check("BP_GlowCube exists", assets.some((p) => /BP_GlowCube/.test(p)), assets);
    const sm = await u.call("asset", "read_properties", { assetPath: "/Game/ABWork/M_Glow", propertyName: "ShadingModel" });
    check("M_Glow unlit", /Unlit/i.test(JSON.stringify(sm)), JSON.stringify(sm).slice(0, 200));
    const inst = extra.filter((a) => /GlowCube/.test(a.class ?? "") || /GlowCube/.test(a.label));
    const xs = inst.map((a) => Math.round(a.location?.x)).sort((a, b) => a - b);
    check("three instances", inst.length === 3, inst.map((a) => a.label));
    check("at x 0/300/600 y0 z100", inst.length === 3 && [0, 300, 600].every((x, i) => xs[i] === x) && inst.every((a) => near(a.location.y, 0) && near(a.location.z, 100)), inst.map((a) => a.location));
    if (inst[0]) {
      const cs = await comp(inst[0].label, ["StaticMesh", "OverrideMaterials", "Intensity"]);
      const mesh = cs.find((c) => c.class === "StaticMeshComponent");
      check("cube mesh", /Cube/.test(JSON.stringify(mesh?.values)), mesh?.values);
      const light = cs.find((c) => /PointLightComponent/.test(c.class));
      check("point light component above cube", light && light.relativeLocation?.z > 0, light?.relativeLocation);
      const glow = /M_Glow/.test(JSON.stringify(mesh?.values))
        || /M_Glow/.test(JSON.stringify(await u.call("blueprint", "read_component_properties", { assetPath: "/Game/ABWork/BP_GlowCube", componentName: mesh?.name ?? "" })));
      check("M_Glow on the cube", glow, JSON.stringify(mesh?.values).slice(0, 200));
    }
    check("saved", saved, dirty.slice(0, 300));
  }
  if (pid === "D") {
    for (const [l, x, mesh] of [["Pillar_1", -300, /Cylinder/], ["Pillar_2", 0, /Cube/], ["Pillar_3", 300, /Cylinder/]]) {
      const a = byLabel(l);
      check(`${l} at (${x},0,50)`, at(a?.location, x, 0, 50), a?.location);
      const m = (await comp(l, ["StaticMesh"])).find((c) => c.class === "StaticMeshComponent");
      check(`${l} mesh ${mesh}`, mesh.test(JSON.stringify(m?.values)), m?.values);
    }
    const d = await u.call("level", "get_actor_details", { actorLabel: "Pillar_2" });
    check("Pillar_2 scale (1,1,3)", at(d.scale, 1, 1, 3), d.scale);
    const pl = byLabel("PillarLight");
    check("PillarLight at (0,0,600)", at(pl?.location, 0, 0, 600), pl?.location);
    const lc = (await comp("PillarLight", ["Intensity"])).find((c) => /LightComponent/.test(c.class));
    check("PillarLight intensity 6000", near(lc?.values?.Intensity, 6000), lc?.values?.Intensity);
    check("four actors added", extra.length === 4, extra.map((a) => a.label));
    check("saved", saved, dirty.slice(0, 300));
  }
  if (pid === "E") {
    check("no actors added", extra.length === 0, extra.map((a) => a.label));
    check("answer describes the scene", /floor|ground|plane/i.test(text) && /light|sun|shadow/i.test(text), text.slice(0, 200));
  }
  return { ok: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok) };
}

/** Remove the levels the runs used, after loading the level that was open before. */
export async function cleanup(u, openBefore) {
  if (openBefore) await u.call("level", "load", { levelPath: openBefore, discardUnsaved: true });
  const paths = [];
  for (const dir of ["/Game/ABWork", "/Game/AB"]) for (const a of (await u.call("asset", "list", { directory: dir, recursive: true })).assets ?? []) paths.push(a.path);
  if (paths.length) await u.call("asset", "delete_batch", { assetPaths: paths, force: true });
}
