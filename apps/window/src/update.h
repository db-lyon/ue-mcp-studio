// The refused screen's ue-mcp update, run by the window when the daemon refused
// Studio and no Studio route is loaded to run it. It runs the target release's
// own CLI, `ue-mcp@<version> update <uproject> --apply-only`, so the release
// being installed applies its bridge, never the older daemon's updater.
// Pure: main.cpp spawns the command and reads the files it names.
#pragma once

#include <cctype>
#include <string>
#include <vector>

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
 * Semver precedence of two valid versions: negative, zero or positive. A
 * prerelease sorts before its release (1.4.14-beta.7 < 1.4.14), and its
 * dot-separated identifiers compare numerically when both are numbers.
 */
inline int compareVersion(const std::string& a, const std::string& b) {
  auto split = [](const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
      if (i == s.size() || s[i] == sep) {
        out.push_back(s.substr(start, i - start));
        start = i + 1;
      }
    }
    return out;
  };
  auto numeric = [](const std::string& s) {
    if (s.empty()) return false;
    for (char c : s) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    return true;
  };
  auto cmpId = [&](const std::string& x, const std::string& y) {
    if (numeric(x) && numeric(y)) {
      if (x.size() != y.size()) return x.size() < y.size() ? -1 : 1;
      return x.compare(y) < 0 ? -1 : x.compare(y) > 0 ? 1 : 0;
    }
    if (numeric(x) != numeric(y)) return numeric(x) ? -1 : 1;
    return x.compare(y) < 0 ? -1 : x.compare(y) > 0 ? 1 : 0;
  };
  size_t da = a.find('-'), db = b.find('-');
  std::vector<std::string> ca = split(a.substr(0, da), '.'), cb = split(b.substr(0, db), '.');
  for (size_t i = 0; i < 3 && i < ca.size() && i < cb.size(); ++i) {
    if (int c = cmpId(ca[i], cb[i])) return c;
  }
  std::string pa = da == std::string::npos ? "" : a.substr(da + 1), pb = db == std::string::npos ? "" : b.substr(db + 1);
  if (pa.empty() || pb.empty()) return pa.empty() == pb.empty() ? 0 : pa.empty() ? 1 : -1;
  std::vector<std::string> ia = split(pa, '.'), ib = split(pb, '.');
  for (size_t i = 0; i < ia.size() && i < ib.size(); ++i) {
    if (int c = cmpId(ia[i], ib[i])) return c;
  }
  return ia.size() == ib.size() ? 0 : ia.size() < ib.size() ? -1 : 1;
}

/** The first ue-mcp with `ue-mcp projects` (db-lyon/ue-mcp#1820), which the UE-MCP app lists projects with. */
constexpr const char* kProjectsSince = "1.4.14-beta.1";

/** A ue-mcp version has the projects command, decided by its version alone. */
inline bool hasProjectsCommand(const std::string& version) {
  return validVersion(version) && compareVersion(version, kProjectsSince) >= 0;
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
