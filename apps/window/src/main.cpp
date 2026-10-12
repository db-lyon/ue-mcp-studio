// studio-window.exe: UE-MCP Studio in its own window.
//
// The editor's dock tab paints on the game thread, so a long editor call froze
// the chat. This window is a separate process that loads the UI the project's
// daemon serves, so it stays live while the editor is busy.
//
// It never becomes a child or an owned window of the editor: a cross-process
// owner or parent attaches the two input queues, and a hung editor would hang
// this window with it. It follows the editor from here instead, by polling and
// a WinEvent hook: above the editor while the editor or Studio is in front,
// minimized and restored with it, and closed when it exits if the editor
// opened it. One window per project; a second launch hands its arguments to
// the first and exits.
//
// The page's native calls (window.ue.studio, as the editor binds them) are
// answered here over postMessage, so they work while the editor is busy.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <wrl.h>

#include <algorithm>
#include <cmath>
#include <cwctype>
#include <string>
#include <vector>

#include "WebView2.h"
#include "json.h"

#ifndef STUDIO_WINDOW_VERSION
#define STUDIO_WINDOW_VERSION "0.0.0"
#endif

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

constexpr UINT_PTR kDaemonTimer = 1;
constexpr UINT_PTR kEditorTimer = 2;
constexpr UINT_PTR kTestTimer = 3;
constexpr ULONG_PTR kCopyArgs = 0x53545544;  // "STUD"
constexpr LRESULT kHandedOff = 1;
constexpr LRESULT kReplaceMe = 2;
const wchar_t* kMainClass = L"UEMCPStudioWindow";

// ---------------------------------------------------------------- strings and files

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
  return out;
}

std::string narrow(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n, nullptr, nullptr);
  return out;
}

bool readFile(const std::wstring& path, std::string& out) {
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

bool writeFile(const std::wstring& path, const std::string& data) {
  std::wstring tmp = path + L".tmp";
  HANDLE f = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD wrote = 0;
  bool ok = WriteFile(f, data.data(), (DWORD)data.size(), &wrote, nullptr) && wrote == data.size();
  CloseHandle(f);
  return ok && MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
}

bool appendFile(const std::wstring& path, const std::string& data) {
  HANDLE f = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD wrote = 0;
  bool ok = WriteFile(f, data.data(), (DWORD)data.size(), &wrote, nullptr);
  CloseHandle(f);
  return ok;
}

bool exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

std::wstring dirOf(const std::wstring& path) {
  size_t k = path.find_last_of(L"\\/");
  return k == std::wstring::npos ? std::wstring() : path.substr(0, k);
}

std::wstring join(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  return (a.back() == L'\\' || a.back() == L'/') ? a + b : a + L"\\" + b;
}

void makeDirs(const std::wstring& dir) {
  if (dir.empty() || exists(dir)) return;
  makeDirs(dirOf(dir));
  CreateDirectoryW(dir.c_str(), nullptr);
}

std::wstring env(const wchar_t* name) {
  wchar_t buf[32768];
  DWORD n = GetEnvironmentVariableW(name, buf, 32768);
  return n && n < 32768 ? std::wstring(buf, n) : std::wstring();
}

bool processAlive(DWORD pid) {
  if (!pid) return false;
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return GetLastError() == ERROR_ACCESS_DENIED;
  DWORD code = 0;
  bool alive = GetExitCodeProcess(p, &code) && code == STILL_ACTIVE;
  CloseHandle(p);
  return alive;
}

DWORD pidOf(HWND w) {
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  return pid;
}

// ---------------------------------------------------------------- options

struct Options {
  std::wstring project;    // the project folder
  std::wstring discovery;  // the daemon's discovery file for it
  std::wstring key;        // the daemon's project key: one window per key
  std::wstring state;      // where the window's position is kept
  std::wstring title;      // the project's name
  std::wstring node;       // node.exe, for npx
  std::wstring ueMcp;      // the ue-mcp package the daemon runs, e.g. ue-mcp@1.4.0
  std::wstring instanceTest;  // tests only: no window, report hand-offs to this file
  std::wstring senderVersion;
  DWORD editorPid = 0;
  bool closeWithEditor = false;
  bool quit = false;
};

bool parseArgs(const wchar_t* commandLine, Options& o) {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(commandLine, &argc);
  if (!argv) return false;
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    auto next = [&](std::wstring& into) {
      if (i + 1 < argc) into = argv[++i];
    };
    if (a == L"--project") next(o.project);
    else if (a == L"--discovery") next(o.discovery);
    else if (a == L"--key") next(o.key);
    else if (a == L"--state") next(o.state);
    else if (a == L"--title") next(o.title);
    else if (a == L"--node") next(o.node);
    else if (a == L"--ue-mcp") next(o.ueMcp);
    else if (a == L"--instance-test") next(o.instanceTest);
    else if (a == L"--sender-version") next(o.senderVersion);
    else if (a == L"--editor-pid" && i + 1 < argc) o.editorPid = (DWORD)_wtoi(argv[++i]);
    else if (a == L"--close-with-editor") o.closeWithEditor = true;
    else if (a == L"--quit") o.quit = true;
  }
  LocalFree(argv);
  // The key names a mutex and a window class; keep it to what both accept.
  for (wchar_t c : o.key) if (!iswalnum(c) && c != L'-' && c != L'_') return false;
  return !o.key.empty();
}

