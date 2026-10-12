/**
 * What a tool call and the model are told when a turn ends before a call
 * returns: the user pressed Stop, or Studio itself ended the turn (its daemon
 * restarting for an update, say). The words say who did it and what goes on
 * without the turn, so the model does not blame a dropped connection.
 */

/** Who ended a turn: the user's Stop, or Studio, with why in a phrase ("Studio's daemon restarted to install an update"). */
export type Interruption = { by: "user" } | { by: "studio"; why: string };

export const USER_STOP: Interruption = { by: "user" };

interface Call {
  name: string;
  input: Record<string, unknown>;
}

const opOf = (c: Call): string => (c.input.operation === "restart" ? "restart" : "rebuild");
const actionOf = (c: Call): string | null =>
  c.name === "ue_mcp" && c.input.action === "call" ? `${String(c.input.category)}.${String(c.input.method)}` : null;

/** A call in a phrase: "editor_restart (rebuild)", "ue_mcp editor.stop_editor", "a shell command". */
export function describeCall(c: Call): string {
  if (c.name === "editor_restart") return `editor_restart (${opOf(c)})`;
  const action = actionOf(c);
  if (action) return `ue_mcp ${action}`;
  if (c.name === "shell") return "a shell command";
  if (c.name === "agent") return "a subagent";
  return c.name;
}

/** What still happens after the turn lets go of a call that was running. */
function aftermath(c: Call, cause: Interruption): string {
  if (c.name === "editor_restart") {
    return cause.by === "user"
      ? `Studio stopped waiting for it, but the ${opOf(c)} goes on in the daemon: the editor may still be stopping, building or starting.`
      : `The ${opOf(c)} may or may not have finished: check the editor's state.`;
  }
  const action = actionOf(c);
  if (action) {
    return cause.by === "user"
      ? `The editor finishes ${action} regardless, so it may have taken effect: read the state back before running it again.`
      : "It may or may not have taken effect: read the state back before running it again.";
  }
  if (c.name === "shell") return cause.by === "user" ? "The command was ended." : "The command may or may not have finished.";
  return "";
}

/** The result a call gets when its turn ends under it. `ran` is false for a call that never started (queued, or waiting for approval). */
export function interruptedResult(c: Call, cause: Interruption, ran = true): string {
  if (!ran) return cause.by === "user" ? "Stopped by the user before this ran." : `Not run: ${cause.why} before it started.`;
  const head = cause.by === "user" ? "Stopped by the user while this was running." : `Interrupted: ${cause.why} while this ran, so its result never came back.`;
  return [head, aftermath(c, cause)].filter(Boolean).join(" ");
}

/** The note the model gets with the next message, saying how its last turn ended. */
export function interruptionNote(running: Call[], cause: Interruption): string {
  const calls = running.map(describeCall);
  const list = calls.length === 0 ? "" : calls.length === 1 ? calls[0] : `${calls.slice(0, -1).join(", ")} and ${calls[calls.length - 1]}`;
  const restart = running.find((c) => c.name === "editor_restart");
  if (cause.by === "user") {
    return [
      "The user pressed Stop during your last turn, which ended it.",
      list ? `${list} ${calls.length === 1 ? "was" : "were"} running.` : "",
      restart ? `The ${opOf(restart)} goes on in the daemon after a Stop, so the editor may be stopping, building or starting now.` : "",
      "Any tool result that says it was interrupted was cut off by that Stop: no connection dropped and nothing restarted. Check the current state before going on.",
    ].filter(Boolean).join(" ");
  }
  return [
    `Your last turn ended because ${cause.why}.`,
    list ? `${list} never returned a result.` : "",
    "Nothing failed in the editor or the connection. Check the current state before going on.",
  ].filter(Boolean).join(" ");
}
