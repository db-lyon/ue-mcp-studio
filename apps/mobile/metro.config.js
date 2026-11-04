// Workspace packages resolve to their TypeScript source, so the app never runs a
// stale dist/ build and needs no build step before bundling.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, "../..");

const SOURCE = {
  "@ue-mcp-studio/remote": path.join(root, "packages/remote/src/index.ts"),
  "@ue-mcp-studio/client-core": path.join(root, "packages/client-core/src/index.ts"),
  "@ue-mcp-studio/shared": path.join(root, "packages/shared/src/index.ts"),
  "@ue-mcp-studio/extension-api": path.join(root, "packages/extension-api/src/index.ts"),
};

const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (SOURCE[moduleName]) return { type: "sourceFile", filePath: SOURCE[moduleName] };
  const resolve = resolveDefault ?? context.resolveRequest;
  // TypeScript sources import siblings as "./x.js"; inside a workspace package that file is x.ts.
  if (moduleName.startsWith(".") && moduleName.endsWith(".js") && context.originModulePath.startsWith(path.join(root, "packages"))) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Not a TypeScript sibling: resolved as written below.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