// ---------------------------------------------------------------- state

struct Daemon {
  DWORD pid = 0;
  int port = 0;
  std::string token;
  std::string version;
};

Options gOpt;
HINSTANCE gInstance;
HWND gMain = nullptr;
HWND gMessage = nullptr;
HANDLE gMutex = nullptr;
ComPtr<ICoreWebView2Environment> gEnv;
ComPtr<ICoreWebView2Controller> gController;
ComPtr<ICoreWebView2> gWeb;
Daemon gLoaded;          // the daemon the page was loaded from; port 0 while on the local page
bool gLocalPage = false;
int gDaemonMisses = 0;
HANDLE gEditorProcess = nullptr;
DWORD gEditorPid = 0;
HWND gEditorMain = nullptr;
bool gEditorWasIconic = false;
bool gMinimizedByEditor = false;
bool gTopmost = false;
bool gRestartingEditor = false;
HWINEVENTHOOK gHooks[2] = {};

bool readDaemon(Daemon& out) {
  std::string text;
  json::Value v;
  if (gOpt.discovery.empty() || !readFile(gOpt.discovery, text) || !json::parse(text, v)) return false;
  const json::Value* pid = v.get("pid");
  const json::Value* port = v.get("port");
  const json::Value* token = v.get("token");
  if (!pid || !pid->isNumber() || !port || !port->isNumber() || !token || !token->isString() || token->s.empty()) return false;
  Daemon d;
  d.pid = (DWORD)pid->n;
  d.port = (int)port->n;
  d.token = token->s;
  if (const json::Value* ver = v.get("version"); ver && ver->isString()) d.version = ver->s;
  // The token goes into a URL; anything but hex is not a token the daemon wrote.
  for (char c : d.token) if (!isxdigit((unsigned char)c)) return false;
  if (!processAlive(d.pid)) return false;
  out = d;
  return true;
}

std::wstring uproject() {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(join(gOpt.project, L"*.uproject").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return {};
  FindClose(h);
  return join(gOpt.project, fd.cFileName);
}

std::wstring studioDir() { return join(join(gOpt.project, L"Saved"), L"UE_MCP_Studio"); }
std::wstring setupPlanPath() { return join(studioDir(), L"setup-plan.json"); }
std::wstring logPath() { return join(join(join(gOpt.project, L"Saved"), L"Logs"), L"UE_MCP_Studio.log"); }

void openExternal(const std::wstring& url) {
  if (url.rfind(L"https://", 0) != 0 && url.rfind(L"http://", 0) != 0) return;
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ---------------------------------------------------------------- processes

std::wstring findNode() {
  if (!gOpt.node.empty() && exists(gOpt.node)) return gOpt.node;
  wchar_t buf[MAX_PATH];
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, buf, nullptr)) return buf;
  std::wstring pf = join(join(env(L"ProgramFiles"), L"nodejs"), L"node.exe");
  return exists(pf) ? pf : std::wstring();
}

