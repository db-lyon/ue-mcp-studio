/**
 * In a release build React Native treats an uncaught JS error (an event
 * handler, a timer, a promise callback) as fatal and closes the app. Studio
 * logs it and keeps running instead: the screen that failed shows its own
 * error, and the connection and everything else go on. Development builds
 * keep the default red screen.
 */
type Handler = (error: unknown, isFatal?: boolean) => void;
const g = globalThis as { ErrorUtils?: { setGlobalHandler(h: Handler): void }; __DEV__?: boolean };

export function keepAliveOnErrors(): boolean {
  if (!g.ErrorUtils || g.__DEV__) return false;
  g.ErrorUtils.setGlobalHandler((error, isFatal) => {
    console.error(isFatal ? "Uncaught error; Studio kept running" : "Uncaught error", error);
  });
  return true;
}
