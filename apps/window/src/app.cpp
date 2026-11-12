// UE-MCP.exe: the UE-MCP app and its setup, one program.
//
// Installed under %LOCALAPPDATA%\Programs\UE-MCP and started from there, it is
// the app: this computer's Unreal projects, their updates and the daemons
// running for them. Started from anywhere else, it is the setup that installs
// it there. Its page is compiled into the exe (ui-files.h) and served at
// https://app.ue-mcp.invalid/; the page reaches the host through window.ue.app.
//
// Everything about ue-mcp's own state comes from ue-mcp: `ue-mcp projects
// --json` for the report, `daemon start|stop` and `install` as background
// jobs, and a short allowlist of daemon routes (job::allowed), called with the
// token from the discovery file so the page never holds one. It contains no
// chat: Open Studio asks the project's daemon to bring Studio's own window up.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <knownfolders.h>
#include <objbase.h>
#include <propkey.h>
#include <propvarutil.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <winhttp.h>
#include <wrl.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "WebView2.h"
#include "channel.h"
#include "host.h"
#include "job.h"
#include "json.h"
#include "update.h"
#include "watch.h"
#include "ui-files.h"

#ifndef STUDIO_WINDOW_VERSION
#define STUDIO_WINDOW_VERSION "0.0.0"
#endif

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

using namespace host;

const wchar_t* kOrigin = L"https://app.ue-mcp.invalid";
const wchar_t* kAumid = L"UE-MCP.App";
const wchar_t* kMainClass = L"UEMCPApp";
const wchar_t* kMessageClass = L"UEMCPApp.Message";
const wchar_t* kUninstallKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UE-MCP";
const wchar_t* kWebView2Download = L"https://developer.microsoft.com/microsoft-edge/webview2/";
/** The machine report versions this app reads (ue-mcp's MACHINE_REPORT_VERSION). */
constexpr int kReportVersion = 1;
constexpr int kNodeMajorMin = 20;
constexpr UINT kReply = WM_APP + 1;
/** A watched file changed (watch.h); the page hears of it once the burst settles. */
constexpr UINT kChanged = WM_APP + 2;
constexpr UINT_PTR kChangedTimer = 1;
constexpr ULONG_PTR kCopyArgs = 0x55454D43;  // "UEMC"

// ---------------------------------------------------------------- paths and state

std::wstring localAppData() { return env(L"LOCALAPPDATA"); }
std::wstring installDir() { return join(join(localAppData(), L"Programs"), L"UE-MCP"); }
std::wstring installedExe() { return join(installDir(), L"UE-MCP.exe"); }
std::wstring dataDir() { return join(localAppData(), L"UE-MCP"); }
std::wstring jobsDir() { return join(dataDir(), L"jobs"); }
std::wstring reportCache() { return join(dataDir(), L"report.json"); }
std::wstring versionCache() { return join(dataDir(), L"ue-mcp-version.txt"); }

std::wstring selfPath() {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH * 2);
  return std::wstring(buf, n);
}

std::wstring fullPath(const std::wstring& p) {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetFullPathNameW(p.c_str(), MAX_PATH * 2, buf, nullptr);
  return n ? std::wstring(buf, n) : p;
}

bool samePath(const std::wstring& a, const std::wstring& b) { return CompareStringOrdinal(fullPath(a).c_str(), -1, fullPath(b).c_str(), -1, TRUE) == CSTR_EQUAL; }

enum class Mode { App, Setup };
Mode gMode = Mode::Setup;
bool gSilent = false;
HWND gMain = nullptr;
HWND gMessage = nullptr;
HANDLE gMutex = nullptr;
ComPtr<ICoreWebView2Environment> gEnv;
ComPtr<ICoreWebView2Controller> gController;
ComPtr<ICoreWebView2> gWeb;

std::mutex gLock;            // guards what worker threads share below
std::wstring gNode;          // node.exe
std::string gNodeVersion;    // v22.1.0
std::wstring gExact;         // the resolved ue-mcp version
bool gResolved = false;
std::map<std::wstring, bool> gCanReport;  // ue-mcp spec -> lists `projects` in its help
std::wstring gDaemonDir;     // from the last report
int gJobNext = 1;

/** Studio's channel file, shared with the agent: one Stable or Beta choice for the machine. */
std::wstring channelFile() {
  std::wstring dev = env(L"STUDIO_CHANNEL_FILE");
  return !dev.empty() ? dev : join(join(join(env(L"USERPROFILE"), L".ue-mcp"), L"studio"), L"update-channel.json");
}

/** "stable" or "beta". */
std::string channelName() {
  std::string text;
  return readFile(channelFile(), text) ? appchannel::parse(text) : "stable";
}

/** ue-mcp's npm dist-tag on the channel: latest or beta. */
std::wstring channelTag() { return widen(appchannel::npmTag(channelName())); }

/** Keep the choice for Studio and the app alike; ue-mcp's version is resolved again on its new tag. */
bool setChannel(const std::string& channel) {
  std::wstring file = channelFile();
  makeDirs(dirOf(file));
  if (!writeFile(file, appchannel::fileText(channel))) return false;
  std::lock_guard<std::mutex> g(gLock);
  gResolved = false;
  gExact.clear();
  return true;
}

std::wstring daemonDir() {
  std::lock_guard<std::mutex> g(gLock);
  return gDaemonDir.empty() ? join(join(env(L"USERPROFILE"), L".ue-mcp"), L"daemons") : gDaemonDir;
}

// ---------------------------------------------------------------- processes

