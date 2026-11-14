/**
 * How a subagent is given the user's message from its thread: as the user
 * speaking, to be answered with the reply tool at once (or, in a host from
 * before the reply tool, as visible text), and how the runtime's prompt hook
 * counts the messages it took in.
 */
import { describe, expect, it } from "vitest";
import { REPLY_TOOL, SUBAGENT_MESSAGES_LINE, SUBAGENT_MESSAGE_PREFIX, messagesIn, toSubagent } from "../src/subagent-inbox.js";
import { toolOptions } from "../src/subscription.js";

describe("the user's message to a subagent", () => {
  it("is the user's own turn, answered at once with the reply tool, and stop means stop", () => {
    expect(SUBAGENT_MESSAGES_LINE).toContain("treat it as the user's own turn");
    expect(SUBAGENT_MESSAGES_LINE).toContain("answer every such message at once with the reply tool, before any other tool call");
    expect(SUBAGENT_MESSAGES_LINE).toContain("When the user tells you to stop, stop: call no more tools");
    expect(SUBAGENT_MESSAGES_LINE).toContain("cannot see your thinking");
    // No longer left for a report the user reads only at the end.
    expect(SUBAGENT_MESSAGES_LINE).not.toContain("say in your report what you did about it");
    const m = toSubagent(["make it red", " and taller "]);
    expect(m.startsWith(SUBAGENT_MESSAGE_PREFIX)).toBe(true);
    expect(m).toContain("Answer them with the reply tool before anything else");
    expect(m.endsWith("make it red\n\nand taller")).toBe(true);
  });

  it("asks a subagent in an older host, without the reply tool, for a visible text answer", () => {
    const m = toSubagent(["uh hello?"], false);
    expect(m.startsWith(SUBAGENT_MESSAGE_PREFIX)).toBe(true);
    expect(m).toContain("uh hello?");
    expect(m).toContain("your next message must begin with a text block addressed to them");
    expect(m).not.toContain("reply tool");
  });

  it("counts the messages in a prompt the runtime took in, and nothing in the task itself", () => {
    expect(messagesIn(toSubagent(["a"]))).toBe(1);
    expect(messagesIn(`${toSubagent(["a"])}\n\n${toSubagent(["b"])}`)).toBe(2);
    expect(messagesIn("Build the door. Use oak.")).toBe(0);
  });

  it("gives the reply tool to a subagent on every route, whatever a helper's file allows", () => {
    expect(REPLY_TOOL.name).toBe("reply");
    expect(REPLY_TOOL.input_schema.required).toEqual(["text"]);
    expect(toolOptions({ agent: false, reply: true, allowed: ["read_file"], skills: false }).allowedTools).toEqual(["mcp__studio__read_file", "mcp__studio__reply"]);
    // The main agent has none.
    expect(toolOptions({ agent: true, skills: false }).allowedTools).not.toContain("mcp__studio__reply");
  });
});
