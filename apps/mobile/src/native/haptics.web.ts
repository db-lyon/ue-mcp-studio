/** haptics.ts on the web harness and in tests: no motor. */
const none = () => undefined;
export const haptic = { tap: none, select: none, success: none, warning: none, error: none };
