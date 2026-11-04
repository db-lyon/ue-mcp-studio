// Every parity scene by name, one module per area of the app.
import type { ReactNode } from "react";
import { PLAYTEST_SCENES } from "./playtests";

export const SCENES: Record<string, () => ReactNode> = {
  ...PLAYTEST_SCENES,
};
