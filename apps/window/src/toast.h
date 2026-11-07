// Windows notifications from studio-window.exe: the parts with no Windows
// calls, so apps/window/test/dock-test.cpp can check them.
//
// Studio shows a toast under one fixed AppUserModelID, registered under
// HKCU\Software\Classes\AppUserModelId with its name and icon, so Windows
// keeps the user's notification settings for Studio across updates. A tray
// icon's balloon, which this replaces, is named after the exe's path, and the
// exe runs from a folder per version; Windows 11 also drops those balloons
// without showing them (ue-mcp#1713).
#pragma once

#include <cstdint>
#include <cstdio>
#include <deque>
#include <string>

#include "json.h"

namespace toast {

/** Studio's AppUserModelID: the process's, the toasts', and the key Windows keeps its settings under. */
constexpr const wchar_t* kAumid = L"UEMCP.Studio";
constexpr const wchar_t* kDisplayName = L"UE-MCP Studio";

/** Text made safe inside an XML element or a quoted attribute. */
inline std::wstring escape(const std::wstring& s) {
  std::wstring out;
  out.reserve(s.size());
  for (wchar_t c : s) {
    switch (c) {
      case L'&': out += L"&amp;"; break;
      case L'<': out += L"&lt;"; break;
      case L'>': out += L"&gt;"; break;
      case L'"': out += L"&quot;"; break;
      case L'\'': out += L"&apos;"; break;
      default:
        // XML 1.0 has no place for the other control characters.
        if (c < 0x20 && c != L'\t' && c != L'\n' && c != L'\r') out += L' ';
        else out += c;
    }
  }
  return out;
}

/** The toast: a title line and the text, as Windows' generic template lays them out. */
inline std::wstring xml(const std::wstring& title, const std::wstring& text) {
  return L"<toast launch=\"studio\"><visual><binding template=\"ToastGeneric\"><text>" + escape(title) + L"</text><text>" + escape(text) +
         L"</text></binding></visual></toast>";
}

/** A toast group: the project's name, cut to what Windows takes (64 characters). */
inline std::wstring group(const std::wstring& project) {
  std::wstring g = project.empty() ? L"studio" : project;
  return g.size() > 64 ? g.substr(0, 64) : g;
}

/** Windows' NotificationSetting, named. */
inline const char* settingName(int setting) {
  switch (setting) {
    case 0: return "enabled";
    case 1: return "disabled for Studio";
    case 2: return "disabled for this user";
    case 3: return "disabled by group policy";
    case 4: return "disabled by manifest";
    default: return "unknown";
  }
}

inline std::string hresult(int32_t hr) {
  char buf[16];
  std::snprintf(buf, sizeof buf, "0x%08X", static_cast<uint32_t>(hr));
  return buf;
}

/** The answer to the page's notify call: { ok, via, setting?, hr?, error?, duplicate? }. */
inline std::string answer(bool ok, const std::string& via, const std::string& setting = {}, int32_t hr = 0, const std::string& error = {}, bool duplicate = false) {
  std::string out = std::string("{\"ok\":") + (ok ? "true" : "false") + ",\"via\":" + json::quote(via);
  if (!setting.empty()) out += ",\"setting\":" + json::quote(setting);
  if (hr) out += ",\"hr\":" + json::quote(hresult(hr));
  if (!error.empty()) out += ",\"error\":" + json::quote(error);
  if (duplicate) out += ",\"duplicate\":true";
  return out + "}";
}

/**
 * The notices this window has shown a toast for, by the agent's notice id:
 * a second notify for the same notice, from any page, shows nothing.
 */
class Shown {
 public:
  static constexpr size_t kKeep = 100;
  /** True the first time an id is seen; an empty id (an older page) is always new. */
  bool first(const std::string& id) {
    if (id.empty()) return true;
    for (const std::string& s : ids_)
      if (s == id) return false;
    ids_.push_back(id);
    if (ids_.size() > kKeep) ids_.pop_front();
    return true;
  }

 private:
  std::deque<std::string> ids_;
};

}  // namespace toast
