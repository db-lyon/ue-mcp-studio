#pragma once
// The app's own copy of ue-mcp: one folder per exact version under a root
// (`<data>\ue-mcp\ue-mcp-<version>`), installed once and run with node from then
// on. npx would resolve the package with npm on every call, about 20 seconds
// each, while ue-mcp answers in about 2.
//
// Kept apart from app.cpp so apps/window/test/dock-test.cpp can test it with a
// fake installer in a temporary folder.

#include <algorithm>
#include <functional>
#include <string>
#include <vector>

#include "files.h"
#include "update.h"

namespace uemcp {

using files::dirOf;
using files::exists;
using files::join;
using files::makeDirs;
using files::narrow;
using files::removeTree;
using files::widen;
using files::writeFile;

/** The entry script inside an install prefix. */
inline std::wstring scriptIn(const std::wstring& prefix) {
  return join(join(join(join(prefix, L"node_modules"), L"ue-mcp"), L"dist"), L"index.js");
}

/**
 * The marker written once an install finished, holding the installed ue-mcp
 * version; a folder without it is never used, and is pruned.
 */
inline std::wstring finishedIn(const std::wstring& prefix) { return join(prefix, L".installed"); }

/**
 * The folder a spec installs into, or empty for one that is not installed.
 * An exact registry version (`ue-mcp@1.4.14`) is named by that version. A local
 * tarball is named by its size and modified time, so a rebuilt tarball at the
 * same path is a new folder rather than a stale copy. A channel tag
 * (`ue-mcp@beta`) names no fixed release, so it keeps running through npx.
 */
inline std::wstring key(const std::wstring& spec) {
  std::string s = narrow(spec);
  if (s.rfind("ue-mcp@", 0) == 0) return ueupdate::validVersion(s.substr(7)) ? L"ue-mcp-" + spec.substr(7) : std::wstring();
  if (spec.size() < 5 || _wcsicmp(spec.c_str() + spec.size() - 4, L".tgz") != 0) return {};
  WIN32_FILE_ATTRIBUTE_DATA a;
  if (!GetFileAttributesExW(spec.c_str(), GetFileExInfoStandard, &a) || (a.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return {};
  wchar_t name[64];
  swprintf(name, 64, L"tgz-%08lx%08lx-%08lx%08lx", a.nFileSizeHigh, a.nFileSizeLow, a.ftLastWriteTime.dwHighDateTime, a.ftLastWriteTime.dwLowDateTime);
  return name;
}

/** The version in an install's ue-mcp package.json, or empty. */
inline std::string installedVersion(const std::wstring& prefix) {
  std::string text;
  json::Value pkg;
  if (!files::readFile(join(join(join(prefix, L"node_modules"), L"ue-mcp"), L"package.json"), text) || !json::parse(text, pkg) || !pkg.isObject()) return {};
  const json::Value* v = pkg.get("version");
  return v && v->isString() ? v->s : std::string();
}

/**
 * Remove every folder under `root` except `keep` and finished installs of a
 * version in `inUse`: older versions, installs cut off midway, leftovers of an
 * earlier removal. A version a running daemon uses stays, since the daemon may
 * still load files from it.
 */
inline void prune(const std::wstring& root, const std::wstring& keep, const std::vector<std::string>& inUse) {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(join(root, L"*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  std::vector<std::wstring> gone;
  do {
    std::wstring name = fd.cFileName;
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || name == L"." || name == L".." || name == keep) continue;
    std::string version;
    if (files::readFile(finishedIn(join(root, name)), version) && std::find(inUse.begin(), inUse.end(), version) != inUse.end()) continue;
    gone.push_back(join(root, name));
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  for (const std::wstring& d : gone) removeTree(d);
}

/**
 * The entry script for `spec`, installing it first when needed. `install` runs
 * the package manager into the prefix it is given and says whether it exited
 * cleanly. The install goes into a temporary folder that is moved into place
 * only once the entry script is there and the finished marker is written, so a
 * cut-off install is never mistaken for a good one. After a fresh install every
 * other folder is pruned, except versions `inUse` names (asked only then).
 * Empty for a spec `key` does not install, or when the install failed: the
 * caller then uses npx.
 */
inline std::wstring ensure(const std::wstring& root, const std::wstring& spec, const std::function<bool(const std::wstring&)>& install,
                           const std::function<std::vector<std::string>()>& inUse) {
  std::wstring keep = key(spec);
  if (keep.empty()) return {};
  std::wstring prefix = join(root, keep);
  if (exists(finishedIn(prefix)) && exists(scriptIn(prefix))) return scriptIn(prefix);
  std::wstring temp = join(root, keep + L".partial-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
  makeDirs(temp);
  std::string version;
  if (!install(temp) || !exists(scriptIn(temp)) || (version = installedVersion(temp)).empty() || !writeFile(finishedIn(temp), version)) {
    removeTree(temp);
    return {};
  }
  if (exists(prefix)) removeTree(prefix);  // an unfinished folder from before
  if (!MoveFileExW(temp.c_str(), prefix.c_str(), 0)) {
    removeTree(temp);
    return {};
  }
  prune(root, keep, inUse());
  return scriptIn(prefix);
}

}  // namespace uemcp