/** Run a command line hidden and wait for it. -1 when it did not start or ran past the timeout. */
int runAndWait(const std::wstring& exe, std::wstring line, DWORD timeoutMs) {
  STARTUPINFOW si = {sizeof si};
  PROCESS_INFORMATION pi = {};
  if (!CreateProcessW(exe.c_str(), line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return -1;
  CloseHandle(pi.hThread);
  DWORD r = WaitForSingleObject(pi.hProcess, timeoutMs);
  DWORD code = 1;
  if (r == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  return r == WAIT_OBJECT_0 ? (int)code : -1;
}

std::wstring cmdExe() { return join(join(env(L"SystemRoot"), L"System32"), L"cmd.exe"); }

std::wstring searchPath(const wchar_t* exe) {
  wchar_t buf[MAX_PATH];
  return SearchPathW(nullptr, exe, nullptr, MAX_PATH, buf, nullptr) ? std::wstring(buf) : std::wstring();
}

/** PATH as Windows has it now, so a Node.js installed while the app runs is found. */
void refreshPath() {
  auto read = [](HKEY root, const wchar_t* key) {
    wchar_t buf[32767];
    DWORD size = sizeof buf;
    return RegGetValueW(root, key, L"Path", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, nullptr, buf, &size) == ERROR_SUCCESS ? std::wstring(buf) : std::wstring();
  };
  std::wstring raw = read(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment") + L";" + read(HKEY_CURRENT_USER, L"Environment");
  wchar_t expanded[32767];
  if (ExpandEnvironmentStringsW(raw.c_str(), expanded, 32767)) SetEnvironmentVariableW(L"PATH", expanded);
}

/** Node.js and its version, read again. */
void probeNode() {
  std::wstring node = findNode();
  std::string version;
  if (!node.empty()) {
    makeDirs(jobsDir());
    std::wstring out = join(jobsDir(), L"node-version.txt");
    DeleteFileW(out.c_str());
    runAndWait(cmdExe(), L"\"" + cmdExe() + L"\" /d /s /c \"\"" + node + L"\" --version > \"" + out + L"\"\"", 10000);
    readFile(out, version);
    while (!version.empty() && (version.back() == '\n' || version.back() == '\r' || version.back() == ' ')) version.pop_back();
  }
  std::lock_guard<std::mutex> g(gLock);
  gNode = node;
  gNodeVersion = version;
  std::wstring dir = dirOf(node);
  std::wstring path = env(L"PATH");
  if (!dir.empty() && path.find(dir) == std::wstring::npos) SetEnvironmentVariableW(L"PATH", (dir + L";" + path).c_str());
}

int nodeMajor(const std::string& v) {
  size_t i = v.size() && v[0] == 'v' ? 1 : 0;
  return atoi(v.c_str() + i);
}

std::wstring npxCmd() {
  std::lock_guard<std::mutex> g(gLock);
  return gNode.empty() ? std::wstring() : join(dirOf(gNode), L"npx.cmd");
}

struct Captured {
  int code = -1;
  std::string out;
  std::string err;
};

/** A command under cmd, its stdout and stderr read back from files. */
Captured capture(const std::wstring& line, DWORD timeoutMs) {
  makeDirs(jobsDir());
  int n;
  {
    std::lock_guard<std::mutex> g(gLock);
    n = gJobNext++;
  }
  std::wstring base = join(jobsDir(), L"capture-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(n));
  std::wstring out = base + L".out", err = base + L".err", exit = base + L".exit";
  Captured c;
  int r = runAndWait(cmdExe(), L"\"" + cmdExe() + L"\" /d /s /c \"" + job::wrap(line, out, exit, err) + L"\"", timeoutMs);
  std::string exitText;
  readFile(out, c.out);
  readFile(err, c.err);
  c.code = r < 0 ? -1 : (readFile(exit, exitText) && !exitText.empty() && exitText[0] == '0' ? 0 : 1);
  for (const std::wstring& f : {out, err, exit}) DeleteFileW(f.c_str());
  return c;
}

/**
 * The exact ue-mcp version the channel's npm tag names, once a session; the
 * last one known when npm cannot say; empty when neither is known.
 */
std::wstring channelUeMcp() {
  std::wstring tag = channelTag();
  bool resolved;
  {
    std::lock_guard<std::mutex> g(gLock);
    resolved = gResolved;
  }
  if (!resolved) {
    std::wstring npx = npxCmd();
    std::wstring version;
    if (!npx.empty()) {
      Captured c = capture(L"\"" + join(dirOf(npx), L"npm.cmd") + L"\" view ue-mcp@" + tag + L" version", 30000);
      std::vector<std::string> lines = job::lines(c.out);
      if (c.code == 0 && !lines.empty() && ueupdate::validVersion(lines.back())) {
        version = widen(lines.back());
        makeDirs(dataDir());
        writeFile(versionCache(), narrow(tag + L" " + version));
      }
    }
    if (version.empty()) {
      std::string cached;
      if (readFile(versionCache(), cached)) {
        size_t sp = cached.find(' ');
        if (sp != std::string::npos && widen(cached.substr(0, sp)) == tag && ueupdate::validVersion(cached.substr(sp + 1))) version = widen(cached.substr(sp + 1));
      }
    }
    std::lock_guard<std::mutex> g(gLock);
    gExact = version;
    gResolved = true;
  }
  std::lock_guard<std::mutex> g(gLock);
  return gExact;
}

/**
 * The ue-mcp spec to run: the channel's exact version, else its tag.
 * UE_MCP_APP_PACKAGE names another spec, such as a local ue-mcp tarball, for development.
 */
std::wstring resolvedSpec() {
  std::wstring dev = env(L"UE_MCP_APP_PACKAGE");
  if (!dev.empty() && dev.find_first_of(L"\"%^&|<> ") == std::wstring::npos) return dev;
  std::wstring exact = channelUeMcp();
  return job::spec(channelTag(), exact);
}

/** A path ue-mcp is handed on a command line: a .uproject that exists, nothing cmd would expand. */
bool safeUproject(const std::wstring& p) {
  if (p.size() < 10 || p.find_first_of(L"\"%^&|<>\r\n") != std::wstring::npos) return false;
  std::wstring ext = p.substr(p.size() - 9);
  return CompareStringOrdinal(ext.c_str(), -1, L".uproject", -1, TRUE) == CSTR_EQUAL && exists(p);
}

// ---------------------------------------------------------------- jobs

struct Job {
  std::wstring out, exit;
  bool node = false;  // a Node.js install: PATH is read again when it ends
  bool settled = false;
};
std::map<int, Job> gJobs;

/** Start a background job; its id, or 0 when it could not start. */
int startJob(const std::wstring& line, bool nodeInstall = false) {
  makeDirs(jobsDir());
  int id;
  {
    std::lock_guard<std::mutex> g(gLock);
    id = gJobNext++;
  }
  std::wstring base = join(jobsDir(), L"job-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(id));
  Job j{base + L".out", base + L".exit", nodeInstall};
  DeleteFileW(j.out.c_str());
  DeleteFileW(j.exit.c_str());
  if (!createDetached(cmdExe(), L"\"" + cmdExe() + L"\" /d /s /c \"" + job::wrap(line, j.out, j.exit) + L"\"", {}, CREATE_NO_WINDOW)) return 0;
  gJobs[id] = j;
  return id;
}

/** A job for the page: running, its last lines, and once it ends whether it worked and what it said. */
std::string jobState(int id) {
  auto it = gJobs.find(id);
  json::Value v = json::Value::object();
  if (it == gJobs.end()) {
    v.set("running", json::Value::boolean(false));
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str("This job is not known."));
  } else {
    std::string output, exitText;
    readFile(it->second.out, output);
    bool exited = readFile(it->second.exit, exitText) && !exitText.empty();
    bool ok = exited && exitText[0] == '0';
    std::vector<std::string> lines = job::lines(output);
    json::Value list;
    list.kind = json::Value::Kind::Array;
    list.a = std::make_shared<json::Array>();
    for (size_t i = lines.size() > 60 ? lines.size() - 60 : 0; i < lines.size(); ++i) {
      // ue-mcp's info-level diagnostics stay out of what the page shows.
      if (lines[i].find("[ue-mcp] info ") != std::string::npos) continue;
      list.a->push_back(json::Value::str(lines[i]));
    }
    v.set("running", json::Value::boolean(!exited));
    v.set("ok", json::Value::boolean(ok));
    v.set("lines", list);
    if (exited && !ok) v.set("error", json::Value::str(job::failureText(output)));
    if (exited && it->second.node && !it->second.settled) {
      it->second.settled = true;
      refreshPath();
      probeNode();
    }
  }
  std::string text;
  json::write(v, text, 0, false);
  return text;
}

// ---------------------------------------------------------------- http

struct Http {
  bool ok = false;
  DWORD status = 0;
  std::string body;
  std::string error;
};

Http http(const std::wstring& url, const std::wstring& method, const std::string& body, const std::wstring& headers, DWORD timeoutMs, bool local) {
  Http r;
  URL_COMPONENTS u = {sizeof u};
  wchar_t hostName[256] = {}, path[2048] = {};
  u.lpszHostName = hostName;
  u.dwHostNameLength = 256;
  u.lpszUrlPath = path;
  u.dwUrlPathLength = 2048;
  wchar_t extra[2048] = {};
  u.lpszExtraInfo = extra;
  u.dwExtraInfoLength = 2048;
  if (!WinHttpCrackUrl(url.c_str(), 0, 0, &u)) {
    r.error = "bad address";
    return r;
  }
  HINTERNET s = WinHttpOpen(L"UE-MCP/" STUDIO_WINDOW_VERSION, local ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) {
    r.error = "WinHTTP did not start";
    return r;
  }
  WinHttpSetTimeouts(s, (int)timeoutMs, (int)timeoutMs, (int)timeoutMs, (int)timeoutMs);
  HINTERNET c = WinHttpConnect(s, hostName, u.nPort, 0);
  HINTERNET q = c ? WinHttpOpenRequest(c, method.c_str(), (std::wstring(path) + extra).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                       u.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)
                  : nullptr;
  if (q && WinHttpSendRequest(q, headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(), (DWORD)-1L, body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
                              (DWORD)body.size(), (DWORD)body.size(), 0) &&
      WinHttpReceiveResponse(q, nullptr)) {
    DWORD size = sizeof r.status;
    WinHttpQueryHeaders(q, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &r.status, &size, WINHTTP_NO_HEADER_INDEX);
    for (;;) {
      DWORD avail = 0;
      if (!WinHttpQueryDataAvailable(q, &avail) || !avail) break;
      std::string chunk(avail, '\0');
      DWORD got = 0;
      if (!WinHttpReadData(q, chunk.data(), avail, &got) || !got) break;
      r.body.append(chunk.data(), got);
      if (r.body.size() > (64u << 20)) break;
    }
    r.ok = true;
  } else {
    DWORD e = GetLastError();
    r.error = e == ERROR_WINHTTP_TIMEOUT ? "timed out" : e == ERROR_WINHTTP_CANNOT_CONNECT ? "could not connect" : "network error " + std::to_string(e);
  }
  if (q) WinHttpCloseHandle(q);
  if (c) WinHttpCloseHandle(c);
  WinHttpCloseHandle(s);
  return r;
}

struct Daemon {
  int port = 0;
  std::string token;
};

/** The live daemon for a project key, from its discovery file. */
bool readDaemon(const std::string& key, Daemon& d, DWORD* pidOut = nullptr, std::string* version = nullptr) {
  if (!job::validKey(key)) return false;
  std::string text;
  json::Value v;
  if (!readFile(join(daemonDir(), widen(key) + L".json"), text) || !json::parse(text, v)) return false;
  const json::Value* pid = v.get("pid");
  const json::Value* port = v.get("port");
  const json::Value* token = v.get("token");
  if (!pid || !pid->isNumber() || !port || !port->isNumber() || !token || !token->isString() || token->s.empty()) return false;
  for (char ch : token->s) if (!isxdigit((unsigned char)ch)) return false;
  if (!processAlive((DWORD)pid->n)) return false;
  d.port = (int)port->n;
  d.token = token->s;
  if (pidOut) *pidOut = (DWORD)pid->n;
  if (version) {
    const json::Value* ver = v.get("version");
    *version = ver && ver->isString() ? ver->s : "";
  }
  return true;
}

/** One allowlisted call to a project's daemon, as {status, body} JSON. */
std::string callDaemon(const std::string& key, const std::string& method, const std::string& path, const std::string& body, DWORD timeoutMs = 15000) {
  json::Value v = json::Value::object();
  Daemon d;
  if (!job::allowed(method, path)) {
    v.set("error", json::Value::str("not a call the app makes"));
  } else if (!readDaemon(key, d)) {
    v.set("error", json::Value::str("ue-mcp is not running for this project"));
  } else {
    Http r = http(L"http://127.0.0.1:" + std::to_wstring(d.port) + widen(path), widen(method), body,
                  L"Authorization: Bearer " + widen(d.token) + L"\r\nContent-Type: application/json\r\n", timeoutMs, true);
    if (!r.ok) {
      v.set("error", json::Value::str("ue-mcp did not answer: " + r.error));
    } else {
      json::Value status;
      status.kind = json::Value::Kind::Number;
      status.n = r.status;
      v.set("status", status);
      v.set("body", json::Value::str(r.body));
    }
  }
  std::string text;
  json::write(v, text, 0, false);
  return text;
}

/** Start the project's daemon when it is not running, and wait for it. Empty when it runs, else why not. */
std::string ensureDaemon(const std::string& key, const std::wstring& uproject) {
  Daemon d;
  if (readDaemon(key, d)) return {};
  std::wstring npx = npxCmd();
  if (npx.empty()) return "Node.js was not found.";
  if (!safeUproject(uproject)) return "The project file could not be used.";
  Captured c = capture(job::npx(npx, resolvedSpec(), L"daemon start \"" + uproject + L"\""), 150000);
  if (c.code != 0) return "ue-mcp did not start: " + job::failureText(c.out + c.err);
  return readDaemon(key, d) ? std::string() : "ue-mcp started but has not published its address yet.";
}

// ---------------------------------------------------------------- watching

struct Watched {
  std::wstring dir;
  watch::Root root;
  bool operator==(const Watched& o) const { return root == o.root && dir == o.dir; }
};
std::vector<Watched> gWatchList;  // under gLock: what the watcher thread watches
HANDLE gRewatch = nullptr;         // set when gWatchList changes
ULONGLONG gFirstChange = 0;        // window thread: the first change the page has not heard of

std::wstring ueMcpHome() { return join(env(L"USERPROFILE"), L".ue-mcp"); }

/** Watch the daemons folder, state.json, and these projects' folders and Plugins. */
void watchProjects(const std::vector<std::wstring>& dirs) {
  std::vector<Watched> list = {{daemonDir(), watch::Root::Daemons}, {ueMcpHome(), watch::Root::Home}};
  // WaitForMultipleObjects takes 64 handles, one of them the rewatch event.
  for (const std::wstring& d : dirs) {
    if (list.size() + 2 > 63) break;
    list.push_back({d, watch::Root::Project});
    list.push_back({join(d, L"Plugins"), watch::Root::Plugins});
  }
  {
    std::lock_guard<std::mutex> g(gLock);
    if (list == gWatchList) return;
    gWatchList = list;
  }
  if (gRewatch) SetEvent(gRewatch);
}

/** Watch the projects a report lists. */
void watchReport(const std::string& text) {
  json::Value report;
  std::vector<std::wstring> dirs;
  if (json::parse(text, report)) {
    if (const json::Value* projects = report.get("projects"); projects && projects->isArray()) {
      for (const json::Value& p : *projects->a) {
        const json::Value* dir = p.get("dir");
        if (dir && dir->isString() && !dir->s.empty()) dirs.push_back(widen(dir->s));
      }
    }
  }
  watchProjects(dirs);
}

struct OpenWatch {
  Watched w;
  HANDLE dir = INVALID_HANDLE_VALUE;
  OVERLAPPED ov = {};
  DWORD buf[4096];  // FILE_NOTIFY_INFORMATION records are DWORD aligned
};

bool armWatch(OpenWatch& o) {
  DWORD filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE;
  return ReadDirectoryChangesW(o.dir, o.buf, sizeof o.buf, o.w.root == watch::Root::Plugins, filter, nullptr, &o.ov, nullptr) != 0;
}

void closeWatch(OpenWatch& o) {
  if (o.dir != INVALID_HANDLE_VALUE) {
    // The kernel writes into buf until the read is cancelled and has completed.
    DWORD got = 0;
    if (CancelIoEx(o.dir, &o.ov) || GetLastError() != ERROR_NOT_FOUND) GetOverlappedResult(o.dir, &o.ov, &got, TRUE);
    CloseHandle(o.dir);
    o.dir = INVALID_HANDLE_VALUE;
  }
  if (o.ov.hEvent) CloseHandle(o.ov.hEvent);
  o.ov.hEvent = nullptr;
}

/** The watcher thread: tells the window whenever a change could change the report. */
void watcher() {
  std::vector<std::unique_ptr<OpenWatch>> open;
  for (;;) {
    std::vector<HANDLE> waits = {gRewatch};
    std::vector<OpenWatch*> who = {nullptr};
    for (auto& o : open) {
      if (o->dir == INVALID_HANDLE_VALUE) continue;
      waits.push_back(o->ov.hEvent);
      who.push_back(o.get());
    }
    DWORD r = WaitForMultipleObjects((DWORD)waits.size(), waits.data(), FALSE, INFINITE);
    if (r == WAIT_OBJECT_0) {
      for (auto& o : open) closeWatch(*o);
      open.clear();
      std::vector<Watched> list;
      {
        std::lock_guard<std::mutex> g(gLock);
        list = gWatchList;
      }
      for (const Watched& w : list) {
        auto o = std::make_unique<OpenWatch>();
        o->w = w;
        o->dir = CreateFileW(w.dir.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, nullptr);
        if (o->dir == INVALID_HANDLE_VALUE) continue;  // not there (yet): read again on the next report
        o->ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!o->ov.hEvent || !armWatch(*o)) {
          closeWatch(*o);
          continue;
        }
        open.push_back(std::move(o));
      }
      continue;
    }
    size_t i = r - WAIT_OBJECT_0;
    if (r < WAIT_OBJECT_0 || i >= who.size()) {
      Sleep(1000);
      continue;
    }
    OpenWatch& o = *who[i];
    DWORD got = 0;
    bool any = false;
    if (!GetOverlappedResult(o.dir, &o.ov, &got, FALSE)) {
      closeWatch(o);  // the folder went away
      if (gMain) PostMessageW(gMain, kChanged, 0, 0);
      continue;
    }
    if (got == 0) {
      // More changed than the buffer held. Plugins churn under a build; the others are worth a read.
      any = o.w.root != watch::Root::Plugins && o.w.root != watch::Root::Daemons;
    } else {
      const BYTE* p = reinterpret_cast<const BYTE*>(o.buf);
      for (;;) {
        auto* fni = reinterpret_cast<const FILE_NOTIFY_INFORMATION*>(p);
        if (watch::relevant(o.w.root, std::wstring(fni->FileName, fni->FileNameLength / sizeof(wchar_t)))) any = true;
        if (!fni->NextEntryOffset) break;
        p += fni->NextEntryOffset;
      }
    }
    ResetEvent(o.ov.hEvent);
    if (any && gMain) PostMessageW(gMain, kChanged, 0, 0);
    if (!armWatch(o)) closeWatch(o);
  }
}

// ---------------------------------------------------------------- the report

std::string answer(json::Value v) {
  std::string text;
  json::write(v, text, 0, false);
  return text;
}

/**
 * The machine report from ue-mcp, checked: Node.js present, a ue-mcp that has
 * the command, a report version this app reads. A failed read carries the last
 * good report, marked with when it was read.
 */
std::string readReport() {
  json::Value v = json::Value::object();
  auto failed = [&](const char* reason, const std::string& error) {
    v.set("ok", json::Value::boolean(false));
    v.set("reason", json::Value::str(reason));
    if (!error.empty()) v.set("error", json::Value::str(error));
    std::string cached;
    json::Value c;
    WIN32_FILE_ATTRIBUTE_DATA a;
    if (readFile(reportCache(), cached) && json::parse(cached, c) && GetFileAttributesExW(reportCache().c_str(), GetFileExInfoStandard, &a)) {
      v.set("cached", json::Value::str(cached));
      SYSTEMTIME st;
      FileTimeToSystemTime(&a.ftLastWriteTime, &st);
      char at[40];
      snprintf(at, sizeof at, "%04d-%02d-%02dT%02d:%02d:%02dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
      v.set("cachedAt", json::Value::str(at));
    }
    return answer(v);
  };
  std::wstring npx = npxCmd();
  if (npx.empty()) return failed("node", "");
  std::wstring spec = resolvedSpec();
  v.set("ueMcp", json::Value::str(narrow(spec)));
  bool known, can = false;
  {
    std::lock_guard<std::mutex> g(gLock);
    known = gCanReport.count(spec) > 0;
    if (known) can = gCanReport[spec];
  }
  if (!known) {
    // An older ue-mcp takes an unknown first word for a project and starts a server, so ask its help first.
    Captured h = capture(job::npx(npx, spec, L"help"), 120000);
    if (h.code != 0 && h.out.empty()) return failed("failed", job::failureText(h.out + h.err));
    for (const std::string& l : job::lines(h.out)) {
      size_t i = l.find_first_not_of(' ');
      if (i != std::string::npos && l.compare(i, 9, "projects ") == 0) can = true;
    }
    std::lock_guard<std::mutex> g(gLock);
    gCanReport[spec] = can;
  }
  if (!can) return failed("unsupported", "");
  Captured r = capture(job::npx(npx, spec, L"projects --json"), 120000);
  json::Value report;
  if (r.code != 0 || !json::parse(r.out, report) || !report.isObject()) return failed("failed", job::failureText(r.out + r.err));
  const json::Value* ver = report.get("version");
  if (!ver || !ver->isNumber() || (int)ver->n != kReportVersion) {
    v.set("reportVersion", ver && ver->isNumber() ? *ver : json::Value());
    return failed("version", "");
  }
  if (const json::Value* dir = report.get("daemonDir"); dir && dir->isString()) {
    std::lock_guard<std::mutex> g(gLock);
    gDaemonDir = widen(dir->s);
  }
  makeDirs(dataDir());
  writeFile(reportCache(), r.out);
  watchReport(r.out);
  v.set("ok", json::Value::boolean(true));
  v.set("report", json::Value::str(r.out));
  return answer(v);
}

// ---------------------------------------------------------------- install, upgrade, uninstall

std::wstring startMenuShortcut() {
  PWSTR programs = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &programs))) out = join(programs, L"UE-MCP.lnk");
  CoTaskMemFree(programs);
  return out;
}

bool writeShortcut(const std::wstring& lnk, const std::wstring& target) {
  ComPtr<IShellLinkW> link;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return false;
  link->SetPath(target.c_str());
  link->SetWorkingDirectory(dirOf(target).c_str());
  link->SetDescription(L"Your Unreal projects, their updates and ue-mcp");
  ComPtr<IPropertyStore> props;
  if (SUCCEEDED(link.As(&props))) {
    PROPVARIANT pv;
    if (SUCCEEDED(InitPropVariantFromString(kAumid, &pv))) {
      props->SetValue(PKEY_AppUserModel_ID, pv);
      props->Commit();
      PropVariantClear(&pv);
    }
  }
  ComPtr<IPersistFile> file;
  return SUCCEEDED(link.As(&file)) && SUCCEEDED(file->Save(lnk.c_str(), TRUE));
}

void setString(HKEY k, const wchar_t* name, const std::wstring& value) {
  RegSetValueExW(k, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
}

void setDword(HKEY k, const wchar_t* name, DWORD value) { RegSetValueExW(k, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof value); }

struct Installed {
  std::wstring dir;
  std::string version;
};

bool installedRecord(Installed& out) {
  wchar_t buf[MAX_PATH * 2];
  DWORD size = sizeof buf;
  if (RegGetValueW(HKEY_CURRENT_USER, kUninstallKey, L"InstallLocation", RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return false;
  out.dir = buf;
  size = sizeof buf;
  if (RegGetValueW(HKEY_CURRENT_USER, kUninstallKey, L"DisplayVersion", RRF_RT_REG_SZ, nullptr, buf, &size) == ERROR_SUCCESS) out.version = narrow(buf);
  return true;
}

/** By semver, prerelease numbers by value (beta.10 after beta.9). */
using appchannel::compareVersions;

HWND runningApp() { return FindWindowExW(HWND_MESSAGE, nullptr, kMessageClass, nullptr); }

/** Hand a command line to the running app; true when it took it. */
bool tellApp(const std::wstring& line) {
  HWND other = runningApp();
  if (!other) return false;
  AllowSetForegroundWindow(ASFW_ANY);
  std::wstring copy = line;
  COPYDATASTRUCT cds = {kCopyArgs, (DWORD)((copy.size() + 1) * sizeof(wchar_t)), copy.data()};
  DWORD_PTR result = 0;
  return SendMessageTimeoutW(other, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds), SMTO_ABORTIFHUNG, 5000, &result) && result == 1;
}

/**
 * Install this exe for the current user, or upgrade the installed one. A
 * running app keeps running from the copy renamed aside, and is asked to
 * restart onto the new one.
 */
std::string install() {
  std::wstring dir = installDir(), exe = installedExe(), self = selfPath();
  makeDirs(dir);
  if (!samePath(self, exe)) {
    std::wstring old = exe + L".old";
    DeleteFileW(old.c_str());
    if (exists(exe) && !MoveFileExW(exe.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING)) return "The installed UE-MCP could not be replaced (error " + std::to_string(GetLastError()) + ").";
    if (!CopyFileW(self.c_str(), exe.c_str(), FALSE)) return "UE-MCP could not be copied to " + narrow(dir) + " (error " + std::to_string(GetLastError()) + ").";
    // A copy of a download keeps its Mark of the Web, and Windows would warn again on every start.
    DeleteFileW((exe + L":Zone.Identifier").c_str());
  }
  HKEY k;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, kUninstallKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) != ERROR_SUCCESS) return "The uninstall entry could not be written.";
  setString(k, L"DisplayName", L"UE-MCP");
  setString(k, L"DisplayVersion", widen(STUDIO_WINDOW_VERSION));
  setString(k, L"Publisher", L"ue-mcp");
  setString(k, L"URLInfoAbout", L"https://ue-mcp.com");
  setString(k, L"DisplayIcon", exe);
  setString(k, L"InstallLocation", dir);
  setString(k, L"UninstallString", L"\"" + exe + L"\" --uninstall");
  setString(k, L"QuietUninstallString", L"\"" + exe + L"\" --uninstall /S");
  setDword(k, L"NoModify", 1);
  setDword(k, L"NoRepair", 1);
  WIN32_FILE_ATTRIBUTE_DATA a;
  if (GetFileAttributesExW(exe.c_str(), GetFileExInfoStandard, &a)) setDword(k, L"EstimatedSize", (DWORD)(a.nFileSizeLow / 1024));
  RegCloseKey(k);
  std::wstring lnk = startMenuShortcut();
  if (lnk.empty() || !writeShortcut(lnk, exe)) return "The Start menu shortcut could not be written.";
  tellApp(L"\"" + exe + L"\" --relaunch");
  return {};
}

/** Start the installed app. relaunch: it replaces this one, so it waits for this one to exit rather than hand over to it. */
bool launchInstalled(bool relaunch = false) {
  return createDetached(installedExe(), L"\"" + installedExe() + L"\"" + (relaunch ? L" --relaunch" : L""), installDir(), 0);
}

void removeTree(const std::wstring& dir) {
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

/** Uninstall, from a copy outside the install folder: the app, its shortcut, its entry and its own data. Never ~/.ue-mcp. */
int uninstallRun(DWORD waitPid) {
  if (!gSilent && MessageBoxW(nullptr, L"Remove UE-MCP from this computer?\n\nYour projects, ue-mcp and Studio stay as they are.", L"UE-MCP", MB_OKCANCEL | MB_ICONQUESTION) != IDOK) return 1;
  if (waitPid) {
    HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, waitPid);
    if (p) {
      WaitForSingleObject(p, 30000);
      CloseHandle(p);
    }
  }
  tellApp(L"UE-MCP.exe --quit");
  for (int i = 0; i < 100 && runningApp(); ++i) Sleep(100);
  // The app that just quit can hold its exe and folder for a moment after its window goes.
  std::wstring exe = installedExe();
  for (int i = 0; i < 40; ++i) {
    DeleteFileW(exe.c_str());
    DeleteFileW((exe + L".old").c_str());
    if (RemoveDirectoryW(installDir().c_str()) || !exists(installDir())) break;
    Sleep(250);
  }
  std::wstring lnk = startMenuShortcut();
  if (!lnk.empty()) DeleteFileW(lnk.c_str());
  RegDeleteTreeW(HKEY_CURRENT_USER, kUninstallKey);
  removeTree(dataDir());
  if (!gSilent) MessageBoxW(nullptr, L"UE-MCP was removed.", L"UE-MCP", MB_OK | MB_ICONINFORMATION);
  // This copy in the temp folder goes once it has exited.
  std::wstring self = selfPath();
  createDetached(cmdExe(), L"\"" + cmdExe() + L"\" /d /c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + L"\"", {}, CREATE_NO_WINDOW);
  return 0;
}

int uninstallStart() {
  wchar_t tmp[MAX_PATH];
  GetTempPathW(MAX_PATH, tmp);
  std::wstring copy = join(tmp, L"UE-MCP-uninstall-" + std::to_wstring(GetTickCount64()) + L".exe");
  if (!CopyFileW(selfPath().c_str(), copy.c_str(), FALSE)) return 1;
  std::wstring line = L"\"" + copy + L"\" --uninstall-run --wait " + std::to_wstring(GetCurrentProcessId()) + (gSilent ? L" /S" : L"");
  return createDetached(copy, line, std::wstring(tmp), 0) ? 0 : 1;
}

// ---------------------------------------------------------------- the app's own update

std::string sha256Hex(const std::string& data) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  unsigned char digest[32] = {};
  std::string hex;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 && BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0 &&
      BCryptHashData(hash, (PUCHAR)data.data(), (ULONG)data.size(), 0) == 0 && BCryptFinishHash(hash, digest, 32, 0) == 0) {
    static const char* h = "0123456789abcdef";
    for (unsigned char b : digest) {
      hex += h[b >> 4];
      hex += h[b & 15];
    }
  }
  if (hash) BCryptDestroyHash(hash);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  return hex;
}