bool createDetached(const std::wstring& exe, std::wstring commandLine, const std::wstring& cwd, DWORD flags, DWORD* pidOut = nullptr) {
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

/**
 * Run npx commands in turn under cmd with no console window, output to the
 * Studio log (or stdout to a file). The same chain the editor plugin runs.
 */
bool spawnNpx(const std::vector<std::wstring>& commands, const std::wstring& stdoutFile = {}) {
  std::wstring node = findNode();
  if (node.empty()) return false;
  std::wstring nodeDir = dirOf(node);
  std::wstring npx = join(nodeDir, L"npx.cmd");
  std::wstring cmd = join(join(env(L"SystemRoot"), L"System32"), L"cmd.exe");
  std::wstring log = logPath();
  makeDirs(dirOf(log));
  std::wstring chain;
  for (const std::wstring& args : commands) {
    if (!chain.empty()) chain += L" && ";
    chain += L"\"" + npx + L"\" " + args;
    chain += stdoutFile.empty() ? L" >> \"" + log + L"\" 2>&1" : L" > \"" + stdoutFile + L"\" 2>> \"" + log + L"\"";
  }
  std::wstring path = env(L"PATH");
  if (path.find(nodeDir) == std::wstring::npos) SetEnvironmentVariableW(L"PATH", (nodeDir + L";" + path).c_str());
  return createDetached(cmd, L"\"" + cmd + L"\" /d /s /c \"" + chain + L"\"", gOpt.project, CREATE_NO_WINDOW);
}

std::wstring package() { return gOpt.ueMcp.empty() ? L"ue-mcp@beta" : gOpt.ueMcp; }

bool startDaemon() {
  std::wstring p = uproject();
  return !p.empty() && spawnNpx({L"-y " + package() + L" daemon start \"" + p + L"\""});
}

bool installBridge() {
  std::wstring p = uproject();
  return !p.empty() && spawnNpx({L"-y " + package() + L" init --yes --json --install=binary --clients= --project=\"" + p + L"\""});
}

bool startSetupPlan() {
  std::wstring p = uproject();
  if (p.empty()) return false;
  DeleteFileW(setupPlanPath().c_str());
  makeDirs(studioDir());
  return spawnNpx({L"-y " + package() + L" init --yes --json --dry-run --install=binary --project=\"" + p + L"\""}, setupPlanPath());
}

std::string getSetupPlan() {
  std::string text;
  json::Value v;
  // The file fills in as init writes it; only a complete document counts.
  return readFile(setupPlanPath(), text) && json::parse(text, v) ? text : std::string();
}

bool runSetup(const std::string& optionsJson) {
  static const char* clients[] = {"claude-code", "claude-code-global", "claude-desktop", "cursor", "codex"};
  static const char* contexts[] = {"micro", "lean", "full"};
  json::Value in;
  if (!json::parse(optionsJson, in) || !in.isObject()) return false;
  std::wstring list;
  if (const json::Value* c = in.get("clients"); c && c->isArray()) {
    for (const json::Value& id : *c->a) {
      if (!id.isString() || std::none_of(std::begin(clients), std::end(clients), [&](const char* k) { return id.s == k; })) return false;
      if (!list.empty()) list += L",";
      list += widen(id.s);
    }
  }
  auto flag = [&](const char* name, bool fallback) {
    const json::Value* v = in.get(name);
    return v && v->isBool() ? v->b : fallback;
  };
  std::wstring flags = L" --clients=" + list;
  flags += flag("nativeTools", true) ? L" --native-tools" : L" --no-native-tools";
  if (const json::Value* ctx = in.get("context"); ctx && ctx->isString()) {
    if (std::none_of(std::begin(contexts), std::end(contexts), [&](const char* k) { return ctx->s == k; })) return false;
    flags += L" --context=" + widen(ctx->s);
  }
  flags += flag("feedback", false) ? L" --feedback" : L" --no-feedback";
  flags += flag("skills", false) ? L" --skills" : L" --no-skills";
  std::wstring p = uproject();
  return !p.empty() && spawnNpx({L"-y " + package() + L" init --yes --json --install=binary" + flags + L" --project=\"" + p + L"\""});
}

bool enablePlugin(const std::string& name) {
  static const char* allowed[] = {"UE_MCP_Bridge", "PythonScriptPlugin", "Niagara", "PCG", "EnhancedInput", "GameplayAbilities"};
  if (std::none_of(std::begin(allowed), std::end(allowed), [&](const char* k) { return name == k; })) return false;
  std::wstring file = uproject();
  std::string text;
  json::Value doc;
  if (file.empty() || !readFile(file, text) || !json::parse(text, doc) || !doc.isObject()) return false;
  json::Value* plugins = doc.get("Plugins");
  if (!plugins) {
    json::Value list;
    list.kind = json::Value::Kind::Array;
    list.a = std::make_shared<json::Array>();
    doc.set("Plugins", list);
    plugins = doc.get("Plugins");
  }
  if (!plugins->isArray()) return false;
  for (json::Value& p : *plugins->a) {
    const json::Value* n = p.get("Name");
    if (n && n->isString() && n->s == name) {
      p.set("Enabled", json::Value::boolean(true));
      std::string out;
      json::write(doc, out);
      return writeFile(file, out);
    }
  }
  json::Value entry = json::Value::object();
  entry.set("Name", json::Value::str(name));
  entry.set("Enabled", json::Value::boolean(true));
  plugins->a->push_back(entry);
  std::string out;
  json::write(doc, out);
  return writeFile(file, out);
}

// ---------------------------------------------------------------- the editor

void setEditor(DWORD pid) {
  if (pid == gEditorPid && gEditorProcess) return;
  if (gEditorProcess) CloseHandle(gEditorProcess);
  gEditorProcess = pid ? OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
  gEditorPid = gEditorProcess ? pid : 0;
  gEditorMain = nullptr;
  gEditorWasIconic = false;
}

/**
 * The editor's main window: a visible, unowned top-level window of its process,
 * the one titled "... - Unreal Editor" first. Only calls that never send the
 * window a message, so a hung editor cannot block this.
 */
HWND findEditorMain() {
  struct Search { DWORD pid; HWND best; bool titled; LONG area; } s = {gEditorPid, nullptr, false, 0};
  EnumWindows([](HWND w, LPARAM lp) -> BOOL {
    auto& s = *reinterpret_cast<Search*>(lp);
    if (pidOf(w) != s.pid || !IsWindowVisible(w) || GetWindow(w, GW_OWNER)) return TRUE;
    if (GetWindowLongW(w, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
    wchar_t title[512] = {};
    InternalGetWindowText(w, title, 512);
    bool titled = wcsstr(title, L"Unreal Editor") != nullptr;
    WINDOWPLACEMENT wp = {sizeof wp};
    GetWindowPlacement(w, &wp);
    LONG area = (wp.rcNormalPosition.right - wp.rcNormalPosition.left) * (wp.rcNormalPosition.bottom - wp.rcNormalPosition.top);
    if ((titled && !s.titled) || (titled == s.titled && area > s.area)) {
      s.best = w;
      s.titled = titled;
      s.area = area;
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&s));
  return s.best;
}

/** Whether the window in front is the editor, Studio, or the ghost Windows shows for a hung editor. */
bool attachedInFront(HWND fg) {
  if (!fg) return false;
  DWORD pid = pidOf(fg);
  if (pid == GetCurrentProcessId() || (gEditorPid && pid == gEditorPid)) return true;
  wchar_t cls[64] = {};
  GetClassNameW(fg, cls, 64);
  return gEditorMain && wcscmp(cls, L"Ghost") == 0 && IsHungAppWindow(gEditorMain);
}

void saveState();

/** Follow the editor: its exit, its minimize and restore, and the z-order while either is in front. */
void trackEditor() {
  if (!gMain) return;
  if (gEditorProcess && WaitForSingleObject(gEditorProcess, 0) == WAIT_OBJECT_0) {
    bool close = gOpt.closeWithEditor && !gRestartingEditor;
    setEditor(0);
    if (close) {
      PostMessageW(gMain, WM_CLOSE, 0, 0);
      return;
    }
  }
  if (!gEditorProcess) {
    if (gTopmost) {
      SetWindowPos(gMain, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      gTopmost = false;
    }
    return;
  }
  if (!gEditorMain || !IsWindow(gEditorMain)) gEditorMain = findEditorMain();
  if (gEditorMain) {
    bool iconic = IsIconic(gEditorMain) != FALSE;
    if (iconic && !gEditorWasIconic) {
      if (IsWindowVisible(gMain) && !IsIconic(gMain)) {
        ShowWindow(gMain, SW_SHOWMINNOACTIVE);
        gMinimizedByEditor = true;
      }
    } else if (!iconic && gEditorWasIconic) {
      if (gMinimizedByEditor && IsIconic(gMain)) ShowWindow(gMain, SW_SHOWNOACTIVATE);
      gMinimizedByEditor = false;
    }
    gEditorWasIconic = iconic;
  }
  HWND fg = GetForegroundWindow();
  if (!fg || IsIconic(gMain)) return;
  if (attachedInFront(fg)) {
    if (!gTopmost) {
      SetWindowPos(gMain, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      gTopmost = true;
    }
  } else if (gTopmost) {
    // Behind the app now in front, still above the editor.
    HWND after = (GetWindowLongW(fg, GWL_EXSTYLE) & WS_EX_TOPMOST) ? HWND_NOTOPMOST : fg;
    SetWindowPos(gMain, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    gTopmost = false;
  }
}

void CALLBACK onWinEvent(HWINEVENTHOOK, DWORD, HWND, LONG idObject, LONG, DWORD, DWORD) {
  if (idObject == OBJID_WINDOW) trackEditor();
}

/** Close the editor the way its close button does, then start it again on the same project. */
bool restartEditor() {
  if (!gEditorProcess || !gEditorMain) return false;
  wchar_t exe[MAX_PATH];
  DWORD n = MAX_PATH;
  if (!QueryFullProcessImageNameW(gEditorProcess, 0, exe, &n)) return false;
  std::wstring project = uproject();
  if (project.empty()) return false;
  HANDLE wait = nullptr;
  DuplicateHandle(GetCurrentProcess(), gEditorProcess, GetCurrentProcess(), &wait, 0, FALSE, DUPLICATE_SAME_ACCESS);
  if (!wait) return false;
  gRestartingEditor = true;
  PostMessageW(gEditorMain, WM_CLOSE, 0, 0);
  struct Job { HANDLE wait; std::wstring exe, project, cwd; };
  auto* job = new Job{wait, exe, project, gOpt.project};
  HANDLE t = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
    auto* job = static_cast<Job*>(p);
    DWORD r = WaitForSingleObject(job->wait, 10 * 60 * 1000);
    CloseHandle(job->wait);
    DWORD pid = 0;
    if (r == WAIT_OBJECT_0) createDetached(job->exe, L"\"" + job->exe + L"\" \"" + job->project + L"\"", job->cwd, 0, &pid);
    PostMessageW(gMain, WM_APP + 1, pid, 0);
    delete job;
    return 0;
  }, job, 0, nullptr);
  if (t) CloseHandle(t);
  return t != nullptr;
}

// ---------------------------------------------------------------- window state

void saveState() {
  if (!gMain || gOpt.state.empty()) return;
  WINDOWPLACEMENT wp = {sizeof wp};
  if (!GetWindowPlacement(gMain, &wp)) return;
  const RECT& r = wp.rcNormalPosition;
  char buf[128];
  snprintf(buf, sizeof buf, "%ld %ld %ld %ld %d\n", r.left, r.top, r.right - r.left, r.bottom - r.top, wp.showCmd == SW_SHOWMAXIMIZED ? 1 : 0);
  makeDirs(dirOf(gOpt.state));
  writeFile(gOpt.state, buf);
}

/** Where the window opens: where it was last time when that is still on a screen, else beside the editor. */
void placeWindow() {
  std::string text;
  long x, y, w, h;
  int max = 0;
  if (readFile(gOpt.state, text) && sscanf_s(text.c_str(), "%ld %ld %ld %ld %d", &x, &y, &w, &h, &max) >= 4 && w >= 200 && h >= 200) {
    RECT r = {x, y, x + w, y + h};
    if (MonitorFromRect(&r, MONITOR_DEFAULTTONULL)) {
      WINDOWPLACEMENT wp = {sizeof wp};
      wp.rcNormalPosition = r;
      wp.showCmd = max ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL;
      SetWindowPlacement(gMain, &wp);
      return;
    }
  }
  RECT anchor;
  HMONITOR mon;
  if (gEditorMain && !IsIconic(gEditorMain) && GetWindowRect(gEditorMain, &anchor)) {
    mon = MonitorFromRect(&anchor, MONITOR_DEFAULTTOPRIMARY);
  } else {
    mon = MonitorFromWindow(gMain, MONITOR_DEFAULTTOPRIMARY);
  }
  MONITORINFO mi = {sizeof mi};
  GetMonitorInfoW(mon, &mi);
  const RECT& work = mi.rcWork;
  UINT dpi = GetDpiForWindow(gMain);
  int width = std::min<int>(MulDiv(640, dpi, 96), (work.right - work.left) / 2);
  int height = std::min<int>(MulDiv(900, dpi, 96), (work.bottom - work.top) * 9 / 10);
  int margin = MulDiv(24, dpi, 96);
  int left = work.right - width - margin;
  int top = work.top + ((work.bottom - work.top) - height) / 2;
  SetWindowPos(gMain, nullptr, left, top, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
}

// ---------------------------------------------------------------- the page

std::wstring uiUrl(const Daemon& d) {
  return L"http://127.0.0.1:" + std::to_wstring(d.port) + L"/ui/?token=" + widen(d.token);
}

bool fromDaemon(const std::wstring& url) {
  if (!gLoaded.port) return false;
  std::wstring a = L"http://127.0.0.1:" + std::to_wstring(gLoaded.port) + L"/";
  std::wstring b = L"http://localhost:" + std::to_wstring(gLoaded.port) + L"/";
  return url.rfind(a, 0) == 0 || url.rfind(b, 0) == 0;
}

bool isLocalPage(const std::wstring& url) { return url == L"about:blank" || url.rfind(L"data:text/html", 0) == 0; }

const char* kLocalPage = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><title>UE-MCP Studio</title>
<style>
  html, body { margin: 0; height: 100%; background: #0c0c0b; color: #e9e6e0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; height: 100%; padding: 0 32px; box-sizing: border-box; gap: 10px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  p { margin: 0; color: #a8a49c; max-width: 34em; }
  button { margin-top: 6px; background: #e8720c; color: #0c0c0b; border: 0; border-radius: 6px; padding: 8px 16px; font: 600 13px "Segoe UI", sans-serif; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
</style></head>
<body><main>
  <h1>Studio is not running</h1>
  <p id="text">The ue-mcp daemon that runs Studio for this project is not running. Start it here; this window loads Studio as soon as it is up.</p>
  <button id="start">Start Studio</button>
</main>
<script>
  document.getElementById("start").onclick = function () {
    var b = this;
    b.disabled = true;
    b.textContent = "Starting";
    window.ue.studio.startdaemon().then(function (ok) {
      if (!ok) { b.disabled = false; b.textContent = "Start Studio"; document.getElementById("text").textContent = "The daemon did not start. Node.js must be installed; the project's Saved/Logs/UE_MCP_Studio.log has the details."; }
    });
  };
</script></body></html>)HTML";

// The editor binds a UObject as window.ue.studio, each call a Promise. The same
// names here, answered by the host over postMessage.
const wchar_t* kShim = LR"JS((function () {
  var wv = window.chrome && window.chrome.webview;
  if (!wv || (window.ue && window.ue.studio)) return;
  var next = 1, waiting = {};
  wv.addEventListener("message", function (e) {
    var d = e.data;
    if (d && typeof d === "object" && typeof d.studioReply === "number" && waiting[d.studioReply]) {
      var done = waiting[d.studioReply];
      delete waiting[d.studioReply];
      done(d.result);
    }
  });
  var names = ["getstatus", "startdaemon", "installbridge", "startsetupplan", "getsetupplan", "runsetup", "restarteditor",
    "enableplugin", "openprojectfolder", "geteditortheme", "opennodedownload", "drawattention", "opendocs"];
  var studio = {};
  names.forEach(function (name) {
    studio[name] = function (arg) {
      return new Promise(function (resolve) {
        var id = next++;
        waiting[id] = resolve;
        wv.postMessage(id + "\u001f" + name + "\u001f" + (arg === undefined || arg === null ? "" : String(arg)));
      });
    };
  });
  window.ue = window.ue || {};
  window.ue.studio = studio;
  window.ue.studioWindow = true;
})();)JS";

std::string status() {
  json::Value out = json::Value::object();
  out.set("node", json::Value::boolean(!findNode().empty()));
  out.set("bridgeInstalled", json::Value::boolean(exists(join(join(join(gOpt.project, L"Plugins"), L"UE_MCP_Bridge"), L"UE_MCP_Bridge.uplugin"))));
  out.set("log", json::Value::str(narrow(logPath())));
  out.set("bridgeOnDisk", json::Value::str(""));
  out.set("bridgeNeedsRestart", json::Value::boolean(false));
  out.set("window", json::Value::boolean(true));
  out.set("windowVersion", json::Value::str(STUDIO_WINDOW_VERSION));
  Daemon d;
  if (readDaemon(d)) {
    json::Value daemon = json::Value::object();
    json::Value port;
    port.kind = json::Value::Kind::Number;
    port.n = d.port;
    daemon.set("port", port);
    daemon.set("version", json::Value::str(d.version));
    out.set("daemon", daemon);
  } else {
    out.set("daemon", json::Value());
  }
  std::string text;
  json::write(out, text, 0, false);
  return text;
}

/** One native call from the page: the JSON of its result. */
std::string dispatch(const std::string& method, const std::string& arg) {
  auto b = [](bool v) { return std::string(v ? "true" : "false"); };
  auto s = [](const std::string& v) { return json::quote(v); };
  if (method == "getstatus") return s(status());
  if (method == "startdaemon") return b(startDaemon());
  if (method == "installbridge") return b(installBridge());
  if (method == "startsetupplan") return b(startSetupPlan());
  if (method == "getsetupplan") return s(getSetupPlan());
  if (method == "runsetup") return b(runSetup(arg));
  if (method == "restarteditor") return b(restartEditor());
  if (method == "enableplugin") return b(enablePlugin(arg));
  if (method == "openprojectfolder") {
    ShellExecuteW(nullptr, L"open", gOpt.project.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return b(true);
  }
  if (method == "geteditortheme") {
    // The plugin writes the editor's theme colors here; the editor is never asked.
    std::string text;
    json::Value v;
    return s(readFile(join(studioDir(), L"editor-theme.json"), text) && json::parse(text, v) && v.isObject() ? text : std::string());
  }
  if (method == "opennodedownload") {
    openExternal(L"https://nodejs.org/en/download");
    return b(true);
  }
  if (method == "drawattention") {
    if (GetForegroundWindow() != gMain) {
      FLASHWINFO fi = {sizeof fi, gMain, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
      FlashWindowEx(&fi);
    }
    return b(true);
  }
  if (method == "opendocs") {
    std::string path = arg.empty() ? "/docs/" : arg;
    if (path.rfind("/docs", 0) != 0 || path.find("..") != std::string::npos || path.find("://") != std::string::npos) return b(false);
    openExternal(L"https://ue-mcp.com" + widen(path));
    return b(true);
  }
  return "null";
}

void showLocalPage() {
  gLoaded = Daemon();
  gLocalPage = true;
  if (gWeb) gWeb->NavigateToString(widen(kLocalPage).c_str());
}

/** Load the UI from the project's daemon, follow it to a new port, and explain when it is gone. */
void pollDaemon() {
  if (!gWeb) return;
  Daemon d;
  if (readDaemon(d)) {
    gDaemonMisses = 0;
    if (d.port != gLoaded.port || d.token != gLoaded.token) {
      gLoaded = d;
      gLocalPage = false;
      gWeb->Navigate(uiUrl(d).c_str());
    }
    return;
  }
  // The page reconnects by itself to a daemon that comes back on its port; a few seconds' grace.
  if (gLoaded.port && ++gDaemonMisses >= 5) showLocalPage();
  else if (!gLoaded.port && !gLocalPage) showLocalPage();
}

void resize() {
  if (!gController) return;
  RECT r;
  GetClientRect(gMain, &r);
  gController->put_Bounds(r);
}

void openInBrowserAndQuit(const wchar_t* why) {
  Daemon d;
  if (readDaemon(d)) {
    openExternal(uiUrl(d));
  } else {
    MessageBoxW(gMain, why, L"UE-MCP Studio", MB_OK | MB_ICONWARNING);
  }
  DestroyWindow(gMain);
}

void createWebView() {
  std::wstring data = join(join(env(L"LOCALAPPDATA"), L"ue-mcp"), L"studio-window");
  makeDirs(data);
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, data.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT hr, ICoreWebView2Environment* environment) -> HRESULT {
      if (FAILED(hr) || !environment) {
        openInBrowserAndQuit(L"Studio's window needs the Microsoft Edge WebView2 Runtime, which is not installed. Studio opens in your browser instead.");
        return S_OK;
      }
      gEnv = environment;
      return environment->CreateCoreWebView2Controller(gMain, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
        [](HRESULT hr, ICoreWebView2Controller* controller) -> HRESULT {
          if (FAILED(hr) || !controller) {
            openInBrowserAndQuit(L"Studio's window could not create its browser view.");
            return S_OK;
          }
          gController = controller;
          gController->get_CoreWebView2(&gWeb);
          ComPtr<ICoreWebView2Controller2> c2;
          if (SUCCEEDED(gController.As(&c2))) c2->put_DefaultBackgroundColor({255, 0x0c, 0x0c, 0x0b});

          ComPtr<ICoreWebView2Settings> settings;
          gWeb->get_Settings(&settings);
          bool devtools = !env(L"STUDIO_WINDOW_DEVTOOLS").empty();
          settings->put_AreDevToolsEnabled(devtools);
          settings->put_IsStatusBarEnabled(FALSE);
          settings->put_IsWebMessageEnabled(TRUE);
          ComPtr<ICoreWebView2Settings3> s3;
          if (!devtools && SUCCEEDED(settings.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);

          gWeb->AddScriptToExecuteOnDocumentCreated(kShim, nullptr);

          gWeb->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
              LPWSTR uri = nullptr;
              args->get_Uri(&uri);
              std::wstring url = uri ? uri : L"";
              CoTaskMemFree(uri);
              if (fromDaemon(url) || isLocalPage(url)) return S_OK;
              // Only the daemon's own pages load here; links leave for the system browser.
              args->put_Cancel(TRUE);
              openExternal(url);
              return S_OK;
            }).Get(), nullptr);

          gWeb->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
              LPWSTR uri = nullptr;
              args->get_Uri(&uri);
              std::wstring url = uri ? uri : L"";
              CoTaskMemFree(uri);
              // The daemon's own files (attachments) open in a window of this browser, which has its sign-in.
              if (fromDaemon(url)) return S_OK;
              args->put_Handled(TRUE);
              openExternal(url);
              return S_OK;
            }).Get(), nullptr);

          gWeb->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [](ICoreWebView2* web, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
              LPWSTR source = nullptr;
              args->get_Source(&source);
              std::wstring from = source ? source : L"";
              CoTaskMemFree(source);
              if (!fromDaemon(from) && !isLocalPage(from)) return S_OK;
              LPWSTR raw = nullptr;
              if (FAILED(args->TryGetWebMessageAsString(&raw)) || !raw) return S_OK;
              std::string message = narrow(raw);
              CoTaskMemFree(raw);
              size_t a = message.find('\x1f');
              size_t b = a == std::string::npos ? a : message.find('\x1f', a + 1);
              if (b == std::string::npos) return S_OK;
              std::string id = message.substr(0, a);
              if (id.empty() || id.find_first_not_of("0123456789") != std::string::npos) return S_OK;
              std::string result = dispatch(message.substr(a + 1, b - a - 1), message.substr(b + 1));
              web->PostWebMessageAsJson(widen("{\"studioReply\":" + id + ",\"result\":" + result + "}").c_str());
              return S_OK;
            }).Get(), nullptr);

          gWeb->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
              COREWEBVIEW2_PROCESS_FAILED_KIND kind;
              args->get_ProcessFailedKind(&kind);
              if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
                openInBrowserAndQuit(L"Studio's browser view stopped.");
              } else if (gWeb) {
                gLoaded = Daemon();
                gLocalPage = false;
                pollDaemon();
              }
              return S_OK;
            }).Get(), nullptr);

          resize();
          pollDaemon();
          gController->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
          return S_OK;
        }).Get());
    }).Get());
  if (FAILED(hr)) openInBrowserAndQuit(L"Studio's window needs the Microsoft Edge WebView2 Runtime, which is not installed. Studio opens in your browser instead.");
}

