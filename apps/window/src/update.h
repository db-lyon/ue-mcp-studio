// The refused screen's ue-mcp update, run by the window when the daemon refused
// Studio and no Studio route is loaded to run it. It runs the target release's
// own CLI, `ue-mcp@<version> update <uproject> --apply-only`, so the release
// being installed applies its bridge, never the older daemon's updater.
// Pure: main.cpp spawns the command and reads the files it names.
#pragma once

#include <cctype>
#include <string>

#include "job.h"
#include "json.h"

namespace ueupdate {

/** major.minor.patch with an optional -prerelease of [0-9A-Za-z.]: nothing else reaches the command line. */
inline bool validVersion(const std::string& v) {
  size_t i = 0;
  for (int part = 0; part < 3; ++part) {
    if (part > 0) {
      if (i >= v.size() || v[i] != '.') return false;
      ++i;
    }
    size_t start = i;
    while (i < v.size() && std::isdigit(static_cast<unsigned char>(v[i]))) ++i;
    if (i == start) return false;
  }
  if (i == v.size()) return true;
  if (v[i] != '-' || i + 1 == v.size()) return false;
  for (++i; i < v.size(); ++i) {
    if (!std::isalnum(static_cast<unsigned char>(v[i])) && v[i] != '.') return false;
  }
  return true;
}

/**
 * The cmd /c line: the target CLI with its output to `out`, then 0 or 1 to
 * `exitFile` once it ends. The age gate is lifted for ue-mcp's own release,
 * as the agent's updater does (ue-mcp#1510).
 */
inline std::wstring command(const std::wstring& npx, const std::wstring& version, const std::wstring& uproject,
                            const std::wstring& out, const std::wstring& exitFile) {
  return job::wrap(L"\"" + npx + L"\" -y --min-release-age=0 ue-mcp@" + version + L" update \"" + uproject + L"\" --apply-only", out, exitFile);
}

using job::failureText;

/**
 * The run's result for the page: "" while it runs (no exit file yet), else
 * {"ok":true}, or {"ok":false,"error":"<what the CLI said>"}.
 */
inline std::string result(bool exited, const std::string& exitText, const std::string& output, const std::string& version) {
  if (!exited) return std::string();
  if (!exitText.empty() && exitText[0] == '0') return "{\"ok\":true}";
  std::string said = failureText(output);
  std::string error = "ue-mcp " + version + " update failed" + (said.empty() ? std::string() : ":\n" + said);
  return "{\"ok\":false,\"error\":" + json::quote(error) + "}";
}

}  // namespace ueupdate
