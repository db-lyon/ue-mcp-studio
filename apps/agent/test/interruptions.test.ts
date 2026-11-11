import { describe, expect, it } from "vitest";
import { USER_SENT, USER_STOP, describeCall, interruptedResult, interruptionLine, interruptionNote } from "../src/interruptions.js";

const rebuild = { name: "editor_restart", input: { operation: "rebuild", reason: "C++" } };
const python = { name: "ue_mcp", input: { action: "call", category: "editor", method: "execute_python" } };
const shell = { name: "shell", input: { command: "tasklist" } };
const daemon = { by: "studio" as const, why: "Studio's daemon restarted to install an update" };

describe("what an interrupted call is told", () => {
  it("a Stop names the user, and says a rebuild or an editor call goes on without the turn", () => {
    expect(interruptedResult(rebuild, USER_STOP)).toBe(
      "Stopped by the user while this was running. Studio stopped waiting for it, but the rebuild goes on in the daemon: the editor may still be stopping, building or starting.",
    );
    expect(interruptedResult(python, USER_STOP)).toMatch(/The editor finishes editor.execute_python regardless/);
    expect(interruptedResult(shell, USER_STOP)).toMatch(/The command was ended/);
    expect(interruptedResult(shell, USER_STOP, false)).toBe("Stopped by the user before this ran.");
  });

  it("Studio's own interruption never says the user did it", () => {
    for (const c of [rebuild, python, shell]) {
      const text = interruptedResult(c, daemon);
      expect(text).toMatch(/^Interrupted: Studio's daemon restarted to install an update while this ran/);
      expect(text).not.toMatch(/user/);
    }
    expect(interruptedResult(shell, daemon, false)).toBe("Not run: Studio's daemon restarted to install an update before it started.");
  });
});

describe("the note for the model's next message", () => {
  it("after a Stop: what was running, what goes on, and that nothing dropped", () => {
    const note = interruptionNote([rebuild, shell], USER_STOP);
    expect(note).toBe(
      "The user pressed Stop during your last turn, which ended it. editor_restart (rebuild) and a shell command were running. "
      + "The rebuild goes on in the daemon after a Stop, so the editor may be stopping, building or starting now. "
      + "A tool result that says the call was interrupted or rejected means that Stop: nothing refused the call, no connection dropped and nothing restarted. Check the current state before going on.",
    );
  });

  it("after Studio ended the turn: why, and that nothing failed", () => {
    expect(interruptionNote([python], daemon)).toBe(
      "Your last turn ended because Studio's daemon restarted to install an update. ue_mcp editor.execute_python never returned a result. "
      + "Nothing failed in the editor or the connection. Check the current state before going on.",
    );
  });

  it("names calls plainly", () => {
    expect([rebuild, python, shell, { name: "read_file", input: {} }].map(describeCall)).toEqual(["editor_restart (rebuild)", "ue_mcp editor.execute_python", "a shell command", "read_file"]);
  });
});

describe("a note that starts with a plain call", () => {
  it("starts the sentence with a capital", () => {
    expect(interruptionNote([shell], { by: "studio", why: "the user chose Restart now to install an update" })).toMatch(/update\. A shell command never returned a result\./);
  });
});

describe("what the transcript shows when a turn ends", () => {
  it("shows nothing for the user's own Stop or Send now, and one line for a turn Studio ended", () => {
    expect(interruptionLine(USER_STOP)).toBeNull();
    expect(interruptionLine(USER_SENT)).toBeNull();
    expect(interruptionLine({ by: "studio", why: "Studio's daemon restarted to install an update" })).toBe("Turn ended: Studio's daemon restarted to install an update.");
  });

  it("tells the model a new message ended the turn, not a Stop", () => {
    const note = interruptionNote([{ name: "editor_restart", input: { operation: "rebuild" } }], USER_SENT);
    expect(note.startsWith("The user sent a new message during your last turn, which ended it. editor_restart (rebuild) was running.")).toBe(true);
    expect(note).not.toMatch(/Stop/);
    expect(interruptedResult({ name: "shell", input: {} }, USER_SENT)).toMatch(/^Ended by the user's new message while this was running./);
  });
});
