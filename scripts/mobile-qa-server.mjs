// The Vite server for the mobile app's visual QA page (apps/mobile/visual-qa): the app's own
// screens through react-native-web, its native modules replaced by ui-test/mocks, and the
// fixture pictures. scripts/parity-mobile.mjs and scripts/parity-cards-mobile.mjs serve from it.
import * as path from "node:path";
import { pictures } from "./visual-qa-pictures.mjs";

export async function mobileQaServer(root) {
  const { createServer } = await import("vite");
  const app = path.join(root, "apps", "mobile");
  const mod = (name) => path.join(app, "node_modules", name);
  const mock = (name) => path.join(app, "ui-test", "mocks", name);
  return createServer({
    root: path.join(app, "visual-qa"),
    configFile: false,
    logLevel: "warn",
    plugins: [pictures],
    server: { port: 0, strictPort: false, fs: { allow: [root] } },
    define: { __DEV__: "false", "process.env.NODE_ENV": JSON.stringify("development"), "process.env.EXPO_OS": JSON.stringify("android") },
    esbuild: { jsx: "automatic" },
    resolve: {
      extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".json"],
      alias: [
        { find: /^react-native$/, replacement: path.join(root, "node_modules/react-native-web/dist/index.js") },
        { find: /^react$/, replacement: mod("react") },
        { find: /^react\/(.*)$/, replacement: `${mod("react")}/$1` },
        { find: /^react-dom$/, replacement: mod("react-dom") },
        { find: /^react-dom\/(.*)$/, replacement: `${mod("react-dom")}/$1` },
        // The library's web build: its elements drawn as DOM svg, as the web client draws its glyphs.
        { find: /^react-native-svg$/, replacement: path.join(app, "node_modules/react-native-svg/lib/module/elements.web.js") },
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
        { find: /^react-native-svg$/, replacement: mock("svg-web.tsx") },
        { find: /^expo-image-picker$/, replacement: mock("image-picker.ts") },
        { find: /^expo-document-picker$/, replacement: mock("document-picker.ts") },
        { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
      ],
    },
    optimizeDeps: {
      include: [mod("react"), mod("react-dom"), "react-native-web", "marked"],
      // Prebundling skips the aliases for a dependency's own relative requires: react-native-svg's Android touch sound.
      esbuildOptions: { plugins: [{ name: "svg-sound", setup: (b) => b.onResolve({ filter: /NativeSvgSoundModule$/ }, () => ({ path: mock("svg-sound.ts") })) }] },
    },
  });
}
