// Opening a project in an IDE: which IDEs this computer has (Visual Studio
// from vswhere, VS Code, Rider), which one a project opens in (the choice
// remembered for it, else the engine's Source Code Access preference, else
// what its project files suit), what each opens (the .sln, the
// .code-workspace or folder, the .sln or .uproject), and how its project
// files are generated. Pure: app.cpp runs vswhere, reads files and the
// registry, and starts the processes.
#pragma once

#include <cctype>
#include <cwctype>
#include <string>
#include <vector>

#include "json.h"

namespace ide {

/** An IDE found on this computer. id: "vs:<instanceId>", "vscode" or "rider"; kind: "vs", "vscode" or "rider". */
struct Found {
  std::string id;
  std::string kind;
  std::string name;
  std::wstring exe;
};

/** A project's files an IDE opens: its solution (.sln or .slnx) and its VS Code workspace, or empty. */
struct Files {
  std::wstring solution;
  std::wstring workspace;
};

inline std::string lowerA(std::string s) {
  for (char& c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}

/**
 * The Visual Studio installs in vswhere's JSON (-format json -utf8 -sort, so
 * newest first), each with the devenv.exe it opens solutions with. Build
 * Tools installs have no devenv.exe and are left out. `widen` turns vswhere's
 * UTF-8 into a path.
 */
template <typename Widen>
std::vector<Found> parseVswhere(const std::string& text, Widen widen) {
  std::vector<Found> out;
  json::Value v;
  if (!json::parse(text, v) || !v.isArray()) return out;
  for (const json::Value& i : *v.a) {
    const json::Value* id = i.get("instanceId");
    const json::Value* name = i.get("displayName");
    const json::Value* path = i.get("productPath");
    if (!id || !id->isString() || id->s.empty() || !path || !path->isString()) continue;
    std::string exe = lowerA(path->s);
    if (exe.size() < 10 || exe.compare(exe.size() - 10, 10, "devenv.exe") != 0) continue;
    bool safe = true;
    for (char c : id->s) safe = safe && (std::isalnum((unsigned char)c) != 0);
    if (!safe) continue;
    out.push_back({"vs:" + id->s, "vs", name && name->isString() && !name->s.empty() ? name->s : "Visual Studio", widen(path->s)});
  }
  return out;
}

/**
 * The engine's Source Code Access preference in an ini's text:
 * [/Script/SourceCodeAccess.SourceCodeAccessSettings] PreferredAccessor, as
 * "vs", "vscode" or "rider", or "" when it does not say.
 */
inline std::string accessorKind(const std::string& ini) {
  bool in = false;
  size_t at = 0;
  while (at <= ini.size()) {
    size_t end = ini.find('\n', at);
    if (end == std::string::npos) end = ini.size();
    std::string line = ini.substr(at, end - at);
    at = end + 1;
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) line.pop_back();
    size_t s = line.find_first_not_of(" \t");
    if (s == std::string::npos) continue;
    line = line.substr(s);
    if (line[0] == '[') {
      in = lowerA(line) == "[/script/sourcecodeaccess.sourcecodeaccesssettings]";
      continue;
    }
    if (!in) continue;
    std::string l = lowerA(line);
    if (l.rfind("preferredaccessor=", 0) != 0) continue;
    std::string value = l.substr(18);
    if (value.find("rider") != std::string::npos) return "rider";
    if (value.find("visualstudiocode") != std::string::npos || value.find("vscode") != std::string::npos) return "vscode";
    if (value.find("visualstudio") != std::string::npos) return "vs";
    return "";
  }
  return "";
}

/** The .uproject's EngineAssociation: "5.8", a source build's GUID, or "" for an engine the project sits inside. */
inline std::string association(const std::string& uproject) {
  json::Value v;
  if (!json::parse(uproject, v)) return "";
  const json::Value* a = v.get("EngineAssociation");
  return a && a->isString() ? a->s : "";
}

/** The engine folder Epic's launcher lists for an association ("5.8" is the app UE_5.8) in LauncherInstalled.dat. */
inline std::string launcherInstall(const std::string& dat, const std::string& assoc) {
  json::Value v;
  if (assoc.empty() || !json::parse(dat, v)) return "";
  const json::Value* list = v.get("InstallationList");
  if (!list || !list->isArray()) return "";
  for (const json::Value& i : *list->a) {
    const json::Value* app = i.get("AppName");
    const json::Value* at = i.get("InstallLocation");
    if (app && app->isString() && at && at->isString() && app->s == "UE_" + assoc) return at->s;
  }
  return "";
}

/** A shell verb's command (Unreal.ProjectFile\shell\rungenproj\command) with the project put in for %1, or "" when it has no %1. */
inline std::wstring fillVerb(const std::wstring& command, const std::wstring& path) {
  size_t at = command.find(L"%1");
  if (at == std::wstring::npos) return L"";
  return command.substr(0, at) + path + command.substr(at + 2);
}

/** UnrealBuildTool's arguments to generate a project's files: an installed engine takes -rocket, a source build -engine. */
inline std::wstring projectFilesArgs(const std::wstring& uproject, bool installedEngine) {
  return L"-projectfiles -project=\"" + uproject + L"\" -game -progress " + (installedEngine ? L"-rocket" : L"-engine");
}

/**
 * The IDE a project opens in: the one remembered for it while it is still
 * here, else the first of the engine's preferred kind, else what the
 * project's files suit (a solution: Visual Studio, then Rider; a workspace:
 * VS Code), else Rider (it opens a .uproject), VS Code, Visual Studio. "" when
 * there is none.
 */
inline std::string choose(const std::vector<Found>& found, const std::string& remembered, const std::string& preferred, const Files& f) {
  auto first = [&](const std::string& kind) -> std::string {
    for (const Found& x : found) if (x.kind == kind) return x.id;
    return "";
  };
  if (!remembered.empty()) for (const Found& x : found) if (x.id == remembered) return x.id;
  std::vector<std::string> order;
  if (!preferred.empty()) order.push_back(preferred);
  if (!f.solution.empty()) order.insert(order.end(), {"vs", "rider"});
  if (!f.workspace.empty()) order.push_back("vscode");
  order.insert(order.end(), {"rider", "vscode", "vs"});
  for (const std::string& k : order) {
    std::string id = first(k);
    if (!id.empty()) return id;
  }
  return "";
}

/**
 * What an IDE of `kind` opens for the project: Visual Studio its solution
 * ("" without one: its project files have to be generated first), VS Code its
 * workspace or else its folder, Rider its solution or else the .uproject.
 */
inline std::wstring target(const std::string& kind, const Files& f, const std::wstring& dir, const std::wstring& uproject) {
  if (kind == "vs") return f.solution;
  if (kind == "vscode") return f.workspace.empty() ? dir : f.workspace;
  if (kind == "rider") return f.solution.empty() ? uproject : f.solution;
  return L"";
}

/**
 * Of a folder's files, the solution and the workspace a project opens: the
 * one named for the project when there are several, .sln before .slnx.
 * `names` are bare file names.
 */
inline Files pickFiles(const std::vector<std::wstring>& names, const std::wstring& project) {
  auto low = [](std::wstring s) {
    for (wchar_t& c : s) c = (wchar_t)std::towlower(c);
    return s;
  };
  std::wstring p = low(project);
  Files f;
  int solutionRank = 0, workspaceRank = 0;
  for (const std::wstring& n : names) {
    std::wstring l = low(n);
    auto ends = [&](const std::wstring& ext) { return l.size() > ext.size() && l.compare(l.size() - ext.size(), ext.size(), ext) == 0; };
    auto named = [&](const std::wstring& ext) { return l == p + ext; };
    int rank = named(L".sln") ? 4 : named(L".slnx") ? 3 : ends(L".sln") ? 2 : ends(L".slnx") ? 1 : 0;
    if (rank > solutionRank) {
      solutionRank = rank;
      f.solution = n;
    }
    int w = named(L".code-workspace") ? 2 : ends(L".code-workspace") ? 1 : 0;
    if (w > workspaceRank) {
      workspaceRank = w;
      f.workspace = n;
    }
  }
  return f;
}

}  // namespace ide
