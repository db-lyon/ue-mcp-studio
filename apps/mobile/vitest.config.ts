// Component tests for the app's screens: React Native rendered through
// react-native-web in jsdom, with the native modules replaced by ui-test/mocks.
// The app's own React (19) is used throughout, not the web client's.
import * as path from "node:path";
import { defineConfig } from "vitest/config";

const here = __dirname;
const root = path.resolve(here, "../..");
const mod = (name: string) => path.join(here, "node_modules", name);
const mock = (name: string) => path.join(here, "ui-test/mocks", name);

export default defineConfig({
  root: here,
  resolve: {
    // The app's web variants (src/native/*.web.ts) stand in for native modules here, as on the web harness.
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".json"],
    alias: [
      // react-native-web, failing where Android fails: text outside <Text>, an accessibilityRole Android rejects.
      { find: /^react-native$/, replacement: mock("react-native.tsx") },
      // The ESM build, so its own imports of react-dom go through the aliases below.
      { find: "@testing-library/react", replacement: path.join(root, "node_modules/@testing-library/react/dist/@testing-library/react.esm.js") },
      { find: /^react$/, replacement: mod("react") },
      { find: /^react\/(.*)$/, replacement: `${mod("react")}/$1` },
      { find: /^react-dom$/, replacement: mod("react-dom") },
      { find: /^react-dom\/(.*)$/, replacement: `${mod("react-dom")}/$1` },
      { find: /^react-native-svg$/, replacement: mod("react-native-svg/lib/module/elements.web.js") },
      { find: "@react-native/assets-registry/registry", replacement: mock("assets-registry.ts") },
      // Android only: the touch sound the web build never plays.
      { find: /fabric\/NativeSvgSoundModule(\.js)?$/, replacement: mock("svg-sound.ts") },
      { find: /^expo-secure-store$/, replacement: mock("secure-store.ts") },
      { find: /^expo-camera$/, replacement: mock("camera.tsx") },
      { find: /^expo-crypto$/, replacement: mock("crypto.ts") },
      { find: /^expo-(constants|application)$/, replacement: mock("expo-modules.ts") },
      { find: /^expo-clipboard$/, replacement: mock("clipboard.ts") },
      { find: /^expo-font$/, replacement: mock("expo-font.ts") },
      { find: new RegExp("^@expo-google-fonts/.*$"), replacement: mock("google-fonts.ts") },
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^react-native-svg$/, replacement: mock("svg.tsx") },
      { find: /^expo-image-picker$/, replacement: mock("image-picker.ts") },
      { find: /^expo-document-picker$/, replacement: mock("document-picker.ts") },
      { find: /^expo-clipboard$/, replacement: mock("clipboard.ts") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  test: {
    name: "mobile-ui",
    environment: "jsdom",
    include: ["ui-test/**/*.test.tsx"],
    setupFiles: ["ui-test/setup.ts"],
    server: { deps: { inline: [/react-native-web/, /react-native-svg/, /@testing-library/] } },
  },
});
