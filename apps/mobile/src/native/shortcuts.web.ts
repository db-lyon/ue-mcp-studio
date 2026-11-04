/** shortcuts.ts on the web harness and in tests: no app icon to long-press. */
export interface ShortcutTarget {
  deviceId: string;
  sessionId: string;
}
export function publishRecentSessions(): void {}
export function useShortcutTarget(_open: (t: ShortcutTarget) => void): void {}