/**
 * The newest release carrying `asset` in a GitHub release list, as its
 * download address. GitHub allows 60 unsigned calls an hour, so a list read
 * in the last ten minutes is used again rather than read on every check.
 */
std::wstring newestAsset(const char* listUrl, const char* repo, const char* asset, std::string& error) {
  static std::map<std::string, std::pair<ULONGLONG, std::string>> lists;
  std::string body;
  {
    std::lock_guard<std::mutex> g(gLock);
    auto it = lists.find(listUrl);
    if (it != lists.end() && GetTickCount64() - it->second.first < 10 * 60 * 1000) body = it->second.second;
  }
  if (body.empty()) {
    Http list = http(widen(listUrl), L"GET", {}, L"Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n", 20000, false);
    if (!list.ok || list.status != 200) {
      error = appchannel::listFailure(list.ok, list.status, list.error);
      return {};
    }
    body = list.body;
    std::lock_guard<std::mutex> g(gLock);
    lists[listUrl] = {GetTickCount64(), body};
  }
  appchannel::Pick pick = appchannel::newest(body, repo, asset);
  error = pick.error;
  return widen(pick.url);
}

/**
 * The channel's latest.json: the latest release's on Stable; on Beta the
 * newest release by semver, prereleases included, from GitHub's release list
 * (WinHTTP sends UE-MCP/<version> as the User-Agent GitHub asks for).
 * Empty, with why in `error`, when the list could not be read.
 */