// ---------------------------------------------------------------- windows

void bringToFront() {
  if (!gMain) return;
  if (IsIconic(gMain)) ShowWindow(gMain, SW_RESTORE);
  else ShowWindow(gMain, SW_SHOW);
  gMinimizedByEditor = false;
  if (!SetForegroundWindow(gMain)) {
    FLASHWINFO fi = {sizeof fi, gMain, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&fi);
  }
  trackEditor();
}

/** A second launch for this project: take its editor, come to the front. */
LRESULT onHandOff(const COPYDATASTRUCT* cds) {
  if (!cds || cds->dwData != kCopyArgs || cds->cbData < sizeof(wchar_t) || cds->cbData > 64 * 1024) return 0;
  std::wstring line(static_cast<const wchar_t*>(cds->lpData), cds->cbData / sizeof(wchar_t));
  while (!line.empty() && line.back() == L'\0') line.pop_back();
  Options o;
  if (!parseArgs(line.c_str(), o) || o.key != gOpt.key) return 0;
  if (!gOpt.instanceTest.empty()) {
    appendFile(gOpt.instanceTest, "args " + narrow(line) + "\n");
    if (o.quit) PostQuitMessage(0);
    return kHandedOff;
  }
  // A launch from a different build replaces this one, so an update takes effect on the next open.
  if (!o.senderVersion.empty() && o.senderVersion != widen(STUDIO_WINDOW_VERSION)) {
    PostMessageW(gMain, WM_CLOSE, 0, 0);
    return kReplaceMe;
  }
  if (o.quit) {
    PostMessageW(gMain, WM_CLOSE, 0, 0);
    return kHandedOff;
  }
  if (o.editorPid) {
    setEditor(o.editorPid);
    gOpt.closeWithEditor = o.closeWithEditor;
  }
  if (!o.node.empty()) gOpt.node = o.node;
  if (!o.ueMcp.empty()) gOpt.ueMcp = o.ueMcp;
  bringToFront();
  return kHandedOff;
}

