// The states scripts/visual-parity-mobile.mjs compares, one module per area of the app.
//
// A pair: { name, web: { scenario, clip?, clicks?, focus? }, mobile: { scene?, clip?, presses? }, height? }.
// `web.clip` is a CSS selector in the web client, `mobile.clip` a testID in the app; the scene
// defaults to the pair's name. `presses` are texts (or label=<accessibility label>) pressed in order.
import { PLAYTEST_PAIRS } from "./visual-parity/playtests.mjs";
import { GIT_PAIRS } from "./visual-parity/git.mjs";
import { EDITOR_PAIRS } from "./visual-parity/editor.mjs";
import { FLOW_PAIRS } from "./visual-parity/flows.mjs";

export const PAIRS = [...PLAYTEST_PAIRS, ...GIT_PAIRS, ...EDITOR_PAIRS, ...FLOW_PAIRS];
