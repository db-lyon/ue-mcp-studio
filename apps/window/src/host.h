// What studio-window.exe and UE-MCP.exe share: strings, files, processes,
// finding Node.js, and Studio's mark. Win32 only, no WebView2.
#pragma once

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <string>

#include "files.h"

namespace host {

using namespace files;

inline bool processAlive(DWORD pid) {
  if (!pid) return false;
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return GetLastError() == ERROR_ACCESS_DENIED;
  DWORD code = 0;
  bool alive = GetExitCodeProcess(p, &code) && code == STILL_ACTIVE;
  CloseHandle(p);
  return alive;
}

inline DWORD pidOf(HWND w) {
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  return pid;
}

/**
 * node.exe: the hint when it exists, else on PATH, else where an installer or
 * a version manager keeps it. fnm and nvm-windows put node on PATH only in a
 * shell they set up, so an app started from the Start menu or relaunched by
 * its updater sees none on PATH; their default version lives at a fixed place.
 * Each place listed holds npx.cmd beside node.exe, which npxCmd relies on.
 */
inline std::wstring findNode(const std::wstring& hint = {}) {
  if (!hint.empty() && exists(hint)) return hint;
  wchar_t buf[MAX_PATH];
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, buf, nullptr)) return buf;
  auto under = [](const std::wstring& root, const wchar_t* rest) {
    return root.empty() ? std::wstring() : join(root, rest);
  };
  std::wstring fnmDir = env(L"FNM_DIR");
  if (fnmDir.empty()) fnmDir = under(env(L"APPDATA"), L"fnm");
  const std::wstring dirs[] = {
    under(env(L"ProgramFiles"), L"nodejs"),
    env(L"NVM_SYMLINK"),                              // nvm-windows: the active version
    under(fnmDir, L"aliases\\default"),               // fnm: the default version
    under(env(L"USERPROFILE"), L"scoop\\apps\\nodejs-lts\\current"),
    under(env(L"USERPROFILE"), L"scoop\\apps\\nodejs\\current"),
  };
  for (const auto& dir : dirs) {
    if (dir.empty()) continue;
    std::wstring node = join(dir, L"node.exe");
    if (exists(node)) return node;
  }
  return std::wstring();
}

inline bool createDetached(const std::wstring& exe, std::wstring commandLine, const std::wstring& cwd, DWORD flags, DWORD* pidOut = nullptr) {
  STARTUPINFOW si = {sizeof si};
  PROCESS_INFORMATION pi = {};
  DWORD f = flags | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB;
  BOOL ok = CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr, FALSE, f, nullptr, cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  if (!ok && GetLastError() == ERROR_ACCESS_DENIED) {
    f &= ~CREATE_BREAKAWAY_FROM_JOB;
    ok = CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr, FALSE, f, nullptr, cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  }
  if (!ok) return false;
  if (pidOut) *pidOut = pi.dwProcessId;
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

/** The window icon: the Studio mark, an accent dot on a dark tile. */
inline HICON makeIcon(int size) {
  BITMAPV5HEADER bi = {};
  bi.bV5Size = sizeof bi;
  bi.bV5Width = size;
  bi.bV5Height = -size;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000;
  bi.bV5GreenMask = 0x0000FF00;
  bi.bV5BlueMask = 0x000000FF;
  bi.bV5AlphaMask = 0xFF000000;
  void* bits = nullptr;
  HDC dc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(dc, reinterpret_cast<BITMAPINFO*>(&bi), DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  if (!color) return LoadIconW(nullptr, IDI_APPLICATION);
  auto* px = static_cast<DWORD*>(bits);
  const float c = (size - 1) / 2.0f, dot = size * 0.26f, tile = size * 0.5f, radius = size * 0.18f;
  for (int y = 0; y < size; ++y) {
    for (int x = 0; x < size; ++x) {
      // A rounded square, then the dot, each with a one-pixel soft edge.
      float qx = std::max(std::fabs(x - c) - (tile - radius), 0.0f), qy = std::max(std::fabs(y - c) - (tile - radius), 0.0f);
      float tileA = std::clamp(radius - std::sqrt(qx * qx + qy * qy) + 0.5f, 0.0f, 1.0f);
      float d = std::sqrt((x - c) * (x - c) + (y - c) * (y - c));
      float dotA = std::clamp(dot - d + 0.5f, 0.0f, 1.0f);
      float r = 0x13 + (0xe8 - 0x13) * dotA, g = 0x13 + (0x72 - 0x13) * dotA, b = 0x12 + (0x0c - 0x12) * dotA;
      BYTE a = (BYTE)(tileA * 255);
      px[y * size + x] = ((DWORD)a << 24) | ((DWORD)(r * tileA) << 16) | ((DWORD)(g * tileA) << 8) | (DWORD)(b * tileA);
    }
  }
  HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
  ICONINFO ii = {TRUE, 0, 0, mask, color};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(mask);
  DeleteObject(color);
  return icon ? icon : LoadIconW(nullptr, IDI_APPLICATION);
}

}  // namespace host