std::wstring manifestUrl(const std::string& channel, std::string& error) {
  if (channel != "beta") return widen(appchannel::kLatest);
  return newestAsset(appchannel::kReleases, appchannel::kRepo, "latest.json", error);
}

/** latest.json's app entry on the channel: {channel, version, newer} or why it could not be read. With install, download, check and run the setup. */
std::string appUpdate(bool installIt) {
  json::Value v = json::Value::object();
  std::string channel = channelName();
  v.set("channel", json::Value::str(channel));
  std::string listError;
  std::wstring manifest = manifestUrl(channel, listError);
  if (manifest.empty()) {
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str(listError));
    return answer(v);
  }
  Http m = http(manifest, L"GET", {}, {}, 20000, false);
  json::Value latest;
  bool read = m.ok && m.status == 200 && json::parse(m.body, latest);
  const json::Value* app = read ? latest.get("app") : nullptr;
  if (!app || !app->isObject()) {
    v.set("ok", json::Value::boolean(false));
    std::string why = !m.ok ? "The release could not be read: " + m.error
                      : read ? std::string(channel == "beta" ? "The newest release has no UE-MCP app yet." : "The latest release has no UE-MCP app yet.")
                             : "The release answered HTTP " + std::to_string(m.status) + ".";
    v.set("error", json::Value::str(why));
    return answer(v);
  }
  const json::Value* version = app->get("version");
  const json::Value* url = app->get("url");
  const json::Value* sum = app->get("sha256");
  if (!version || !version->isString() || !url || !url->isString() || !sum || !sum->isString() || !ueupdate::validVersion(version->s)) {
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str("The app release entry is incomplete."));
    return answer(v);
  }
  bool newer = compareVersions(version->s, STUDIO_WINDOW_VERSION) > 0;
  v.set("ok", json::Value::boolean(true));
  v.set("version", json::Value::str(version->s));
  v.set("newer", json::Value::boolean(newer));
  if (!installIt || !newer) return answer(v);
  // The setup sits beside latest.json in the same release.
  std::wstring base = manifest;
  std::wstring file = widen(url->s);
  if (file.find_first_of(L"/\\:") != std::wstring::npos) {
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str("The app release names an unexpected file."));
    return answer(v);
  }
  Http d = http(base.substr(0, base.rfind(L'/') + 1) + file, L"GET", {}, {}, 120000, false);
  if (!d.ok || d.status != 200 || sha256Hex(d.body) != sum->s) {
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str(d.ok && d.status == 200 ? "The download did not match its SHA-256." : "The download failed: " + (d.ok ? "HTTP " + std::to_string(d.status) : d.error)));
    return answer(v);
  }
  makeDirs(dataDir());
  std::wstring setup = join(dataDir(), L"UE-MCP-Setup-" + widen(version->s) + L".exe");
  if (!writeFile(setup, d.body) || !createDetached(setup, L"\"" + setup + L"\" /S", dataDir(), 0)) {
    v.set("ok", json::Value::boolean(false));
    v.set("error", json::Value::str("The new version could not be started."));
    return answer(v);
  }
  v.set("started", json::Value::boolean(true));
  return answer(v);
}

