// What the UE-MCP app watches so its project list follows the machine, not
// only its own actions: the daemons folder (a daemon started, stopped or
// restarted elsewhere), ~/.ue-mcp/state.json (the Studio version each project
// records, which an update finished in a project's Studio rewrites), and each
// listed project's folder and Plugins (its .uproject, solution files and
// plugin versions). Pure: app.cpp opens the directories and reads the changes.
#pragma once

#include <cwctype>
#include <string>

namespace watch {

enum class Root {
  Daemons,  // ~/.ue-mcp/daemons: discovery files, beside logs that change all the time
  Home,     // ~/.ue-mcp, not recursive: state.json
  Project,  // a project's folder, not recursive
  Plugins,  // a project's Plugins folder, recursive
};

inline std::wstring lower(std::wstring s) {
  for (wchar_t& c : s) c = (wchar_t)std::towlower(c);
  return s;
}

inline bool endsWith(const std::wstring& s, const std::wstring& tail) { return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0; }

/** Whether a change to `name` (relative to the watched folder, as Windows reports it) can change the report. */
inline bool relevant(Root root, const std::wstring& name) {
  std::wstring n = lower(name);
  bool nested = n.find_first_of(L"\\/") != std::wstring::npos;
  switch (root) {
    case Root::Daemons:
      return !nested && endsWith(n, L".json");
    case Root::Home:
      return n == L"state.json";
    case Root::Project:
      return !nested && (endsWith(n, L".uproject") || endsWith(n, L".sln") || endsWith(n, L".slnx") || endsWith(n, L".code-workspace"));
    case Root::Plugins: {
      // A plugin folder added, removed or renamed.
      if (!nested) return true;
      // A build rewrites Intermediate and Binaries under every plugin; only a descriptor says a version.
      std::wstring p = L"\\" + n;
      for (wchar_t& c : p) if (c == L'/') c = L'\\';
      return endsWith(n, L".uplugin") && p.find(L"\\intermediate\\") == std::wstring::npos && p.find(L"\\binaries\\") == std::wstring::npos;
    }
  }
  return false;
}

/**
 * How long to wait before reading the report again, after a change at `now`
 * with the first unread change at `first`: `quiet` after the latest change,
 * so a burst reads once, but never later than `most` after the first, so a
 * folder that keeps changing still reads.
 */
inline unsigned long long delay(unsigned long long first, unsigned long long now, unsigned long long quiet = 1500, unsigned long long most = 8000) {
  unsigned long long since = now > first ? now - first : 0;
  if (since >= most) return 0;
  unsigned long long left = most - since;
  return quiet < left ? quiet : left;
}

}  // namespace watch
