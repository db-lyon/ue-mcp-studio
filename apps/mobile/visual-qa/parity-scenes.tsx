/**
 * Each client-web visual QA scenario in this app's area, and how the app shows
 * the same state: the screen to draw, and what to press or scroll to once it
 * settles (testIDs, the app's counterpart of the web scenario's selectors).
 */
import type { ReactNode } from "react";
import { PluginsScreen } from "../src/screens/plugins/PluginsScreen";

export interface ParityScene {
  render(): ReactNode;
  /** testIDs pressed one after another once the screen settles. */
  clicks?: string[];
  /** A testID scrolled to the top of its scroller after the clicks. */
  scroll?: string;
  /** Typed into a testID's field. */
  type?: { into: string; text: string };
}

export const PARITY: Record<string, ParityScene> = {
  "plugins-remote": { render: () => <PluginsScreen /> },
};