// ---------------------------------------------------------------- native calls

std::string str(const json::Value& v, const char* key) {
  const json::Value* x = v.get(key);
  return x && x->isString() ? x->s : std::string();
}

/** A release file's "version", or why there is none: an unreachable address, an HTTP status, an answer without a version. */
std::string releaseVersion(const std::wstring& url, json::Value& out, std::string& why, const std::string& what) {
  Http r = http(url, L"GET", {}, {}, 20000, false);
  const json::Value* version = r.ok && r.status == 200 && json::parse(r.body, out) ? out.get("version") : nullptr;
  if (version && version->isString() && ueupdate::validVersion(version->s)) return version->s;
  why = !r.ok ? what + " could not be read: " + r.error + "." : r.status == 404 ? what + " is not published yet." : r.status != 200 ? what + " answered HTTP " + std::to_string(r.status) + "." : what + " names no version.";
  return {};
}

/**
 * The newest of each part a project runs, on the channel, read without any
 * project's daemon: ue-mcp from its npm dist-tag (the bridge plugin follows
 * it), Studio from the channel's latest.json, and the Studio editor plugin
 * from the plugin.json latest.json names (on Beta, the plugin's newest
 * release). {channel, ueMcp?, studio?, plugin?, errors: {part: why}}.
 */
std::string newestVersions() {
  json::Value v = json::Value::object();
  json::Value errors = json::Value::object();
  std::string channel = channelName();
  v.set("channel", json::Value::str(channel));
  std::wstring ueMcp = channelUeMcp();
  if (!ueMcp.empty()) v.set("ueMcp", json::Value::str(narrow(ueMcp)));
  else errors.set("ueMcp", json::Value::str(npxCmd().empty() ? "Node.js was not found, so npm could not be asked." : "npm did not answer for ue-mcp@" + narrow(channelTag()) + "."));
  std::string why;
  std::wstring manifest = manifestUrl(channel, why);
  std::string pluginNamed;
  if (!manifest.empty()) {
    json::Value latest;
    std::string studio = releaseVersion(manifest, latest, why, "Studio's release");
    if (!studio.empty()) {
      v.set("studio", json::Value::str(studio));
      pluginNamed = str(latest, "pluginChannel");
    }
  }
  if (!why.empty()) errors.set("studio", json::Value::str(why));
  std::string pluginWhy;
  std::wstring pluginUrl = channel == "beta" ? newestAsset(appchannel::kPluginReleases, appchannel::kPluginRepo, "plugin.json", pluginWhy) : widen(appchannel::pluginChannel(pluginNamed));
  if (!pluginUrl.empty()) {
    json::Value plugin;
    std::string version = releaseVersion(pluginUrl, plugin, pluginWhy, "The editor plugin's release");
    if (!version.empty()) v.set("plugin", json::Value::str(version));
  }
  if (!pluginWhy.empty()) errors.set("plugin", json::Value::str(pluginWhy));
  v.set("errors", errors);
  return answer(v);
}