LRESULT CALLBACK messageProc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_COPYDATA) return onHandOff(reinterpret_cast<const COPYDATASTRUCT*>(lp));
  if (msg == WM_TIMER && wp == kTestTimer) PostQuitMessage(0);
  return DefWindowProcW(w, msg, wp, lp);
}

LRESULT CALLBACK mainProc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      resize();
      return 0;
    case WM_MOVE:
      if (gController) gController->NotifyParentWindowPositionChanged();
      return 0;
    case WM_SETFOCUS:
      if (gController) gController->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      return 0;
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(w, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: {
      auto* mm = reinterpret_cast<MINMAXINFO*>(lp);
      UINT dpi = GetDpiForWindow(w);
      mm->ptMinTrackSize = {MulDiv(320, dpi, 96), MulDiv(360, dpi, 96)};
      return 0;
    }
    case WM_ERASEBKGND: {
      RECT r;
      GetClientRect(w, &r);
      HBRUSH brush = CreateSolidBrush(RGB(0x0c, 0x0c, 0x0b));
      FillRect(reinterpret_cast<HDC>(wp), &r, brush);
      DeleteObject(brush);
      return 1;
    }
    case WM_TIMER:
      if (wp == kDaemonTimer) pollDaemon();
      else if (wp == kEditorTimer) trackEditor();
      return 0;
    case WM_EXITSIZEMOVE:
      saveState();
      return 0;
    case WM_APP + 1:
      // The editor restart finished: follow the new editor.
      gRestartingEditor = false;
      if (wp) setEditor((DWORD)wp);
      return 0;
    case WM_CLOSE:
      saveState();
      DestroyWindow(w);
      return 0;
    case WM_DESTROY:
      for (HWINEVENTHOOK h : gHooks) if (h) UnhookWinEvent(h);
      if (gController) gController->Close();
      gController.Reset();
      gWeb.Reset();
      gMain = nullptr;
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(w, msg, wp, lp);
}

