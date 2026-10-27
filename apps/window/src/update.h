// The refused screen's ue-mcp update, run by the window when the daemon refused
// Studio and no Studio route is loaded to run it. It runs the target release's
// own CLI, `ue-mcp@<version> update <uproject> --apply-only`, so the release
// being installed applies its bridge, never the older daemon's updater.
// Pure: main.cpp spawns the command and reads the files it names.
#pragma once

#include <cctype>
#include <string>
#include <vector>

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
  return L"\"" + npx + L"\" -y --min-release-age=0 ue-mcp@" + version + L" update \"" + uproject + L"\" --apply-only > \"" + out +
         L"\" 2>&1 && (echo 0)> \"" + exitFile + L"\" || (echo 1)> \"" + exitFile + L"\"";
}

/** What a failed run said: npm's own error lines when it wrote any, else its last lines. The agent's failureText. */
inline std::string failureText(const std::string& output) {
  std::vector<std::string> lines;
  std::string line;
  auto flush = [&]() {
    while (!line.empty() && (line.back() == ' ' || line.back() == '\t' || line.back() == '\r')) line.pop_back();
    if (!line.empty()) lines.push_back(line);
    line.clear();
  };
  for (size_t i = 0; i < output.size(); ++i) {
    char c = output[i];
    if (c == '\x1b' && i + 1 < output.size() && output[i + 1] == '[') {
      // An ANSI color: up to its final letter.
      i += 2;
      while (i < output.size() && !std::isalpha(static_cast<unsigned char>(output[i]))) ++i;
      continue;
    }
    if (c == '\n') flush();
    else line += c;
  }
  flush();
  std::vector<std::string> npm;
  for (const std::string& l : lines) {
    std::string rest;
    if (l.rfind("npm error", 0) == 0) rest = l.substr(9);
    else if (l.rfind("npm ERR!", 0) == 0) rest = l.substr(8);
    else continue;
    if (!rest.empty() && rest[0] == ' ') rest.erase(0, 1);
    if (rest.empty() || rest.rfind("A complete log of this run", 0) == 0 || rest.find("_logs\\") != std::string::npos ||
        rest.find("_logs/") != std::string::npos) {
      continue;
    }
    npm.push_back(rest);
  }
  std::vector<std::string> pick = npm;
  if (pick.empty()) pick.assign(lines.size() > 5 ? lines.end() - 5 : lines.begin(), lines.end());
  std::string text;
  for (const std::string& l : pick) {
    if (!text.empty()) text += "\n";
    text += l;
  }
  return text.size() > 2000 ? text.substr(text.size() - 2000) : text;
}

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