std::string state() {
  json::Value v = json::Value::object();
  v.set("mode", json::Value::str(gMode == Mode::App ? "app" : "setup"));
  v.set("version", json::Value::str(STUDIO_WINDOW_VERSION));
  json::Value node = json::Value::object();
  {
    std::lock_guard<std::mutex> g(gLock);
    node.set("found", json::Value::boolean(!gNode.empty()));
    node.set("version", json::Value::str(gNodeVersion));
    node.set("ok", json::Value::boolean(!gNode.empty() && nodeMajor(gNodeVersion) >= kNodeMajorMin));
  }
  json::Value min;
  min.kind = json::Value::Kind::Number;
  min.n = kNodeMajorMin;
  node.set("min", min);
  v.set("node", node);
  v.set("winget", json::Value::boolean(!searchPath(L"winget.exe").empty()));
  v.set("channel", json::Value::str(narrow(channelTag())));
  v.set("installDir", json::Value::str(narrow(installDir())));
  Installed rec;
  if (installedRecord(rec)) {
    json::Value i = json::Value::object();
    i.set("version", json::Value::str(rec.version));
    i.set("dir", json::Value::str(narrow(rec.dir)));
    v.set("installed", i);
    v.set("compare", json::Value::str(compareVersions(STUDIO_WINDOW_VERSION, rec.version) > 0 ? "newer" : compareVersions(STUDIO_WINDOW_VERSION, rec.version) < 0 ? "older" : "same"));
  } else {
    v.set("installed", json::Value());
  }
  return answer(v);
}

void reply(int id, const std::string& result) {
  auto* text = new std::wstring(widen("{\"appReply\":" + std::to_string(id) + ",\"result\":" + result + "}"));
  if (!gMain || !PostMessageW(gMain, kReply, 0, reinterpret_cast<LPARAM>(text))) delete text;
}

/** A call answered on a worker thread, so the window never waits on ue-mcp, npm or the network. */
template <typename F>
void later(int id, F work) {
  std::thread([id, work]() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    reply(id, work());
    if (SUCCEEDED(hr)) CoUninitialize();
  }).detach();
}

std::string pickProject() {
  ComPtr<IFileOpenDialog> dlg;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return {};
  COMDLG_FILTERSPEC filter = {L"Unreal projects", L"*.uproject"};
  dlg->SetFileTypes(1, &filter);
  dlg->SetTitle(L"Add an Unreal project");
  if (FAILED(dlg->Show(gMain))) return {};
  ComPtr<IShellItem> item;
  PWSTR path = nullptr;
  std::string out;
  if (SUCCEEDED(dlg->GetResult(&item)) && SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) out = narrow(path);
  CoTaskMemFree(path);
  return out;
}

std::string okError(const std::string& error) {
  json::Value v = json::Value::object();
  v.set("ok", json::Value::boolean(error.empty()));
  if (!error.empty()) v.set("error", json::Value::str(error));
  return answer(v);
}

std::string jobAnswer(int id, const char* failure) {
  if (!id) return okError(failure);
  json::Value v = json::Value::object();
  v.set("ok", json::Value::boolean(true));
  json::Value n;
  n.kind = json::Value::Kind::Number;
  n.n = id;
  v.set("job", n);
  return answer(v);
}

