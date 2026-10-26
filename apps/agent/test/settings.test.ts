import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";

const store = () => ((d) => new SettingsStore(d, path.join(d, "keys")))(fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-")));

describe("theme setting", () => {
  it("defaults to the ue-mcp look", () => {
    expect(store().view().theme).toBe("ue-mcp");
  });

  it("keeps a chosen theme without touching the model settings", () => {
    const s = store();
    s.update({ model: "claude-sonnet-5-5" });
    s.update({ theme: "editor" });
    expect(s.view()).toMatchObject({ theme: "editor", model: "claude-sonnet-5-5" });
  });

  it("refuses an unknown theme", () => {
    expect(() => store().update({ theme: "neon" as never })).toThrow(/theme must be one of/);
  });
});

describe("asking before changes", () => {
  it("is on until the user turns it off, and kept apart from the model settings", () => {
    const s = store();
    expect(s.askBeforeChanges()).toBe(true);
    s.update({ model: "claude-sonnet-5-5" });
    expect(s.askBeforeChanges()).toBe(true);
    s.update({ askBeforeChanges: false });
    expect(s.view()).toMatchObject({ askBeforeChanges: false, model: "claude-sonnet-5-5" });
    expect(() => s.update({ askBeforeChanges: "no" as never })).toThrow(/must be a boolean/);
  });
});

describe("providers", () => {
  it("starts on a Claude model", () => {
    expect(store().view()).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("reads settings written before vendors were named as Claude, which is all they ran", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-"));
    const s = new SettingsStore(dir, path.join(dir, "keys"));
    for (const provider of ["byok", "gateway", "studio"]) {
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ provider, model: "claude-sonnet-5-5" }));
      expect(s.view()).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    }
  });

  it("keeps a chosen OpenAI or Google model", () => {
    const s = store();
    s.update({ provider: "google", model: "gemini-3.8-flash" });
    expect(s.view()).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
  });

  it("keeps the signed-in login and forgets it on sign-out", () => {
    const s = store();
    s.signIn("uemcp_tok", "octo");
    expect([s.accountToken(), s.accountLogin()]).toEqual(["uemcp_tok", "octo"]);
    s.update({ signOut: "studio" });
    expect([s.accountToken(), s.accountLogin()]).toEqual([null, null]);
  });
});

describe("the dialog policy", () => {
  it("defaults to asking, then letting the agent decide after 2 minutes", () => {
    expect(store().dialogPolicy()).toEqual({ kind: "agent", minutes: 2 });
  });

  it("keeps each policy for the project", () => {
    const s = store();
    s.update({ dialogPolicy: { kind: "safe", minutes: 5 } });
    expect(s.view().dialogPolicy).toEqual({ kind: "safe", minutes: 5 });
    s.update({ dialogPolicy: { kind: "wait" } });
    expect(s.dialogPolicy()).toEqual({ kind: "wait" });
  });

  it("refuses a policy it cannot run", () => {
    expect(() => store().update({ dialogPolicy: { kind: "agent", minutes: 0 } })).toThrow(/dialogPolicy/);
    expect(() => store().update({ dialogPolicy: { kind: "soon" } as never })).toThrow(/dialogPolicy/);
  });

  it("uses one vendor key for every project, and a project's older key until a new one is entered", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-keys-"));
    const keys = path.join(root, "keys");
    const a = new SettingsStore(path.join(root, "a"), keys);
    const b = new SettingsStore(path.join(root, "b"), keys);
    fs.writeFileSync(path.join(root, "b", "openai.key"), "sk-old");
    expect(b.key("openai")).toBe("sk-old");
    a.update({ keys: { openai: "sk-new" } });
    expect(a.key("openai")).toBe("sk-new");
    expect(b.key("openai")).toBe("sk-new");
    b.update({ keys: { openai: "" } });
    expect(b.key("openai")).toBeNull();
    expect(a.key("openai")).toBeNull();
    expect(fs.existsSync(path.join(root, "b", "openai.key"))).toBe(false);
  });
});

describe("usage settings", () => {
  it("start with subagents only when asked, CLAUDE.md on, standard images", () => {
    expect(store().view().usage).toEqual(DEFAULT_USAGE);
    expect(DEFAULT_USAGE).toMatchObject({ subagents: "asked", subagentsPerTurn: 4, projectInstructions: true, imageSize: "standard" });
  });

  it("change only the fields given", () => {
    const s = store();
    s.update({ usage: { subagents: "off" } });
    s.update({ usage: { imageSize: "small" } });
    expect(s.usage()).toMatchObject({ subagents: "off", imageSize: "small", subagentsPerTurn: 4 });
  });

  it("refuse values out of range", () => {
    const s = store();
    expect(() => s.update({ usage: { subagents: "always" as never } })).toThrow(/usage.subagents/);
    expect(() => s.update({ usage: { subagentsPerTurn: 0 } })).toThrow(/usage.subagentsPerTurn/);
    expect(() => s.update({ usage: { subagentsPerTurn: 17 } })).toThrow(/usage.subagentsPerTurn/);
    expect(() => s.update({ usage: { imageSize: "huge" as never } })).toThrow(/usage.imageSize/);
    expect(() => s.update({ usage: { subagentEffort: "extreme" as never } })).toThrow(/usage.subagentEffort/);
    expect(s.usage()).toEqual(DEFAULT_USAGE);
  });

  it("read a bad stored field as its default and keep the rest", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-"));
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ usage: { subagents: "nope", imageSize: "small", subagentsPerTurn: 99 } }));
    expect(new SettingsStore(d, path.join(d, "keys")).usage()).toEqual({ ...DEFAULT_USAGE, imageSize: "small" });
  });

  it("run subagents on their own model only while it is of the chat model's vendor", () => {
    const s = store();
    s.update({ provider: "anthropic", model: "claude-opus-5-5", usage: { subagentModel: { provider: "anthropic", model: "claude-haiku-5-5" } } });
    expect(s.subagentModel()).toBe("claude-haiku-5-5");
    s.update({ provider: "openai", model: "gpt-6" });
    expect(s.subagentModel()).toBe("gpt-6");
    s.update({ usage: { subagentModel: null } });
    expect(s.subagentModel()).toBe("gpt-6");
  });
});
