// Which ue-mcp release to run for a project, read when it runs. The window
// and the UE-MCP app start, stop and set up a project's daemon through it, so
// they run the release the project is pinned to: the version of the bridge
// plugin in its Plugins folder, which `ue-mcp update` moves and the editor
// plugin and the agent's daemonPackage also run. Read at each run, never kept
// from launch: a window open across a daemon restart onto another release
// otherwise starts the old one. How it is run (npx and its flags) is
// job::npx alone.
#pragma once

#include <string>

#include "files.h"
#include "json.h"
#include "update.h"

namespace uemcpspec {

/**
 * The oldest ue-mcp the Studio this build ships with runs on (apps/agent's
 * ueMcpExtension.ueMcp), compiled in by scripts/build-window.mjs.
 */
#ifdef STUDIO_UE_MCP_MIN
inline const char* kMin = STUDIO_UE_MCP_MIN;
#else
inline const char* kMin = "";
#endif

/** The bridge plugin's VersionName in the project, or empty when it is missing or not a version. */
inline std::string bridgeVersion(const std::wstring& projectDir) {
  std::string text;
  json::Value v;
  std::wstring file = files::join(files::join(files::join(projectDir, L"Plugins"), L"UE_MCP_Bridge"), L"UE_MCP_Bridge.uplugin");
  if (!files::readFile(file, text) || !json::parse(text, v) || !v.isObject()) return {};
  const json::Value* name = v.get("VersionName");
  return name && name->isString() && ueupdate::validVersion(name->s) ? name->s : std::string();
}

/**
 * The npm spec for a project whose bridge is at `bridge`: that version,
 * unless it is missing or older than `min` (Studio would not load on it);
 * then `fallback`, the release that last ran Studio here or the channel's.
 */
inline std::wstring forBridge(const std::string& bridge, const std::string& min, const std::wstring& fallback) {
  if (bridge.empty() || !ueupdate::validVersion(bridge)) return fallback;
  if (!min.empty() && ueupdate::validVersion(min) && ueupdate::compareVersion(bridge, min) < 0) return fallback;
  return L"ue-mcp@" + files::widen(bridge);
}

/** The npm spec for the project in `projectDir`, read now. */
inline std::wstring forProject(const std::wstring& projectDir, const std::wstring& fallback) {
  return forBridge(bridgeVersion(projectDir), kMin, fallback);
}

}  // namespace uemcpspec
