import { configDefaults, defineWorkspace } from "vitest/config";

// Two projects: everything as before, and the mobile app's screens, which render
// React Native through react-native-web with the app's own React.
export default defineWorkspace([
  // .claude/worktrees holds agents' own checkouts of this repo, each with its own tests: never this checkout's.
  { extends: "./vitest.config.ts", test: { name: "studio", exclude: [...configDefaults.exclude, "apps/mobile/ui-test/**", ".claude/**"] } },
  "./apps/mobile/vitest.config.ts",
]);
