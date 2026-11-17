// Strings, files and folders: the part of host.h with no window, process or
// icon code, so apps/window/test/dock-test.cpp can use it too. Win32 wide APIs only.
#pragma once

#include <windows.h>

#include <string>

namespace files {

inline std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
  return out;
}

inline std::string narrow(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n, nullptr, nullptr);
  return out;
}

inline bool readFile(const std::wstring& path, std::string& out) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size;
  bool ok = GetFileSizeEx(f, &size) && size.QuadPart < (64 << 20);
  if (ok) {
    out.resize((size_t)size.QuadPart);
    DWORD got = 0;
    ok = out.empty() || (ReadFile(f, out.data(), (DWORD)out.size(), &got, nullptr) && got == out.size());
  }
  CloseHandle(f);
  return ok;
}

inline bool writeFile(const std::wstring& path, const std::string& data) {
  std::wstring tmp = path + L".tmp";
  HANDLE f = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD wrote = 0;
  bool ok = WriteFile(f, data.data(), (DWORD)data.size(), &wrote, nullptr) && wrote == data.size();
  CloseHandle(f);
  return ok && MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
}

inline bool appendFile(const std::wstring& path, const std::string& data) {
  HANDLE f = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD wrote = 0;
  bool ok = WriteFile(f, data.data(), (DWORD)data.size(), &wrote, nullptr);
  CloseHandle(f);
  return ok;
}

inline bool exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

inline std::wstring dirOf(const std::wstring& path) {
  size_t k = path.find_last_of(L"\\/");
  return k == std::wstring::npos ? std::wstring() : path.substr(0, k);
}

inline std::wstring join(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  return (a.back() == L'\\' || a.back() == L'/') ? a + b : a + L"\\" + b;
}

inline void makeDirs(const std::wstring& dir) {
  if (dir.empty() || exists(dir)) return;
  makeDirs(dirOf(dir));
  CreateDirectoryW(dir.c_str(), nullptr);
}

/** Delete a folder and everything in it, read-only files included. */
inline void removeTree(const std::wstring& dir) {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(join(dir, L"*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      std::wstring name = fd.cFileName;
      if (name == L"." || name == L"..") continue;
      std::wstring p = join(dir, name);
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) removeTree(p);
      else {
        SetFileAttributesW(p.c_str(), FILE_ATTRIBUTE_NORMAL);
        DeleteFileW(p.c_str());
      }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  RemoveDirectoryW(dir.c_str());
}

inline std::wstring env(const wchar_t* name) {
  wchar_t buf[32768];
  DWORD n = GetEnvironmentVariableW(name, buf, 32768);
  return n && n < 32768 ? std::wstring(buf, n) : std::wstring();
}

}  // namespace files
