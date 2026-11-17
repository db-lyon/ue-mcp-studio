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

/** The folder name a version is installed under. */
inline std::wstring folder(const std::string& version) { return L"ue-mcp-" + widen(version); }

/** The entry script inside an install prefix. */
inline std::wstring scriptIn(const std::wstring& prefix) {
  return join(join(join(join(prefix, L"node_modules"), L"ue-mcp"), L"dist"), L"index.js");
}

/** The marker written once an install finished; a folder without it is never used. */
inline std::wstring finishedIn(const std::wstring& prefix) { return join(prefix, L".installed"); }

/**
 * The exact version a package spec names, or empty. Only `ue-mcp@<version>` is
 * installed: a channel tag (`ue-mcp@beta`) or a local tarball can change under
 * the same name, so those keep running through npx.
 */
inline std::string exactVersion(const std::wstring& spec) {
  std::string s = narrow(spec);
  if (s.rfind("ue-mcp@", 0) != 0) return {};
  std::string v = s.substr(7);
  return ueupdate::validVersion(v) ? v : std::string();
}

/**
 * Remove every folder under `root` except `keep` and the folders in `inUse`:
 * older versions, installs cut off midway, leftovers of an earlier removal. A
 * version a running daemon uses stays, since the daemon may still load files
 * from it.
 */
inline void prune(const std::wstring& root, const std::wstring& keep, const std::vector<std::wstring>& inUse) {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(join(root, L"*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  std::vector<std::wstring> gone;
  do {
    std::wstring name = fd.cFileName;
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || name == L"." || name == L".." || name == keep) continue;
    if (std::find(inUse.begin(), inUse.end(), name) != inUse.end()) continue;
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
 * other folder is pruned, except those `inUse` names (asked only then). Empty
 * for a spec that is not an exact version, or when the install failed: the
 * caller then uses npx.
 */
inline std::wstring ensure(const std::wstring& root, const std::wstring& spec, const std::function<bool(const std::wstring&)>& install,
                           const std::function<std::vector<std::wstring>()>& inUse) {
  std::string version = exactVersion(spec);
  if (version.empty()) return {};
  std::wstring keep = folder(version);
  std::wstring prefix = join(root, keep);
  if (exists(finishedIn(prefix)) && exists(scriptIn(prefix))) return scriptIn(prefix);
  std::wstring temp = join(root, keep + L".partial-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
  makeDirs(temp);
  if (!install(temp) || !exists(scriptIn(temp)) || !writeFile(finishedIn(temp), version)) {
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
