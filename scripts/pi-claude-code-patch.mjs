// One change to pi-claude-code at its pinned commit, applied where it is loaded
// (the agent bundle and the tests), never to the files on disk.
//
// Every pi-ai API hands its request body to `options.onPayload` before it is
// sent, which is how Pi Durable's beforeProviderRequest hooks reach it, and how
// Studio adds the provider's own web search. pi-claude-code builds the body
// Claude Code sends (its extra body) and does not call onPayload, so this makes
// it do so, as every other API does. When the pinned source no longer has the
// line this keys on, the build fails here rather than shipping without it.
import * as path from "node:path";

const ANCHOR = "      const translator = new EventTranslator(model, output, stream);";
const PATCHED =
  "      const shaped = await options?.onPayload?.(extraBody, model);\n"
  + "      if (shaped && typeof shaped === \"object\" && shaped !== extraBody) Object.assign(extraBody, shaped);\n"
  + ANCHOR;

/** Whether `file` is pi-claude-code's stream module. */
export function isClaudeCodeStream(file) {
  const f = file.split(path.sep).join("/");
  return /\/pi-claude-code\/src\/stream\.ts$/.test(f);
}

/** pi-claude-code's stream module with onPayload called on the request body. */
export function patchClaudeCodeStream(source) {
  if (source.includes(PATCHED)) return source;
  const at = source.indexOf(ANCHOR);
  if (at < 0 || source.indexOf(ANCHOR, at + 1) >= 0) {
    throw new Error("pi-claude-code's stream.ts changed: update scripts/pi-claude-code-patch.mjs for the new pin");
  }
  return source.replace(ANCHOR, PATCHED);
}