/** One call from the page. Empty: it is answered later, from a worker. */
std::string dispatch(int id, const std::string& method, const std::string& arg) {
  json::Value in;
  json::parse(arg, in);
  std::string key = str(in, "key");
  std::wstring uproject = widen(str(in, "uproject"));
  if (method == "getstate") return state();
  if (method == "refreshnode") {
    later(id, [] {
      refreshPath();
      probeNode();
      return state();
    });
    return {};
  }
  if (method == "report") {
    later(id, readReport);
    return {};
  }
  if (method == "cachedreport") {
    // The last report read, shown at once while a new one is read.
    std::string cached;
    json::Value c;
    return readFile(reportCache(), cached) && json::parse(cached, c) ? json::quote(cached) : "null";
  }
  if (method == "job") return jobState(atoi(arg.c_str()));
  if (method == "daemon") {
    std::string m = str(in, "method"), path = str(in, "path"), body = str(in, "body");
    later(id, [key, m, path, body] { return callDaemon(key, m, path, body); });
    return {};
  }
  if (method == "live") {
    // Which of these projects' daemons run now: their discovery files, read by pid, as studio-window does.
    json::Value out = json::Value::object();
    if (const json::Value* keys = in.get("keys"); keys && keys->isArray()) {
      for (const json::Value& k : *keys->a) {
        if (!k.isString()) continue;
        Daemon d;
        DWORD pid = 0;
        std::string version;
        if (!readDaemon(k.s, d, &pid, &version)) continue;
        json::Value e = json::Value::object();
        json::Value p, port;
        p.kind = port.kind = json::Value::Kind::Number;
        p.n = pid;
        port.n = d.port;
        e.set("pid", p);
        e.set("port", port);
        e.set("version", json::Value::str(version));
        out.set(k.s, e);
      }
    }
    return answer(out);
  }
  std::wstring npx = npxCmd();
  if (method == "install" || method == "startdaemon" || method == "stopdaemon") {
    if (npx.empty()) return okError("Node.js was not found.");
    if (!safeUproject(uproject)) return okError("The project file could not be used.");
    std::wstring args = method == "install" ? L"install studio \"" + uproject + L"\"" : method == "startdaemon" ? L"daemon start \"" + uproject + L"\"" : L"daemon stop \"" + uproject + L"\"";
    later(id, [npx, args] { return jobAnswer(startJob(job::npx(npx, resolvedSpec(), args)), "The command did not start."); });
    return {};
  }
  if (method == "updatebridge") {
    std::string version = str(in, "version");
    if (npx.empty()) return okError("Node.js was not found.");
    if (!safeUproject(uproject) || !ueupdate::validVersion(version)) return okError("The update could not be started.");
    return jobAnswer(startJob(job::npx(npx, L"ue-mcp@" + widen(version), L"update \"" + uproject + L"\" --apply-only")), "The update did not start.");
  }
  if (method == "installnode") {
    // Only on the user's consent, which the page asks for with an unticked box.
    if (str(in, "consent") != "yes") return okError("Node.js is installed only when you ask for it.");
    return jobAnswer(startJob(L"winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements", true),
                     "winget did not start.");
  }
  if (method == "openstudio") {
    std::string location = str(in, "location");
    later(id, [key, uproject, location] {
      std::string why = ensureDaemon(key, uproject);
      if (!why.empty()) return okError(why);
      json::Value body = json::Value::object();
      if (!location.empty()) body.set("location", json::Value::str(location));
      std::string text = answer(body);
      json::Value r;
      json::parse(callDaemon(key, "POST", "/v1/ext/studio/window", text), r);
      const json::Value* status = r.get("status");
      if (!status) return okError(str(r, "error"));
      if (status->n == 404) return okError("This project's Studio is too old to open from here. Open it from the editor, then update it.");
      if (status->n >= 400) return okError("Studio did not open (HTTP " + std::to_string((int)status->n) + ").");
      return okError({});
    });
    return {};
  }
  if (method == "launcheditor") {
    bool setUp = in.get("setUp") && in.get("setUp")->isBool() && in.get("setUp")->b;
    if (!setUp) {
      if (!safeUproject(uproject)) return okError("The project file could not be used.");
      return okError(reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", uproject.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32 ? "" : "Windows has no program to open .uproject files with.");
    }
    later(id, [key, uproject] {
      std::string why = ensureDaemon(key, uproject);
      if (!why.empty()) return okError(why);
      json::Value r;
      json::parse(callDaemon(key, "POST", "/v1/editor/start", "{}", 600000), r);
      const json::Value* status = r.get("status");
      if (!status) return okError(str(r, "error"));
      if (status->n >= 400) {
        json::Value b;
        std::string error = json::parse(str(r, "body"), b) ? str(b, "error") : "";
        return okError(error.empty() ? "The editor did not start (HTTP " + std::to_string((int)status->n) + ")." : error);
      }
      return okError({});
    });
    return {};
  }
  if (method == "addproject" || method == "removeproject") {
    std::wstring target = uproject;
    if (method == "addproject") {
      target = widen(pickProject());
      if (target.empty()) return "{\"ok\":false,\"cancelled\":true}";
    }
    if (npx.empty()) return okError("Node.js was not found.");
    if (!safeUproject(target)) return okError("That file cannot be added.");
    std::wstring args = (method == "addproject" ? L"projects add \"" : L"projects remove \"") + target + L"\" --json";
    later(id, [npx, args] {
      Captured c = capture(job::npx(npx, resolvedSpec(), args), 120000);
      return okError(c.code == 0 ? "" : job::failureText(c.out + c.err));
    });
    return {};
  }
  if (method == "readlog") {
    if (!job::validKey(key)) return "\"\"";
    std::string text;
    readFile(join(daemonDir(), widen(key) + L".log"), text);
    if (text.size() > 65536) text = text.substr(text.size() - 65536);
    return json::quote(text);
  }
  if (method == "openlog") {
    if (!job::validKey(key)) return "false";
    std::wstring log = join(daemonDir(), widen(key) + L".log");
    return reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", log.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32 ? "true" : "false";
  }
  if (method == "openfolder") {
    std::wstring dir = widen(str(in, "path"));
    DWORD a = GetFileAttributesW(dir.c_str());
    if (a == INVALID_FILE_ATTRIBUTES || !(a & FILE_ATTRIBUTE_DIRECTORY)) return "false";
    ShellExecuteW(nullptr, L"explore", dir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return "true";
  }
  if (method == "openurl") {
    std::string url = str(in, "url");
    if (url.rfind("https://", 0) != 0) return "false";
    ShellExecuteW(nullptr, L"open", widen(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return "true";
  }
  if (method == "getchannel") {
    json::Value v = json::Value::object();
    v.set("channel", json::Value::str(channelName()));
    return answer(v);
  }
  if (method == "setchannel") {
    std::string channel = str(in, "channel");
    if (channel != "stable" && channel != "beta") return okError("The channel is Stable or Beta.");
    if (!setChannel(channel)) return okError("The channel could not be saved.");
    json::Value v = json::Value::object();
    v.set("ok", json::Value::boolean(true));
    v.set("channel", json::Value::str(channel));
    return answer(v);
  }
  if (method == "newest") {
    later(id, newestVersions);
    return {};
  }
  if (method == "appupdate") {
    bool go = str(in, "install") == "yes";
    later(id, [go] { return appUpdate(go); });
    return {};
  }
  if (method == "setup") {
    if (gMode != Mode::Setup) return okError("UE-MCP is already installed here.");
    later(id, [] { return okError(install()); });
    return {};
  }
  if (method == "launch") {
    bool ok = launchInstalled();
    if (ok && gMain) PostMessageW(gMain, WM_CLOSE, 0, 0);
    return ok ? "true" : "false";
  }
  if (method == "close") {
    if (gMain) PostMessageW(gMain, WM_CLOSE, 0, 0);
    return "true";
  }
  return "null";
}

// The page's window.ue.app: each call a Promise answered over postMessage.
const wchar_t* kShim = LR"JS((function () {
  var wv = window.chrome && window.chrome.webview;
  if (!wv || (window.ue && window.ue.app)) return;
  var next = 1, waiting = {};
  wv.addEventListener("message", function (e) {
    var d = e.data;
    // What the host tells the page unasked: a watched file changed, or the window was activated.
    if (d && typeof d === "object" && typeof d.appEvent === "string") {
      window.dispatchEvent(new CustomEvent("ue-app", { detail: d.appEvent }));
      return;
    }
    if (d && typeof d === "object" && typeof d.appReply === "number" && waiting[d.appReply]) {
      var done = waiting[d.appReply];
      delete waiting[d.appReply];
      done(d.result);
    }
  });
  var names = ["getstate", "refreshnode", "report", "cachedreport", "job", "daemon", "live", "install", "startdaemon", "stopdaemon", "updatebridge",
    "installnode", "openstudio", "launcheditor", "addproject", "removeproject", "readlog", "openlog", "openfolder", "openurl",
    "getchannel", "setchannel", "appupdate", "newest", "setup", "launch", "close"];
  var app = {};
  names.forEach(function (name) {
    app[name] = function (arg) {
      return new Promise(function (resolve) {
        var id = next++;
        waiting[id] = resolve;
        wv.postMessage(id + "\u001f" + name + "\u001f" + (arg === undefined || arg === null ? "" : typeof arg === "string" ? arg : JSON.stringify(arg)));
      });
    };
  });
  window.ue = window.ue || {};
  window.ue.app = app;
})();)JS";

// ---------------------------------------------------------------- the window

bool fromApp(const std::wstring& url) { return url.rfind(std::wstring(kOrigin) + L"/", 0) == 0; }

void openExternal(const std::wstring& url) {
  if (url.rfind(L"https://", 0) == 0) ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

/** Windows' app theme: light unless the user chose dark. */
bool darkTheme() {
  DWORD light = 1, size = sizeof light;
  RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &size);
  return light == 0;
}

void applyChrome() {
  BOOL dark = darkTheme() ? TRUE : FALSE;
  DwmSetWindowAttribute(gMain, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
  ComPtr<ICoreWebView2Controller2> c2;
  if (gController && SUCCEEDED(gController.As(&c2))) c2->put_DefaultBackgroundColor(dark ? COREWEBVIEW2_COLOR{255, 0x0c, 0x0c, 0x0b} : COREWEBVIEW2_COLOR{255, 0xf7, 0xf5, 0xf1});
}

/** The page's file for a request to the app's origin, served from the exe's resources. */
HRESULT serve(ICoreWebView2WebResourceRequestedEventArgs* args) {
  ComPtr<ICoreWebView2WebResourceRequest> req;
  args->get_Request(&req);
  LPWSTR uri = nullptr;
  req->get_Uri(&uri);
  std::wstring url = uri ? uri : L"";
  CoTaskMemFree(uri);
  std::wstring path = url.substr(wcslen(kOrigin));
  size_t cut = path.find_first_of(L"?#");
  if (cut != std::wstring::npos) path = path.substr(0, cut);
  if (path.empty() || path == L"/") path = L"/app.html";
  const ui::File* hit = nullptr;
  for (const ui::File& f : ui::kFiles) if (path == f.path) hit = &f;
  ComPtr<IStream> stream;
  int status = 404;
  std::wstring type = L"text/plain";
  if (hit) {
    HRSRC r = FindResourceW(nullptr, MAKEINTRESOURCEW(hit->id), RT_RCDATA);
    HGLOBAL g = r ? LoadResource(nullptr, r) : nullptr;
    const BYTE* bytes = g ? static_cast<const BYTE*>(LockResource(g)) : nullptr;
    if (bytes) {
      stream.Attach(SHCreateMemStream(bytes, SizeofResource(nullptr, r)));
      status = 200;
      type = hit->type;
    }
  }
  ComPtr<ICoreWebView2WebResourceResponse> res;
  std::wstring headers = L"Content-Type: " + type + L"\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff";
  gEnv->CreateWebResourceResponse(stream.Get(), status, status == 200 ? L"OK" : L"Not Found", headers.c_str(), &res);
  return args->put_Response(res.Get());
}

void resize() {
  if (!gController) return;
  RECT r;
  GetClientRect(gMain, &r);
  gController->put_Bounds(r);
}

void noWebView() {
  if (MessageBoxW(gMain, L"UE-MCP needs the Microsoft Edge WebView2 Runtime, which is not installed.\n\nOpen Microsoft's download page? Its Evergreen installer needs no admin rights.",
                  L"UE-MCP", MB_YESNO | MB_ICONWARNING) == IDYES) {
    openExternal(kWebView2Download);
  }
  DestroyWindow(gMain);
}

void createWebView() {
  std::wstring data = join(dataDir(), L"webview");
  makeDirs(data);
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, data.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT hr, ICoreWebView2Environment* environment) -> HRESULT {
      if (FAILED(hr) || !environment) {
        noWebView();
        return S_OK;
      }
      gEnv = environment;
      return environment->CreateCoreWebView2Controller(gMain, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
        [](HRESULT hr, ICoreWebView2Controller* controller) -> HRESULT {
          if (FAILED(hr) || !controller) {
            noWebView();
            return S_OK;
          }
          gController = controller;
          gController->get_CoreWebView2(&gWeb);
          applyChrome();
          ComPtr<ICoreWebView2Settings> settings;
          gWeb->get_Settings(&settings);
          bool devtools = !env(L"UE_MCP_APP_DEVTOOLS").empty();
          settings->put_AreDevToolsEnabled(devtools);
          settings->put_IsStatusBarEnabled(FALSE);
          settings->put_IsZoomControlEnabled(FALSE);
          settings->put_AreDefaultContextMenusEnabled(devtools);
          ComPtr<ICoreWebView2Settings3> s3;
          if (!devtools && SUCCEEDED(settings.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
          gWeb->AddScriptToExecuteOnDocumentCreated(kShim, nullptr);
          gWeb->AddWebResourceRequestedFilter((std::wstring(kOrigin) + L"/*").c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
          gWeb->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT { return serve(args); }).Get(), nullptr);
          gWeb->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
              LPWSTR uri = nullptr;
              args->get_Uri(&uri);
              std::wstring url = uri ? uri : L"";
              CoTaskMemFree(uri);
              if (fromApp(url)) return S_OK;
              // Only the app's own page loads here; links leave for the system browser.
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
              // The app's own page only: nothing else that might load may drive ue-mcp.
              if (!fromApp(from)) return S_OK;
              LPWSTR raw = nullptr;
              if (FAILED(args->TryGetWebMessageAsString(&raw)) || !raw) return S_OK;
              std::string message = narrow(raw);
              CoTaskMemFree(raw);
              size_t a = message.find('\x1f');
              size_t b = a == std::string::npos ? a : message.find('\x1f', a + 1);
              if (b == std::string::npos) return S_OK;
              std::string idText = message.substr(0, a);
              if (idText.empty() || idText.find_first_not_of("0123456789") != std::string::npos) return S_OK;
              int id = atoi(idText.c_str());
              std::string result = dispatch(id, message.substr(a + 1, b - a - 1), message.substr(b + 1));
              if (!result.empty()) web->PostWebMessageAsJson(widen("{\"appReply\":" + idText + ",\"result\":" + result + "}").c_str());
              return S_OK;
            }).Get(), nullptr);
          resize();
          gWeb->Navigate((std::wstring(kOrigin) + L"/app.html").c_str());
          gController->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
          return S_OK;
        }).Get());
    }).Get());
  if (FAILED(hr)) noWebView();
}

