// A background command run under cmd with no console: its output and its exit
// code go to files, which the page polls. Shared by studio-window's update
// (update.h) and the UE-MCP app's jobs. Pure: the hosts spawn and read files.
#pragma once

#include <cctype>
#include <string>
#include <vector>

namespace job {

/** `line`, its output to `out` (stderr too, unless `err` names its own file), then 0 or 1 to `exitFile`. */
inline std::wstring wrap(const std::wstring& line, const std::wstring& out, const std::wstring& exitFile, const std::wstring& err = {}) {
  std::wstring redirect = err.empty() ? L" > \"" + out + L"\" 2>&1" : L" > \"" + out + L"\" 2> \"" + err + L"\"";
  return line + redirect + L" && (echo 0)> \"" + exitFile + L"\" || (echo 1)> \"" + exitFile + L"\"";
}

/** The lines of a command's output, colors and blank lines left out. */
inline std::vector<std::string> lines(const std::string& output) {
  std::vector<std::string> out;
  std::string line;
  auto flush = [&]() {
    while (!line.empty() && (line.back() == ' ' || line.back() == '\t' || line.back() == '\r')) line.pop_back();
    if (!line.empty()) out.push_back(line);
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
  return out;
}

/** What a failed run said: npm's own error lines when it wrote any, else its last lines. The agent's failureText. */
inline std::string failureText(const std::string& output) {
  std::vector<std::string> all = lines(output);
  std::vector<std::string> npm;
  for (const std::string& l : all) {
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
  if (pick.empty()) pick.assign(all.size() > 5 ? all.end() - 5 : all.begin(), all.end());
  std::string text;
  for (const std::string& l : pick) {
    if (!text.empty()) text += "\n";
    text += l;
  }
  return text.size() > 2000 ? text.substr(text.size() - 2000) : text;
}

/** A project key as ue-mcp writes it: 16 lower-case hex characters. */
inline bool validKey(const std::string& key) {
  if (key.size() != 16) return false;
  for (char c : key) if (!std::isdigit(static_cast<unsigned char>(c)) && (c < 'a' || c > 'f')) return false;
  return true;
}

/**
 * The daemon calls the app may make for its page, and nothing else: the
 * health and update checks, Studio's window, and the daemon's editor launch.
 */
inline bool allowed(const std::string& method, const std::string& path) {
  if (method == "GET") {
    return path == "/v1/health" || path == "/v1/update" || path == "/v1/update?channel=latest" || path == "/v1/update?channel=beta" ||
           path == "/v1/ext/studio/updates";
  }
  if (method == "POST") return path == "/v1/ext/studio/window" || path == "/v1/editor/start";
  return false;
}

/** The ue-mcp npm spec to run: the exact version once known, else the channel's tag. */
inline std::wstring spec(const std::wstring& tag, const std::wstring& exact) {
  return L"ue-mcp@" + (exact.empty() ? tag : exact);
}

/** A ue-mcp command through npx, from the npm cache when the version is already there. */
inline std::wstring npx(const std::wstring& npxCmd, const std::wstring& packageSpec, const std::wstring& args) {
  return L"\"" + npxCmd + L"\" -y --prefer-offline --min-release-age=0 " + packageSpec + L" " + args;
}

}  // namespace job