/** The window icon: the Studio mark, an accent dot on a dark tile. */
HICON makeIcon(int size) {
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

/**
 * One window per project. The first launch holds a mutex named for the
 * project and a message window that takes later launches' arguments. A later
 * launch hands its command line over and exits; when the running window is a
 * different build, it closes and the new launch takes over.
 */
enum class Instance { Primary, HandedOff, Failed };

Instance claimInstance(const std::wstring& key) {
  gMutex = CreateMutexW(nullptr, TRUE, (L"Local\\UEMCPStudioWindow." + key).c_str());
  if (!gMutex) return Instance::Failed;
  if (GetLastError() != ERROR_ALREADY_EXISTS) return Instance::Primary;
  std::wstring cls = std::wstring(kMainClass) + L"." + key;
  std::wstring line = GetCommandLineW();
  line += L" --sender-version " + widen(STUDIO_WINDOW_VERSION);
  for (int attempt = 0; attempt < 100; ++attempt) {
    HWND other = FindWindowExW(HWND_MESSAGE, nullptr, cls.c_str(), nullptr);
    if (other) {
      AllowSetForegroundWindow(pidOf(other));
      COPYDATASTRUCT cds = {kCopyArgs, (DWORD)((line.size() + 1) * sizeof(wchar_t)), line.data()};
      DWORD_PTR result = 0;
      if (SendMessageTimeoutW(other, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds), SMTO_ABORTIFHUNG, 5000, &result)) {
        if (result == kHandedOff) return Instance::HandedOff;
        if (result == kReplaceMe) {
          DWORD r = WaitForSingleObject(gMutex, 15000);
          return r == WAIT_OBJECT_0 || r == WAIT_ABANDONED ? Instance::Primary : Instance::Failed;
        }
      }
    }
    // The first window may still be starting, or just exiting and about to free the mutex.
    DWORD r = WaitForSingleObject(gMutex, 100);
    if (r == WAIT_OBJECT_0 || r == WAIT_ABANDONED) return Instance::Primary;
  }
  return Instance::Failed;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  gInstance = instance;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  // Studio starts this with its arguments; anything else is not a launch to answer.
  if (!parseArgs(GetCommandLineW(), gOpt)) return 2;
  Instance claim = claimInstance(gOpt.key);
  if (claim == Instance::HandedOff) return 0;
  if (claim == Instance::Failed) return 1;

  WNDCLASSEXW mc = {sizeof mc};
  mc.lpfnWndProc = messageProc;
  mc.hInstance = instance;
  std::wstring messageClass = std::wstring(kMainClass) + L"." + gOpt.key;
  mc.lpszClassName = messageClass.c_str();
  RegisterClassExW(&mc);
  gMessage = CreateWindowExW(0, messageClass.c_str(), L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
  if (!gMessage) return 1;

  if (!gOpt.instanceTest.empty()) {
    // Tests: the single-instance protocol alone, no window and no browser.
    appendFile(gOpt.instanceTest, "ready " + std::to_string(GetCurrentProcessId()) + "\n");
    SetTimer(gMessage, kTestTimer, 60000, nullptr);
    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) DispatchMessageW(&m);
    return 0;
  }

  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  setEditor(gOpt.editorPid);
  if (gEditorProcess) gEditorMain = findEditorMain();

  WNDCLASSEXW wc = {sizeof wc};
  wc.lpfnWndProc = mainProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hIcon = makeIcon(GetSystemMetrics(SM_CXICON));
  wc.hIconSm = makeIcon(GetSystemMetrics(SM_CXSMICON));
  wc.lpszClassName = kMainClass;
  RegisterClassExW(&wc);
  std::wstring title = gOpt.title.empty() ? L"UE-MCP Studio" : L"UE-MCP Studio - " + gOpt.title;
  gMain = CreateWindowExW(0, kMainClass, title.c_str(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 640, 900, nullptr, nullptr, instance, nullptr);
  if (!gMain) return 1;
  BOOL dark = TRUE;
  DwmSetWindowAttribute(gMain, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
  placeWindow();
  WINDOWPLACEMENT wp = {sizeof wp};
  GetWindowPlacement(gMain, &wp);
  // Shown explicitly: a launcher that asked for a hidden start would otherwise hide the window.
  ShowWindow(gMain, wp.showCmd == SW_SHOWMAXIMIZED ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
  SetForegroundWindow(gMain);

  gHooks[0] = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, onWinEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  gHooks[1] = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, nullptr, onWinEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  SetTimer(gMain, kDaemonTimer, 1000, nullptr);
  SetTimer(gMain, kEditorTimer, 200, nullptr);
  trackEditor();
  createWebView();

  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  if (gEditorProcess) CloseHandle(gEditorProcess);
  CoUninitialize();
  return 0;
}
