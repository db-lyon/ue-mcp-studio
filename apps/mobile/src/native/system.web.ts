/** system.ts on the web harness and in tests: no splash screen or system bars. */
import type { Theme } from "../ui";
export function hideSplash(): void {}
export function applySystemTheme(_t: Theme): void {}
