// Every parity scene by name, one module per area of the app.
import type { ReactNode } from "react";
import { PLAYTEST_SCENES } from "./playtests";
import { GIT_SCENES } from "./git";
import { EDITOR_SCENES } from "./editor";
import { FLOW_SCENES } from "./flows";

export const SCENES: Record<string, () => ReactNode> = {
  ...PLAYTEST_SCENES,
  ...GIT_SCENES,
  ...EDITOR_SCENES,
  ...FLOW_SCENES,
};