void bringToFront() {
  if (!gMain) return;
  if (IsIconic(gMain)) ShowWindow(gMain, SW_RESTORE);
  SetForegroundWindow(gMain);
}

LRESULT CALLBACK messageProc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_COPYDATA) {
    auto* cds = reinterpret_cast<const COPYDATASTRUCT*>(lp);
    if (!cds || cds->dwData != kCopyArgs || cds->cbData > 64 * 1024) return 0;
    std::wstring line(static_cast<const wchar_t*>(cds->lpData), cds->cbData / sizeof(wchar_t));
    if (line.find(L"--relaunch") != std::wstring::npos) {
      // An upgrade replaced the exe: start the new one, which waits for this one to go.
      launchInstalled(true);
      PostMessageW(gMain, WM_CLOSE, 0, 0);
    } else if (line.find(L"--quit") != std::wstring::npos) {
      PostMessageW(gMain, WM_CLOSE, 0, 0);
    } else {
      bringToFront();
    }
    return 1;
  }
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
    case WM_SETTINGCHANGE:
      applyChrome();
      break;
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(w, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: {
      auto* mm = reinterpret_cast<MINMAXINFO*>(lp);
      UINT dpi = GetDpiForWindow(w);
      mm->ptMinTrackSize = gMode == Mode::App ? POINT{MulDiv(560, dpi, 96), MulDiv(440, dpi, 96)} : POINT{MulDiv(520, dpi, 96), MulDiv(460, dpi, 96)};
      return 0;
    }
    case WM_ERASEBKGND: {
      RECT r;
      GetClientRect(w, &r);
      HBRUSH brush = CreateSolidBrush(darkTheme() ? RGB(0x0c, 0x0c, 0x0b) : RGB(0xf7, 0xf5, 0xf1));
      FillRect(reinterpret_cast<HDC>(wp), &r, brush);
      DeleteObject(brush);
      return 1;
    }
    case kReply: {
      std::unique_ptr<std::wstring> text(reinterpret_cast<std::wstring*>(lp));
      if (gWeb) gWeb->PostWebMessageAsJson(text->c_str());
      return 0;
    }
    case kChanged: {
      ULONGLONG now = GetTickCount64();
      if (!gFirstChange) gFirstChange = now;
      SetTimer(w, kChangedTimer, (UINT)std::max<ULONGLONG>(1, watch::delay(gFirstChange, now)), nullptr);
      return 0;
    }
    case WM_TIMER:
      if (wp == kChangedTimer) {
        KillTimer(w, kChangedTimer);
        gFirstChange = 0;
        if (gWeb) gWeb->PostWebMessageAsJson(L"{\"appEvent\":\"changed\"}");
        return 0;
      }
      break;
    case WM_ACTIVATE:
      // Coming back to the window: the page reads the report again. Sent from the window's own activation, so it fires whatever has focus inside the page.
      if (LOWORD(wp) != WA_INACTIVE && gWeb) gWeb->PostWebMessageAsJson(L"{\"appEvent\":\"focus\"}");
      break;
    case WM_DESTROY:
      if (gController) gController->Close();
      gController.Reset();
      gWeb.Reset();
      gMain = nullptr;
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(w, msg, wp, lp);
}

/** One app per user: a later start hands over and exits, or waits for an app that is closing to go. */
bool claimApp(const std::wstring& line) {
  gMutex = CreateMutexW(nullptr, TRUE, L"Local\\UEMCPApp");
  if (!gMutex) return false;
  if (GetLastError() != ERROR_ALREADY_EXISTS) return true;
  for (int attempt = 0; attempt < 150; ++attempt) {
    if (line.find(L"--relaunch") == std::wstring::npos && tellApp(line)) return false;
    DWORD r = WaitForSingleObject(gMutex, 100);
    if (r == WAIT_OBJECT_0 || r == WAIT_ABANDONED) return true;
  }
  return false;
}

void cleanJobs() {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(join(jobsDir(), L"*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) DeleteFileW(join(jobsDir(), fd.cFileName).c_str());
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  bool forceApp = false, uninstall = false, uninstallRunning = false;
  DWORD waitPid = 0;
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    if (a == L"--app") forceApp = true;
    else if (a == L"/S" || a == L"/s") gSilent = true;
    else if (a == L"--uninstall") uninstall = true;
    else if (a == L"--uninstall-run") uninstallRunning = true;
    else if (a == L"--wait" && i + 1 < argc) waitPid = (DWORD)_wtoi(argv[++i]);
  }
  LocalFree(argv);
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  if (uninstallRunning) return uninstallRun(waitPid);
  if (uninstall) return uninstallStart();

  gMode = forceApp || samePath(selfPath(), installedExe()) ? Mode::App : Mode::Setup;
  if (gMode == Mode::Setup && gSilent) {
    // The app's own update, or a scripted install: no window, the running app restarts onto the new copy.
    return install().empty() ? 0 : 1;
  }
  if (gMode == Mode::App) {
    if (!claimApp(GetCommandLineW())) return 0;
    SetCurrentProcessExplicitAppUserModelID(kAumid);
    // The copy an upgrade renamed aside goes once the app it ran has exited.
    std::thread([] {
      std::wstring old = installedExe() + L".old";
      for (int i = 0; i < 60 && exists(old) && !DeleteFileW(old.c_str()); ++i) Sleep(500);
    }).detach();
    cleanJobs();
    // Watch from the start, the last report's projects until a new one is read.
    gRewatch = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    std::thread(watcher).detach();
    std::string cached;
    if (readFile(reportCache(), cached)) watchReport(cached);
    else watchProjects({});
  }
  probeNode();

  WNDCLASSEXW mc = {sizeof mc};
  mc.lpfnWndProc = messageProc;
  mc.hInstance = instance;
  mc.lpszClassName = kMessageClass;
  if (gMode == Mode::App) {
    RegisterClassExW(&mc);
    gMessage = CreateWindowExW(0, kMessageClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
  }

  WNDCLASSEXW wc = {sizeof wc};
  wc.lpfnWndProc = mainProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  wc.hIconSm = (HICON)LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  if (!wc.hIcon) wc.hIcon = makeIcon(GetSystemMetrics(SM_CXICON));
  wc.lpszClassName = kMainClass;
  RegisterClassExW(&wc);
  UINT dpi = GetDpiForSystem();
  int w = MulDiv(gMode == Mode::App ? 1120 : 640, dpi, 96), h = MulDiv(gMode == Mode::App ? 740 : 520, dpi, 96);
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  w = std::min<int>(w, work.right - work.left);
  h = std::min<int>(h, work.bottom - work.top);
  DWORD style = gMode == Mode::App ? WS_OVERLAPPEDWINDOW : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
  gMain = CreateWindowExW(0, kMainClass, gMode == Mode::App ? L"UE-MCP" : L"UE-MCP Setup", style | WS_CLIPCHILDREN, work.left + (work.right - work.left - w) / 2,
                          work.top + (work.bottom - work.top - h) / 2, w, h, nullptr, nullptr, instance, nullptr);
  if (!gMain) return 1;
  applyChrome();
  ShowWindow(gMain, SW_SHOWNORMAL);
  UpdateWindow(gMain);
  createWebView();

  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  CoUninitialize();
  return 0;
}
