// studio-window on Linux: UE-MCP Studio in its own window, GTK 4 and WebKitGTK 6.
//
// The Linux counterpart of main.cpp (studio-window.exe). It is a separate
// process that loads the UI the project's daemon serves, so the chat stays
// live while the editor's game thread is busy, and it answers the page's
// native calls (window.ue.studio) itself.
//
// One window per project: the GtkApplication's id carries the project key, so
// a second launch hands its arguments to the first over D-Bus, the way the
// Windows build hands them over WM_COPYDATA. A launch from a different build
// replaces the running one, so an update takes effect on the next open.
//
// What the Windows build does that a Linux desktop does not allow is left out:
// Wayland lets no program place itself over another program's window, keep
// itself above it, or read input made in other programs. So there is no
// docked mode (getwindowmode answers canDock false and the page hides it), no
// following the editor's stacking and minimizing, and lastinput answers null.
//
// The connection policy (connection.h), the panel's location (location.h),
// the refused screen's update (update.h) and the notification answers
// (toast.h) are the same headers the Windows build compiles.

#include <gtk/gtk.h>
#include <webkit/webkit.h>
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/wayland/gdkwayland.h>
#endif

#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <vector>

#include "../connection.h"
#include "../json.h"
#include "../location.h"
#include "../toast.h"
#include "../update.h"

#ifndef STUDIO_WINDOW_VERSION
#define STUDIO_WINDOW_VERSION "0.0.0"
#endif

namespace {

// An exit status the primary gives a launch from another build: it is quitting, so start again.
constexpr int kReplaceMe = 3;
const char* kDisplayName = "UE-MCP Studio";
/**
 * The desktop's name for Studio: its windows' app id and WM_CLASS, its desktop
 * entry and its icon. One for every project, so the taskbar shows them as one
 * app; the GApplication id stays per project, for one window per project.
 */
const char* kAppId = "com.ue_mcp.Studio";

// ---------------------------------------------------------------- strings and files

/** location.h works in wide strings; the panel's hashes are ASCII, so a byte per character. */
std::wstring wide(const std::string& s) { return std::wstring(s.begin(), s.end()); }
std::string ascii(const std::wstring& s) {
  std::string out;
  for (wchar_t c : s) out += c < 128 ? static_cast<char>(c) : '?';
  return out;
}

std::string join(const std::string& a, const std::string& b) {
  if (a.empty()) return b;
  return a.back() == '/' ? a + b : a + "/" + b;
}

std::string dirOf(const std::string& p) {
  size_t k = p.find_last_of('/');
  return k == std::string::npos ? std::string() : p.substr(0, k);
}

bool exists(const std::string& p) { return !p.empty() && access(p.c_str(), F_OK) == 0; }
bool executable(const std::string& p) { return !p.empty() && access(p.c_str(), X_OK) == 0; }

bool readFile(const std::string& path, std::string& out) {
  gchar* data = nullptr;
  gsize len = 0;
  if (!g_file_get_contents(path.c_str(), &data, &len, nullptr)) return false;
  out.assign(data, len);
  g_free(data);
  return true;
}

void makeDirs(const std::string& dir) {
  if (!dir.empty()) g_mkdir_with_parents(dir.c_str(), 0755);
}

/** Written whole or not at all: a temp file renamed over the old one. */
bool writeFile(const std::string& path, const std::string& data) {
  return g_file_set_contents(path.c_str(), data.data(), static_cast<gssize>(data.size()), nullptr);
}

bool appendFile(const std::string& path, const std::string& data) {
  FILE* f = std::fopen(path.c_str(), "a");
  if (!f) return false;
  bool ok = std::fwrite(data.data(), 1, data.size(), f) == data.size();
  std::fclose(f);
  return ok;
}

std::string env(const char* name) {
  const char* v = g_getenv(name);
  return v ? v : "";
}

bool processAlive(long pid) { return pid > 0 && (kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM); }

std::string quoteShell(const std::string& s) {
  gchar* q = g_shell_quote(s.c_str());
  std::string out = q;
  g_free(q);
  return out;
}

guint64 nowMs() { return static_cast<guint64>(g_get_monotonic_time() / 1000); }

// ---------------------------------------------------------------- options

struct Options {
  std::string project;    // the project folder
  std::string discovery;  // the daemon's discovery file for it
  std::string key;        // the daemon's project key: one window per key
  std::string state;      // where the window's size is kept
  std::string title;      // the project's name
  std::string node;       // node, for npx
  std::string ueMcp;      // the ue-mcp package the daemon runs, e.g. ue-mcp@1.4.0
  std::string instanceTest;  // tests only: no window, report hand-offs to this file
  std::string senderVersion;
  std::string mode;       // "docked" or "window"; only "window" exists here
  std::string location;   // where the panel opens: a hash such as #/settings/general
  long editorPid = 0;
  bool closeWithEditor = false;  // accepted from older plugins; Studio no longer closes with the editor
  bool quit = false;
  bool probe = false;     // the agent's check that this build can run here: libraries and a display
};

bool parseArgs(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&](std::string& into) {
      if (i + 1 < argc) into = argv[++i];
    };
    if (a == "--project") next(o.project);
    else if (a == "--discovery") next(o.discovery);
    else if (a == "--key") next(o.key);
    else if (a == "--state") next(o.state);
    else if (a == "--title") next(o.title);
    else if (a == "--node") next(o.node);
    else if (a == "--ue-mcp") next(o.ueMcp);
    else if (a == "--instance-test") next(o.instanceTest);
    else if (a == "--sender-version") next(o.senderVersion);
    else if (a == "--mode") next(o.mode);
    else if (a == "--location") next(o.location);
    else if (a == "--editor-pid" && i + 1 < argc) o.editorPid = std::atol(argv[++i]);
    else if (a == "--close-with-editor") o.closeWithEditor = true;
    else if (a == "--quit") o.quit = true;
    else if (a == "--probe") o.probe = true;
  }
  if (o.probe) return true;
  // The key names the application on D-Bus; keep it to what that accepts.
  for (char c : o.key) if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return false;
  return !o.key.empty();
}

std::string argLine(int argc, char** argv) {
  std::string line;
  for (int i = 1; i < argc; ++i) {
    if (!line.empty()) line += ' ';
    line += argv[i];
  }
  return line;
}

// ---------------------------------------------------------------- state

struct Daemon {
  long pid = 0;
  int port = 0;
  std::string token;
  std::string version;
};

Options gOpt;
GApplication* gApp = nullptr;
GtkWindow* gMain = nullptr;
WebKitWebView* gWeb = nullptr;
bool gStarted = false;
Daemon gLoaded;          // the daemon the page was loaded from; port 0 while on the local page
bool gLocalPage = false;
int gDaemonMisses = 0;
conn::State gConn;       // the local page's connection state (connection.h)
bool gConnActive = false;
bool gPageManaged = false;  // the loaded page reports its connection state and explains a gap itself
std::string gPagePhase;
bool gLoadPending = false;  // a load of Studio's page from the daemon not yet committed
std::wstring gLastHash;
long gEditorPid = 0;
std::string gUpdateVersion;
toast::Shown gShownNotices;

/** The live daemon. stale: a discovery file is there but its process is gone, so ue-mcp crashed. */
bool readDaemon(Daemon& out, bool* stale = nullptr) {
  std::string text;
  json::Value v;
  if (stale) *stale = false;
  if (gOpt.discovery.empty() || !readFile(gOpt.discovery, text) || !json::parse(text, v)) return false;
  const json::Value* pid = v.get("pid");
  const json::Value* port = v.get("port");
  const json::Value* token = v.get("token");
  if (!pid || !pid->isNumber() || !port || !port->isNumber() || !token || !token->isString() || token->s.empty()) return false;
  Daemon d;
  d.pid = static_cast<long>(pid->n);
  d.port = static_cast<int>(port->n);
  d.token = token->s;
  if (const json::Value* ver = v.get("version"); ver && ver->isString()) d.version = ver->s;
  // The token goes into a URL; anything but hex is not a token the daemon wrote.
  for (char c : d.token) if (!std::isxdigit(static_cast<unsigned char>(c))) return false;
  if (!processAlive(d.pid)) {
    if (stale) *stale = true;
    return false;
  }
  out = d;
  return true;
}

std::string uproject() {
  DIR* dir = opendir(gOpt.project.c_str());
  if (!dir) return {};
  std::string found;
  while (dirent* e = readdir(dir)) {
    std::string n = e->d_name;
    if (n.size() > 9 && n.compare(n.size() - 9, 9, ".uproject") == 0) {
      found = join(gOpt.project, n);
      break;
    }
  }
  closedir(dir);
  return found;
}

std::string studioDir() { return join(join(gOpt.project, "Saved"), "UE_MCP_Studio"); }
std::string setupPlanPath() { return join(studioDir(), "setup-plan.json"); }
std::string logPath() { return join(join(join(gOpt.project, "Saved"), "Logs"), "UE_MCP_Studio.log"); }
std::string locationPath() { return join(studioDir(), "window-location.txt"); }
/**
 * This window's process id while it runs: the editor plugin reads it to know the
 * window is open (FStudioWindow::IsOpen), as it finds the Windows build's message window.
 */
std::string pidPath() { return join(studioDir(), "window.pid"); }

void writePidFile() {
  makeDirs(studioDir());
  writeFile(pidPath(), std::to_string(getpid()) + "\n");
}

/** Removed on the way out, unless a window that replaced this one has written its own. */
void removePidFile() {
  std::string text;
  if (readFile(pidPath(), text) && std::atol(text.c_str()) == static_cast<long>(getpid())) std::remove(pidPath().c_str());
}

void logLine(const std::string& text) {
  char stamp[64];
  std::time_t t = std::time(nullptr);
  std::strftime(stamp, sizeof stamp, "%Y-%m-%d %H:%M:%S ", std::localtime(&t));
  makeDirs(dirOf(logPath()));
  appendFile(logPath(), std::string(stamp) + "studio-window: " + text + "\n");
}

void openUri(const std::string& uri) {
  GError* error = nullptr;
  if (!g_app_info_launch_default_for_uri(uri.c_str(), nullptr, &error)) {
    logLine("could not open " + uri + ": " + (error ? error->message : "no handler"));
    g_clear_error(&error);
  }
}

void openExternal(const std::string& url) {
  if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) return;
  openUri(url);
}

bool openPath(const std::string& path) {
  gchar* uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
  if (!uri) return false;
  GError* error = nullptr;
  bool ok = g_app_info_launch_default_for_uri(uri, nullptr, &error);
  if (!ok) logLine(std::string("could not open ") + path + ": " + (error ? error->message : "no handler"));
  g_clear_error(&error);
  g_free(uri);
  return ok;
}

// ---------------------------------------------------------------- processes

/** Node.js: the one the daemon runs on when it still exists, else the first on PATH. */
std::string findNode() {
  if (executable(gOpt.node)) return gOpt.node;
  gchar* p = g_find_program_in_path("node");
  std::string out = p ? p : "";
  g_free(p);
  return out;
}

std::string findNpx(const std::string& node) {
  std::string beside = join(dirOf(node), "npx");
  if (executable(beside)) return beside;
  gchar* p = g_find_program_in_path("npx");
  std::string out = p ? p : "";
  g_free(p);
  return out;
}

/** The child leaves this window's session, so closing the window does not stop it. */
void detachChild(gpointer) { setsid(); }

/** A shell line in the project folder, detached, with node's folder on PATH. */
bool spawnShell(const std::string& line, const std::string& nodeDir) {
  gchar** envp = g_get_environ();
  std::string path = env("PATH");
  if (!nodeDir.empty() && (":" + path + ":").find(":" + nodeDir + ":") == std::string::npos) {
    envp = g_environ_setenv(envp, "PATH", (nodeDir + (path.empty() ? "" : ":" + path)).c_str(), TRUE);
  }
  const gchar* argv[] = {"/bin/sh", "-c", line.c_str(), nullptr};
  GError* error = nullptr;
  gboolean ok = g_spawn_async(gOpt.project.c_str(), const_cast<gchar**>(argv), envp,
                              static_cast<GSpawnFlags>(G_SPAWN_STDIN_FROM_DEV_NULL), detachChild, nullptr, nullptr, &error);
  if (!ok) logLine(std::string("could not start a command: ") + (error ? error->message : "unknown"));
  g_clear_error(&error);
  g_strfreev(envp);
  return ok;
}

/** npx commands in turn, output to the Studio log (or stdout to a file). The same chain the editor plugin runs. */
bool spawnNpx(const std::vector<std::string>& commands, const std::string& stdoutFile = {}) {
  std::string node = findNode();
  if (node.empty()) return false;
  std::string npx = findNpx(node);
  if (npx.empty()) return false;
  std::string log = logPath();
  makeDirs(dirOf(log));
  std::string chain;
  for (const std::string& args : commands) {
    if (!chain.empty()) chain += " && ";
    chain += quoteShell(npx) + " " + args;
    chain += stdoutFile.empty() ? " >> " + quoteShell(log) + " 2>&1" : " > " + quoteShell(stdoutFile) + " 2>> " + quoteShell(log);
  }
  return spawnShell(chain, dirOf(node));
}

std::string package() { return gOpt.ueMcp.empty() ? "ue-mcp@beta" : gOpt.ueMcp; }

/** Start the project's daemon in the background. error: why the command did not run. */
bool startDaemon(std::string* error = nullptr) {
  std::string p = uproject();
  std::string why;
  if (p.empty()) why = "no .uproject file was found in " + gOpt.project;
  else if (findNode().empty()) why = "Node.js was not found";
  else if (!spawnNpx({"-y " + quoteShell(package()) + " daemon start " + quoteShell(p)})) why = "npx could not be started";
  if (error) *error = why;
  return why.empty();
}

bool installBridge() {
  std::string p = uproject();
  return !p.empty() && spawnNpx({"-y " + quoteShell(package()) + " init --yes --json --install=binary --clients= --project=" + quoteShell(p)});
}

bool startSetupPlan() {
  std::string p = uproject();
  if (p.empty()) return false;
  std::remove(setupPlanPath().c_str());
  makeDirs(studioDir());
  return spawnNpx({"-y " + quoteShell(package()) + " init --yes --json --dry-run --install=binary --project=" + quoteShell(p)}, setupPlanPath());
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
  std::string list;
  if (const json::Value* c = in.get("clients"); c && c->isArray()) {
    for (const json::Value& id : *c->a) {
      if (!id.isString() || std::none_of(std::begin(clients), std::end(clients), [&](const char* k) { return id.s == k; })) return false;
      if (!list.empty()) list += ",";
      list += id.s;
    }
  }
  auto flag = [&](const char* name, bool fallback) {
    const json::Value* v = in.get(name);
    return v && v->isBool() ? v->b : fallback;
  };
  std::string flags = " --clients=" + list;
  flags += flag("nativeTools", true) ? " --native-tools" : " --no-native-tools";
  if (const json::Value* ctx = in.get("context"); ctx && ctx->isString()) {
    if (std::none_of(std::begin(contexts), std::end(contexts), [&](const char* k) { return ctx->s == k; })) return false;
    flags += " --context=" + ctx->s;
  }
  flags += flag("feedback", false) ? " --feedback" : " --no-feedback";
  flags += flag("skills", false) ? " --skills" : " --no-skills";
  std::string p = uproject();
  return !p.empty() && spawnNpx({"-y " + quoteShell(package()) + " init --yes --json --install=binary" + flags + " --project=" + quoteShell(p)});
}

std::string updateOutPath() { return join(studioDir(), "ue-mcp-update.log"); }
std::string updateExitPath() { return join(studioDir(), "ue-mcp-update.exit"); }

/** The refused screen's update: the target release's own CLI applies its bridge (update.h). */
bool startUeMcpUpdate(const std::string& version) {
  std::string p = uproject();
  std::string node = findNode();
  if (!ueupdate::validVersion(version) || p.empty() || node.empty()) return false;
  std::string npx = findNpx(node);
  if (npx.empty()) return false;
  makeDirs(studioDir());
  std::remove(updateOutPath().c_str());
  std::remove(updateExitPath().c_str());
  // update.h's command, in sh: output to one file, then 0 or 1 to the exit file once it ends.
  std::string line = quoteShell(npx) + " -y --min-release-age=0 " + quoteShell("ue-mcp@" + version) + " update " + quoteShell(p) + " --apply-only";
  std::string chain = "(" + line + ") > " + quoteShell(updateOutPath()) + " 2>&1 && echo 0 > " + quoteShell(updateExitPath()) + " || echo 1 > " +
                      quoteShell(updateExitPath());
  if (!spawnShell(chain, dirOf(node))) return false;
  gUpdateVersion = version;
  return true;
}

std::string ueMcpUpdateResult() {
  std::string exitText, output;
  bool exited = readFile(updateExitPath(), exitText);
  if (exited) readFile(updateOutPath(), output);
  return ueupdate::result(exited, exitText, output, gUpdateVersion);
}

bool enablePlugin(const std::string& name) {
  static const char* allowed[] = {"UE_MCP_Bridge", "PythonScriptPlugin", "Niagara", "PCG", "EnhancedInput", "GameplayAbilities"};
  if (std::none_of(std::begin(allowed), std::end(allowed), [&](const char* k) { return name == k; })) return false;
  std::string file = uproject();
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
  bool found = false;
  for (json::Value& p : *plugins->a) {
    const json::Value* n = p.get("Name");
    if (n && n->isString() && n->s == name) {
      p.set("Enabled", json::Value::boolean(true));
      found = true;
      break;
    }
  }
  if (!found) {
    json::Value entry = json::Value::object();
    entry.set("Name", json::Value::str(name));
    entry.set("Enabled", json::Value::boolean(true));
    plugins->a->push_back(entry);
  }
  std::string out;
  json::write(doc, out);
  return writeFile(file, out);
}

// ---------------------------------------------------------------- the editor

/** The editor's executable, from /proc while it runs. */
std::string editorExe(long pid) {
  char buf[4096];
  std::string link = "/proc/" + std::to_string(pid) + "/exe";
  ssize_t n = readlink(link.c_str(), buf, sizeof buf - 1);
  if (n <= 0) return {};
  buf[n] = '\0';
  return buf;
}

/**
 * When the process started, from /proc/<pid>/stat (field 22, after the parenthesised
 * name), or 0 when there is none. A process id can be reused once its process exits;
 * the pair (id, start time) cannot, so the editor is known by both.
 */
unsigned long long processStart(long pid) {
  std::string stat;
  if (pid <= 0 || !readFile("/proc/" + std::to_string(pid) + "/stat", stat)) return 0;
  size_t close = stat.rfind(')');
  if (close == std::string::npos) return 0;
  std::vector<std::string> fields;
  std::string field;
  for (size_t i = close + 2; i <= stat.size(); ++i) {
    if (i == stat.size() || stat[i] == ' ') {
      fields.push_back(field);
      field.clear();
    } else {
      field += stat[i];
    }
  }
  // Fields from the state (field 3) on; the start time is field 22.
  return fields.size() > 19 ? std::strtoull(fields[19].c_str(), nullptr, 10) : 0;
}

unsigned long long gEditorStart = 0;

/** The editor Studio was opened for, known by its id and when it started. */
void setEditor(long pid) {
  gEditorPid = pid;
  gEditorStart = processStart(pid);
}

/** That editor still runs: the same id and start time, and an Unreal Editor. */
bool editorRunning(long pid, unsigned long long start) {
  return start != 0 && processStart(pid) == start;
}

struct Restart {
  long pid;
  unsigned long long start;
  std::string exe, project;
  guint64 deadline;
};

gboolean waitForEditorExit(gpointer data) {
  auto* r = static_cast<Restart*>(data);
  bool running = editorRunning(r->pid, r->start);
  if (running && nowMs() < r->deadline) return G_SOURCE_CONTINUE;
  if (!running) {
    const gchar* argv[] = {r->exe.c_str(), r->project.c_str(), nullptr};
    GPid child = 0;
    GError* error = nullptr;
    if (g_spawn_async(dirOf(r->project).c_str(), const_cast<gchar**>(argv), nullptr, G_SPAWN_STDIN_FROM_DEV_NULL, detachChild, nullptr, &child, &error)) {
      setEditor(child);
      logLine("restarted the editor, pid " + std::to_string(child));
    } else {
      logLine(std::string("the editor did not restart: ") + (error ? error->message : "unknown"));
    }
    g_clear_error(&error);
  } else {
    logLine("the editor did not close within ten minutes; not restarting it");
  }
  delete r;
  return G_SOURCE_REMOVE;
}

/**
 * Ask the editor to close, as its window manager's close does (Unreal answers
 * SIGTERM with a normal exit), then start it again on the same project.
 */
bool restartEditor() {
  // Only the editor Studio was opened for: the id it was given must still be that process.
  if (!editorRunning(gEditorPid, gEditorStart)) return false;
  std::string exe = editorExe(gEditorPid);
  std::string project = uproject();
  if (exe.empty() || project.empty()) return false;
  gchar* base = g_path_get_basename(exe.c_str());
  bool unreal = std::string(base).rfind("UnrealEditor", 0) == 0;
  g_free(base);
  if (!unreal) return false;
  if (kill(static_cast<pid_t>(gEditorPid), SIGTERM) != 0) return false;
  g_timeout_add(500, waitForEditorExit, new Restart{gEditorPid, gEditorStart, exe, project, nowMs() + 10 * 60 * 1000});
  return true;
}

// ---------------------------------------------------------------- the page

std::string uiUrl(const Daemon& d) { return "http://127.0.0.1:" + std::to_string(d.port) + "/ui/?token=" + d.token; }

bool fromDaemon(const std::string& url) {
  if (!gLoaded.port) return false;
  std::string a = "http://127.0.0.1:" + std::to_string(gLoaded.port) + "/";
  std::string b = "http://localhost:" + std::to_string(gLoaded.port) + "/";
  return url.rfind(a, 0) == 0 || url.rfind(b, 0) == 0;
}

bool isLocalPage(const std::string& url) { return url.empty() || url == "about:blank" || url.rfind("data:text/html", 0) == 0; }

std::string currentUri() {
  const gchar* u = gWeb ? webkit_web_view_get_uri(gWeb) : nullptr;
  return u ? u : "";
}

void runScript(const std::string& script) {
  if (gWeb) webkit_web_view_evaluate_javascript(gWeb, script.c_str(), -1, nullptr, nullptr, nullptr, nullptr, nullptr);
}

// The page shown while no page from ue-mcp can load: main.cpp's, with Linux fonts.
const char* kLocalPage = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><title>UE-MCP Studio</title>
<style>
  html, body { margin: 0; height: 100%; background: #0c0c0b; color: #e9e6e0; font: 14px/1.5 system-ui, "Cantarell", "Noto Sans", sans-serif; }
  main { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; height: 100%; padding: 0 32px; box-sizing: border-box; gap: 10px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  p { margin: 0; color: #a8a49c; max-width: 34em; }
  .failure { color: #f0a59a; }
  .log { font: 12px ui-monospace, "DejaVu Sans Mono", monospace; color: #8a867e; word-break: break-all; }
  .row { display: flex; gap: 8px; margin-top: 6px; }
  button { background: #2a2926; color: #e9e6e0; border: 0; border-radius: 6px; padding: 8px 16px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
  button.primary { background: #e8720c; color: #0c0c0b; }
  .spinner { width: 14px; height: 14px; border: 2px solid #3a3935; border-top-color: #e8720c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  [hidden] { display: none !important; }
</style></head>
<body><div data-studio-drag style="position: fixed; top: 0; left: 0; right: 0; height: 46px;"></div><main>
  <h1><span id="spin" class="spinner"></span><span id="head">Connecting to ue-mcp</span></h1>
  <p id="body"></p>
  <p id="failure" class="failure" hidden></p>
  <p id="log" class="log" hidden></p>
  <div id="actions" class="row" hidden>
    <button id="node" hidden>Download Node.js</button>
    <button id="openlog">Open log</button>
    <button id="retry" class="primary">Retry</button>
  </div>
</main>
<script>
  function $(id) { return document.getElementById(id); }
  function call(name) { return window.ue && window.ue.studio && window.ue.studio[name] ? window.ue.studio[name]() : Promise.resolve(null); }
  window.studioState = function (s) {
    if (!s || !s.phase) return;
    var needs = s.phase === "needsYou";
    $("head").textContent = s.headline;
    $("body").textContent = s.body;
    $("body").hidden = !s.body;
    $("failure").textContent = s.failure;
    $("failure").hidden = !s.failure;
    $("log").textContent = "Log: " + s.log;
    $("log").hidden = !needs || !s.log;
    $("spin").hidden = needs;
    $("actions").hidden = !needs;
    $("node").hidden = !s.noNode;
  };
  $("retry").onclick = function () { call("retryconnection"); };
  $("openlog").onclick = function () { call("openlog"); };
  $("node").onclick = function () { call("opennodedownload"); };
  call("getconnectionstate").then(function (t) { if (t) window.studioState(JSON.parse(t)); });
</script></body></html>)HTML";

// The editor binds a UObject as window.ue.studio, each call a Promise. The same
// names here, answered by the host: WebKit's message handler with a reply
// resolves the Promise postMessage returns.
const char* kShim = R"JS((function () {
  var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.studio;
  if (!h || (window.ue && window.ue.studio)) return;
  // The host answers only messages that carry this launch's token. The script runs in the
  // top frame alone, so a frame inside the page (a data: iframe) has the handler but not the token.
  var token = "__STUDIO_BRIDGE_TOKEN__";
  function send(m) { return h.postMessage(token + "\u001f" + m); }
  var names = ["getstatus", "startdaemon", "installbridge", "startsetupplan", "getsetupplan", "runsetup", "restarteditor",
    "enableplugin", "openprojectfolder", "geteditortheme", "opennodedownload", "drawattention", "notify", "opendocs",
    "getwindowmode", "setwindowmode", "raiseeditor", "openlog", "setconnectionstate", "getconnectionstate", "retryconnection",
    "startuemcpupdate", "getuemcpupdate", "lastinput"];
  var studio = {};
  names.forEach(function (name) {
    studio[name] = function (arg) {
      return send(name + "\u001f" + (arg === undefined || arg === null ? "" : String(arg)));
    };
  });
  window.ue = window.ue || {};
  window.ue.studio = studio;
  window.ue.studioWindow = true;

  // The page's colors, for the window's own title bar: the top bar's color
  // (the theme-color the page keeps for it) and the theme's variables, sent
  // again whenever the theme changes.
  var pending = 0;
  function report() {
    pending = 0;
    var root = document.documentElement, cs = getComputedStyle(root);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = document.body ? getComputedStyle(document.body).backgroundColor : "";
    send("settheme\u001f" + JSON.stringify({
      bar: (meta && meta.getAttribute("content")) || v("--bg") || bg, panel: v("--panel") || bg,
      text: v("--text") || cs.color, accent: v("--accent"), line: v("--line-strong") || v("--line"), font: v("--sans"),
      barHeight: bar() ? Math.round(bar().getBoundingClientRect().height) : 46
    }));
  }

  // One header: the page's top bar holds the window's buttons at its right
  // (160px, a little over the window's kControlsWidth) and moves
  // the window when dragged from anywhere that is not a control.
  function bar() { return document.querySelector("header.bar"); }
  var chrome = document.createElement("style");
  chrome.textContent = "header.bar { padding-right: 160px !important; -webkit-user-select: none; user-select: none; }";
  function dressPage() { if (!chrome.isConnected && document.head) document.head.appendChild(chrome); }
  var CONTROL = "button, a, input, select, textarea, label, summary, [role=button], [role=tab], [contenteditable], [tabindex]";
  function dragRegion(t) {
    if (!t || !t.closest) return null;
    var region = t.closest("header.bar, [data-studio-drag]");
    if (!region) return null;
    var c = t.closest(CONTROL);
    return c && region.contains(c) ? null : region;
  }
  var press = null;
  document.addEventListener("mousedown", function (e) {
    press = e.button === 0 && dragRegion(e.target) ? { x: e.screenX, y: e.screenY } : null;
    if (press) e.preventDefault();
  }, true);
  document.addEventListener("mousemove", function (e) {
    if (!press) return;
    if (!(e.buttons & 1)) { press = null; return; }
    if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) < 4) return;
    press = null;
    send("dragwindow\u001f");
  }, true);
  document.addEventListener("mouseup", function () { press = null; }, true);
  document.addEventListener("dblclick", function (e) {
    if (e.button === 0 && dragRegion(e.target)) send("togglemaximize\u001f");
  }, true);
  function soon() { if (!pending) pending = setTimeout(report, 30); }
  function watch() {
    dressPage();
    soon();
    var mo = new MutationObserver(soon);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    if (document.head) mo.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ["content"] });
    // The bar appears once the app renders: watch for it until then, and after
    // that only its size, so a busy page (a streaming reply) costs nothing here.
    var sized = null;
    function follow() {
      var b = bar();
      if (b === sized) return;
      sized = b;
      if (b && window.ResizeObserver) new ResizeObserver(soon).observe(b);
      soon();
    }
    var finder = new MutationObserver(function () { follow(); if (sized) finder.disconnect(); });
    finder.observe(document.body || document.documentElement, { childList: true, subtree: true });
    follow();
    if (sized) finder.disconnect();
    window.addEventListener("resize", soon);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
})();)JS";

std::string status() {
  json::Value out = json::Value::object();
  out.set("node", json::Value::boolean(!findNode().empty()));
  out.set("bridgeInstalled", json::Value::boolean(exists(join(join(join(gOpt.project, "Plugins"), "UE_MCP_Bridge"), "UE_MCP_Bridge.uplugin"))));
  out.set("log", json::Value::str(logPath()));
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

void present();

// ---------------------------------------------------------------- notifications

/**
 * Desktop notifications through org.freedesktop.Notifications, which KDE, GNOME and the
 * other desktops serve. GNotification would go through GNOME's org.gtk.Notifications,
 * which drops a notice from an application id with no desktop file, and this id is one
 * per project. Each notice is its own, so they stack; clicking one brings Studio forward
 * and hands its target to the page, as the Windows toast does.
 */
std::map<guint32, std::string> gNoticeTargets;
guint gNoticeSignals = 0;
std::string gIconRef = kAppId;  // the icon's name in the theme, or its path where the theme folder could not be written

void onNoticeSignal(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* signal, GVariant* params, gpointer) {
  std::string name = signal;
  if (name == "NotificationClosed") {
    guint32 id = 0, reason = 0;
    g_variant_get(params, "(uu)", &id, &reason);
    gNoticeTargets.erase(id);
    return;
  }
  if (name != "ActionInvoked") return;
  guint32 id = 0;
  const gchar* key = nullptr;
  g_variant_get(params, "(u&s)", &id, &key);
  auto it = gNoticeTargets.find(id);
  if (it == gNoticeTargets.end()) return;
  std::string target = it->second;
  gNoticeTargets.erase(it);
  present();
  json::Value v;
  if (!target.empty() && json::parse(target, v) && v.isObject()) {
    runScript("window.dispatchEvent(new CustomEvent('studio-notification', { detail: " + target + " }))");
  }
}

void onNoticeShown(GObject* source, GAsyncResult* res, gpointer data) {
  auto* target = static_cast<std::string*>(data);
  GError* error = nullptr;
  GVariant* r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), res, &error);
  if (r) {
    guint32 id = 0;
    g_variant_get(r, "(u)", &id);
    gNoticeTargets[id] = *target;
    // Notices nobody closed or clicked are let go after a while.
    while (gNoticeTargets.size() > 100) gNoticeTargets.erase(gNoticeTargets.begin());
    g_variant_unref(r);
  } else {
    logLine(std::string("the notification was not shown: ") + (error ? error->message : "unknown"));
  }
  g_clear_error(&error);
  delete target;
}

std::string showNotification(const std::string& title, const std::string& text, const std::string& targetJson) {
  GDBusConnection* bus = gApp ? g_application_get_dbus_connection(gApp) : nullptr;
  if (!bus) return toast::answer(false, "freedesktop", {}, 0, "no session bus");
  if (!gNoticeSignals) {
    gNoticeSignals = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.Notifications", "org.freedesktop.Notifications", nullptr,
                                                        "/org/freedesktop/Notifications", nullptr, G_DBUS_SIGNAL_FLAGS_NONE, onNoticeSignal,
                                                        nullptr, nullptr);
  }
  GVariantBuilder actions;
  g_variant_builder_init(&actions, G_VARIANT_TYPE("as"));
  g_variant_builder_add(&actions, "s", "default");
  g_variant_builder_add(&actions, "s", "Open Studio");
  GVariantBuilder hints;
  g_variant_builder_init(&hints, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&hints, "{sv}", "desktop-entry", g_variant_new_string(kAppId));
  g_dbus_connection_call(bus, "org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Notify",
                         g_variant_new("(susssasa{sv}i)", kDisplayName, 0u, gIconRef.c_str(), title.c_str(), text.c_str(), &actions, &hints, -1),
                         G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, onNoticeShown, new std::string(targetJson));
  return toast::answer(true, "freedesktop");
}

/** The editor wants the user: the window asks for attention, and the text shows as a notification. */
bool drawAttention(const std::string& text) {
  if (gMain && gtk_window_is_active(gMain)) return true;
  if (!text.empty()) logLine("attention: " + showNotification(kDisplayName, text, ""));
  return true;
}

std::string notify(const std::string& arg) {
  json::Value v;
  if (!json::parse(arg, v) || !v.isObject()) return toast::answer(false, "freedesktop", {}, 0, "the notification was not JSON");
  const json::Value* text = v.get("text");
  if (!text || !text->isString() || text->s.empty()) return toast::answer(false, "freedesktop", {}, 0, "the notification had no text");
  const json::Value* id = v.get("id");
  if (!gShownNotices.first(id && id->isString() ? id->s : std::string())) {
    logLine("notification: already shown " + id->s);
    return toast::answer(true, "freedesktop", {}, 0, {}, true);
  }
  const json::Value* title = v.get("title");
  const json::Value* target = v.get("target");
  std::string targetJson;
  if (target && target->isObject()) json::write(*target, targetJson, 0, false);
  std::string answer = showNotification(title && title->isString() && !title->s.empty() ? title->s : std::string(kDisplayName), text->s, targetJson);
  logLine("notification: " + answer);
  return answer;
}

// ---------------------------------------------------------------- location and connection

/** Open the panel at a hash it was asked for: kept for the next load, and applied to the page loaded now. */
void goToLocation(const std::string& hash) {
  std::wstring h = wide(hash);
  if (h.empty() || !location::safeFragment(h)) return;
  gLastHash = h;
  makeDirs(studioDir());
  writeFile(locationPath(), hash + "\n");
  if (gWeb && !gLocalPage && gLoaded.port) runScript("window.location.hash = '" + hash + "'");
}

void loadLocation() {
  std::string text;
  if (!readFile(locationPath(), text)) return;
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == ' ')) text.pop_back();
  std::wstring hash = wide(text);
  if (location::safeFragment(hash)) gLastHash = hash;
}

/** The page's URL changed, a hash change included: keep where the panel is. */
void noteLocation(const std::string& url) {
  if (!fromDaemon(url)) return;
  std::wstring hash = location::fragmentOf(wide(url));
  // The panel always has a hash once it runs; an empty one is a page on its way in.
  if (hash.empty() || !location::safeFragment(hash) || hash == gLastHash) return;
  gLastHash = hash;
  makeDirs(studioDir());
  writeFile(locationPath(), ascii(hash) + "\n");
  logLine("location " + ascii(hash));
}

/** An update from the panel is under way: the page keeps its run in the project's Studio data while it lasts. */
bool updateRunning() {
  std::string file = join(join(join(join(join(g_get_home_dir(), ".ue-mcp"), "data"), gOpt.key), "studio"), "update-run.json");
  struct stat st;
  if (stat(file.c_str(), &st) != 0) return false;
  // A run left over from an update nobody closed does not hold the window forever.
  return std::time(nullptr) - st.st_mtime < 15 * 60;
}

conn::Facts facts(const Daemon& d, bool live, bool stale) {
  conn::Facts f;
  f.live = live;
  f.stale = stale;
  f.updating = updateRunning();
  if (live) f.token = d.token;
  return f;
}

std::string connectionJson() {
  if (!gConnActive) return "";
  guint64 now = nowMs();
  json::Value v = json::Value::object();
  v.set("phase", json::Value::str(conn::phaseName(gConn.phase)));
  v.set("headline", json::Value::str(conn::headline(gConn, now)));
  v.set("body", json::Value::str(conn::body(gConn, now)));
  v.set("failure", json::Value::str(gConn.phase == conn::Phase::NeedsYou ? gConn.failure : ""));
  v.set("noNode", json::Value::boolean(gConn.noNode));
  v.set("log", json::Value::str(logPath()));
  std::string text;
  json::write(v, text, 0, false);
  return text;
}

void pushConnection() {
  if (!gWeb || !gLocalPage || !gConnActive) return;
  runScript("window.studioState && window.studioState(" + connectionJson() + ")");
}

conn::Phase gLoggedPhase = conn::Phase::Waiting;
int gLoggedAttempt = -1;

void logConnection() {
  if (gConn.phase == gLoggedPhase && gConn.attempt == gLoggedAttempt) return;
  gLoggedPhase = gConn.phase;
  gLoggedAttempt = gConn.attempt;
  logLine(std::string("connection ") + conn::phaseName(gConn.phase) + " attempt " + std::to_string(gConn.attempt) + ": " + gConn.why +
          (gConn.failure.empty() ? "" : " | " + gConn.failure));
}

/** Studio's page from the daemon, where the panel was. */
void loadUi(const Daemon& d) {
  gLoaded = d;
  gLocalPage = false;
  gPageManaged = false;
  gPagePhase.clear();
  gDaemonMisses = 0;
  gLoadPending = true;
  std::string url = ascii(location::withFragment(wide(uiUrl(d)), gLastHash));
  webkit_web_view_load_uri(gWeb, url.c_str());
  logLine("load port " + std::to_string(d.port) + " " + ascii(gLastHash));
}

void showLocalPage() {
  gLoaded = Daemon();
  gPageManaged = false;
  gLoadPending = false;
  if (!gLocalPage && gWeb) webkit_web_view_load_html(gWeb, kLocalPage, "about:blank");
  gLocalPage = true;
}

void apply(conn::Effect e, const Daemon& d) {
  if (e == conn::Effect::Load) {
    loadUi(d);
  } else if (e == conn::Effect::Start) {
    std::string error;
    bool ok = startDaemon(&error);
    logLine(ok ? "starting the daemon" : "the daemon did not start: " + error);
    conn::started(gConn, ok, findNode().empty(), error, nowMs());
  }
  logConnection();
  pushConnection();
}

/** ue-mcp went away, or never came: the local page, its states starting from the top. */
void beginGap(bool live, bool stale, const Daemon& d) {
  gConn = conn::begin(facts(d, live, stale), nowMs());
  gConnActive = true;
  showLocalPage();
  logConnection();
  pushConnection();
}

void retryConnection() {
  if (!gLocalPage || !gConnActive) return;
  Daemon d;
  bool stale = false;
  bool live = readDaemon(d, &stale);
  apply(conn::retry(gConn, facts(d, live, stale), nowMs()), d);
}

/** The loaded page's report of its connection state; it is in charge of the gap while it reports. */
void notePageState(const std::string& state) {
  if (gLocalPage) return;
  gPageManaged = true;
  json::Value v;
  const json::Value* phase = json::parse(state, v) ? v.get("phase") : nullptr;
  const json::Value* attempt = phase ? v.get("attempt") : nullptr;
  std::string p = phase && phase->isString() ? phase->s : "";
  if (attempt && attempt->isNumber() && attempt->n > 0) p += " attempt " + std::to_string(static_cast<int>(attempt->n));
  if (p == gPagePhase) return;
  gPagePhase = p;
  const json::Value* why = v.get("why");
  const json::Value* failure = v.get("failure");
  logLine("page connection " + p + (why && why->isString() && !why->s.empty() ? ": " + why->s : "") +
          (failure && failure->isString() && !failure->s.empty() ? " | " + failure->s : ""));
}

/** Studio's page from the daemon did not load: the local page says so and tries again. */
void loadFailed(const std::string& why) {
  logLine("Studio's page did not load: " + why);
  Daemon d;
  bool stale = false;
  bool live = readDaemon(d, &stale);
  if (!gConnActive) {
    gConn = conn::begin(facts(d, live, stale), nowMs());
    gConnActive = true;
  }
  gConn.loadToken = gLoaded.token;
  conn::loadFailed(gConn, why, nowMs());
  showLocalPage();
  logConnection();
  pushConnection();
}

/** Load the UI from the project's daemon and follow it to a new port; the local page explains a gap. */
void pollDaemon() {
  if (!gWeb) return;
  Daemon d;
  bool stale = false;
  bool live = readDaemon(d, &stale);
  if (!gLocalPage) {
    if (live) {
      gDaemonMisses = 0;
      if (d.port != gLoaded.port || d.token != gLoaded.token) loadUi(d);
      return;
    }
    if (!gLoaded.port) return beginGap(live, stale, d);
    if (gPageManaged) return;
    // A page that does not report its state: a few seconds' grace, and up to three minutes while an update restarts it.
    if (++gDaemonMisses >= (updateRunning() ? 180 : 5)) beginGap(live, stale, d);
    return;
  }
  if (!gConnActive) return beginGap(live, stale, d);
  apply(conn::tick(gConn, facts(d, live, stale), nowMs()), d);
}

gboolean onDaemonTimer(gpointer) {
  pollDaemon();
  return G_SOURCE_CONTINUE;
}

// ---------------------------------------------------------------- native calls

void notePageTheme(const std::string& arg);
bool beginMove();

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
  if (method == "startuemcpupdate") return b(startUeMcpUpdate(arg));
  if (method == "getuemcpupdate") return s(ueMcpUpdateResult());
  if (method == "restarteditor") return b(restartEditor());
  if (method == "enableplugin") return b(enablePlugin(arg));
  if (method == "openprojectfolder") return b(openPath(gOpt.project));
  if (method == "geteditortheme") {
    // The plugin writes the editor's theme colors here; the editor is never asked.
    std::string text;
    json::Value v;
    return s(readFile(join(studioDir(), "editor-theme.json"), text) && json::parse(text, v) && v.isObject() ? text : std::string());
  }
  if (method == "opennodedownload") {
    openExternal("https://nodejs.org/en/download");
    return b(true);
  }
  if (method == "drawattention") return b(drawAttention(arg));
  if (method == "notify") return s(notify(arg));
  // Input in other programs is not this program's to see on Linux.
  if (method == "lastinput") return "null";
  if (method == "opendocs") {
    std::string path = arg.empty() ? "/docs/" : arg;
    if (path.rfind("/docs", 0) != 0 || path.find("..") != std::string::npos || path.find("://") != std::string::npos) return b(false);
    openExternal("https://ue-mcp.com" + path);
    return b(true);
  }
  // No docked mode: a Linux desktop lets no program hold its window over another's.
  if (method == "getwindowmode") return s("{\"mode\":\"window\",\"canDock\":false}");
  if (method == "setwindowmode") return b(arg == "window");
  // Nor raise another program's window: the editor comes forward when the user picks it.
  if (method == "raiseeditor") return b(false);
  if (method == "openlog") {
    std::string log = logPath();
    makeDirs(dirOf(log));
    if (!exists(log)) appendFile(log, "");
    return b(openPath(log));
  }
  if (method == "setconnectionstate") {
    notePageState(arg);
    return b(true);
  }
  if (method == "getconnectionstate") return s(connectionJson());
  // The shim's report of the page's colors, for the title bar (the window's own chrome).
  if (method == "settheme") {
    notePageTheme(arg);
    return b(true);
  }
  if (method == "dragwindow") return b(beginMove());
  if (method == "togglemaximize") {
    if (!gMain) return b(false);
    if (gtk_window_is_maximized(gMain)) gtk_window_unmaximize(gMain);
    else gtk_window_maximize(gMain);
    return b(true);
  }
  if (method == "retryconnection") {
    retryConnection();
    return b(true);
  }
  return "null";
}

/**
 * A random token per launch, which the shim carries in every message. WebKit gives the
 * reply handler no sending frame, and every frame of the page has the handler; only the
 * top frame, where the shim runs, has the token.
 */
std::string gBridgeToken;

std::string newBridgeToken() {
  unsigned char bytes[16] = {};
  FILE* f = std::fopen("/dev/urandom", "rb");
  bool ok = f && std::fread(bytes, 1, sizeof bytes, f) == sizeof bytes;
  if (f) std::fclose(f);
  if (!ok) for (unsigned char& b : bytes) b = static_cast<unsigned char>(g_random_int_range(0, 256));
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : bytes) {
    out += hex[b >> 4];
    out += hex[b & 15];
  }
  return out;
}

gboolean onScriptMessage(WebKitUserContentManager*, JSCValue* value, WebKitScriptMessageReply* reply, gpointer) {
  JSCContext* ctx = jsc_value_get_context(value);
  std::string from = currentUri();
  std::string result = "null";
  // Only the daemon's pages and the local page reach the host, and only from the shim, which holds the token.
  if ((fromDaemon(from) || (gLocalPage && isLocalPage(from))) && jsc_value_is_string(value)) {
    gchar* raw = jsc_value_to_string(value);
    std::string message = raw ? raw : "";
    g_free(raw);
    std::string prefix = gBridgeToken + "\x1f";
    if (!gBridgeToken.empty() && message.compare(0, prefix.size(), prefix) == 0) {
      message.erase(0, prefix.size());
      size_t a = message.find('\x1f');
      if (a != std::string::npos) result = dispatch(message.substr(0, a), message.substr(a + 1));
    }
  }
  JSCValue* answer = jsc_value_new_from_json(ctx, result.c_str());
  webkit_script_message_reply_return_value(reply, answer);
  g_object_unref(answer);
  return TRUE;
}

// ---------------------------------------------------------------- the view

/** Why a load of Studio's page failed, in plain words. */
std::string loadError(guint status, const GError* error) {
  if (status == 503) return "ue-mcp answered HTTP 503, it has no Studio page installed";
  if (status == 401 || status == 403) return "ue-mcp refused the window's token (HTTP " + std::to_string(status) + ")";
  if (status >= 400) return "ue-mcp answered HTTP " + std::to_string(status);
  if (error && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CONNECTION_REFUSED)) return "ue-mcp did not accept the connection";
  if (error && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT)) return "the connection to ue-mcp timed out";
  return std::string("network error: ") + (error ? error->message : "unknown");
}

gboolean deferLoadFailed(gpointer data) {
  auto* why = static_cast<std::string*>(data);
  loadFailed(*why);
  delete why;
  return G_SOURCE_REMOVE;
}

/** The view's handlers return before the local page loads in its place. */
void failLater(const std::string& why) { g_idle_add(deferLoadFailed, new std::string(why)); }

void onLoadChanged(WebKitWebView* view, WebKitLoadEvent event, gpointer) {
  if (gLocalPage || !gLoadPending) return;
  if (event == WEBKIT_LOAD_COMMITTED) {
    WebKitWebResource* res = webkit_web_view_get_main_resource(view);
    WebKitURIResponse* resp = res ? webkit_web_resource_get_response(res) : nullptr;
    guint status = resp ? webkit_uri_response_get_status_code(resp) : 0;
    gLoadPending = false;
    if (status >= 400) return failLater(loadError(status, nullptr));
    gConnActive = false;
  }
}

gboolean onLoadFailed(WebKitWebView*, WebKitLoadEvent, gchar* uri, GError* error, gpointer) {
  if (gLocalPage || !fromDaemon(uri ? uri : "")) return FALSE;
  // A load replaced by the next one is not a failure.
  if (g_error_matches(error, WEBKIT_NETWORK_ERROR, WEBKIT_NETWORK_ERROR_CANCELLED)) return FALSE;
  if (g_error_matches(error, WEBKIT_POLICY_ERROR, WEBKIT_POLICY_ERROR_FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE)) return FALSE;
  gLoadPending = false;
  failLater(loadError(0, error));
  return TRUE;
}

void onUriChanged(WebKitWebView*, GParamSpec*, gpointer) { noteLocation(currentUri()); }

gboolean onDecidePolicy(WebKitWebView*, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer) {
  if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
  WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(decision));
  const gchar* uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
  std::string url = uri ? uri : "";
  // The daemon's own files (attachments) open in a window of this view, which has its sign-in.
  if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION && fromDaemon(url)) return FALSE;
  if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && (fromDaemon(url) || isLocalPage(url))) return FALSE;
  // Only the daemon's own pages load here; links leave for the system browser.
  webkit_policy_decision_ignore(decision);
  openExternal(url);
  return TRUE;
}

// ---------------------------------------------------------------- the desktop's view of it

/**
 * Studio's mark, drawn as host.h's makeIcon and scripts/studio-mark.mjs draw
 * it: a dark rounded tile, radius 0.18 of its size, with an orange dot, 0.26.
 */
const char* kIconSvg = R"SVG(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="46" fill="#131312"/>
  <circle cx="128" cy="128" r="66.5" fill="#e8720c"/>
</svg>
)SVG";

/** Written only when it differs, so an unchanged entry is not touched on every launch. */
bool writeIfChanged(const std::string& path, const std::string& text) {
  std::string now;
  if (readFile(path, now) && now == text) return true;
  makeDirs(dirOf(path));
  return writeFile(path, text);
}

/** A desktop entry's Exec argument: double-quoted, with the characters the spec reserves escaped. */
std::string quoteExec(const std::string& arg) {
  std::string out = "\"";
  for (char c : arg) {
    // The string escape runs before the quoting rule: a backslash is four, the others two and themselves.
    if (c == '\\') out += "\\\\\\\\";
    else if (c == '"' || c == '`' || c == '$') out += std::string("\\\\") + c;
    else if (c == '%') out += "%%";
    else out += c;
  }
  return out + "\"";
}

/**
 * The icon, for the entry's Icon key: by name from the user's icon theme, or,
 * where that folder cannot be written (some installers leave it root's), by
 * its path in Studio's own data folder, which the spec also accepts.
 */
std::string installIcon() {
  std::string data = g_get_user_data_dir();
  if (writeIfChanged(join(data, std::string("icons/hicolor/scalable/apps/") + kAppId + ".svg"), kIconSvg)) return kAppId;
  std::string own = join(join(join(data, "ue-mcp"), "studio-window"), std::string(kAppId) + ".svg");
  if (writeIfChanged(own, kIconSvg)) return own;
  logLine("could not write Studio's icon");
  return kAppId;
}

/**
 * A desktop entry and icon for kAppId under the user's data folder: what the
 * desktop matches a window's app id against for its name and icon. Without it
 * the window is filed under whatever process started it. It is NoDisplay,
 * since Studio opens from the editor or the agent, never from a menu.
 */
void installDesktopEntry() {
  std::string data = g_get_user_data_dir();
  std::string icon = installIcon();
  gIconRef = icon;
  char exe[4096];
  ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
  std::string self = n > 0 ? std::string(exe, static_cast<size_t>(n)) : "studio-window";
  std::string entry = std::string("[Desktop Entry]\n") +
                      "Type=Application\n"
                      "Name=" + kDisplayName + "\n"
                      "Comment=The in-editor client for ue-mcp, in its own window\n"
                      "Icon=" + icon + "\n"
                      "Exec=" + quoteExec(self) + "\n"
                      "StartupWMClass=" + kAppId + "\n"
                      "Categories=Development;\n"
                      "NoDisplay=true\n";
  if (!writeIfChanged(join(data, std::string("applications/") + kAppId + ".desktop"), entry)) logLine("could not write Studio's desktop entry");
}

/**
 * The window's app id on Wayland, kAppId rather than the per-project
 * application id. GTK gives a GtkApplication's windows that id when their
 * surface first maps, so this runs after map as well as at realize.
 */
void setAppId(GtkWidget* w, gpointer) {
#ifdef GDK_WINDOWING_WAYLAND
  GdkSurface* surface = gtk_native_get_surface(GTK_NATIVE(w));
  if (surface && GDK_IS_WAYLAND_TOPLEVEL(surface)) gdk_wayland_toplevel_set_application_id(GDK_TOPLEVEL(surface), kAppId);
#else
  (void)w;
#endif
}

/** Every Studio window: its icon, and the app id the desktop files it under. */
void identify(GtkWindow* w) {
  gtk_window_set_icon_name(w, kAppId);
  g_signal_connect_after(w, "realize", G_CALLBACK(setAppId), nullptr);
  g_signal_connect_after(w, "map", G_CALLBACK(setAppId), nullptr);
}

/**
 * A popup only ever holds the daemon's own pages (an attachment, which needs this
 * view's sign-in). A popup on its way anywhere else, such as a sign-in page opened
 * with window.open(), goes to the system browser instead and never shows here.
 */
const char* kPopupExternal = "studio-popup-external";

void onPopupReady(WebKitWebView* popup, gpointer) {
  if (g_object_get_data(G_OBJECT(popup), kPopupExternal)) return;
  GtkWidget* w = gtk_window_new();
  gtk_window_set_title(GTK_WINDOW(w), kDisplayName);
  identify(GTK_WINDOW(w));
  gtk_window_set_default_size(GTK_WINDOW(w), 900, 700);
  gtk_window_set_child(GTK_WINDOW(w), GTK_WIDGET(popup));
  gtk_window_present(GTK_WINDOW(w));
}

void onPopupClose(WebKitWebView* popup, gpointer) {
  GtkRoot* root = gtk_widget_get_root(GTK_WIDGET(popup));
  if (root) {
    gtk_window_destroy(GTK_WINDOW(root));
    return;
  }
  // Never shown (it left for the system browser): a window that owns it disposes of it.
  GtkWidget* holder = gtk_window_new();
  gtk_window_set_child(GTK_WINDOW(holder), GTK_WIDGET(popup));
  gtk_window_destroy(GTK_WINDOW(holder));
}

/**
 * A popup's own navigations: the daemon's pages stay, anything else leaves for
 * the system browser, and a popup that was opened blank for it closes. This is
 * what catches window.open() followed by setting the popup's location.
 */
gboolean onPopupPolicy(WebKitWebView* popup, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer) {
  if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
  WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(decision));
  const gchar* uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
  std::string url = uri ? uri : "";
  if (fromDaemon(url) || url.empty() || url == "about:blank") return FALSE;
  webkit_policy_decision_ignore(decision);
  openExternal(url);
  const gchar* current = webkit_web_view_get_uri(popup);
  if (!current || !*current || std::string(current) == "about:blank") {
    g_object_set_data(G_OBJECT(popup), kPopupExternal, GINT_TO_POINTER(1));
    webkit_web_view_try_close(popup);
  }
  return TRUE;
}

GtkWidget* onCreate(WebKitWebView* view, WebKitNavigationAction* action, gpointer) {
  const gchar* uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
  std::string url = uri ? uri : "";
  // Somewhere other than the daemon, already known: straight to the system browser, no popup at all.
  if (!url.empty() && url != "about:blank" && !fromDaemon(url)) {
    openExternal(url);
    return nullptr;
  }
  GtkWidget* popup = GTK_WIDGET(g_object_new(WEBKIT_TYPE_WEB_VIEW, "related-view", view, nullptr));
  g_signal_connect(popup, "ready-to-show", G_CALLBACK(onPopupReady), nullptr);
  g_signal_connect(popup, "close", G_CALLBACK(onPopupClose), nullptr);
  g_signal_connect(popup, "decide-policy", G_CALLBACK(onPopupPolicy), nullptr);
  return popup;
}

gboolean onPermission(WebKitWebView*, WebKitPermissionRequest* request, gpointer) {
  // The composer's paste reads the clipboard; nothing else the page asks for is granted.
  if (WEBKIT_IS_CLIPBOARD_PERMISSION_REQUEST(request) && fromDaemon(currentUri())) webkit_permission_request_allow(request);
  else webkit_permission_request_deny(request);
  return TRUE;
}

void onWebProcessTerminated(WebKitWebView*, WebKitWebProcessTerminationReason reason, gpointer) {
  logLine(std::string("the view's web process ended") + (reason == WEBKIT_WEB_PROCESS_CRASHED ? " (crashed)" : "") + "; loading again");
  gLoaded = Daemon();
  gLocalPage = false;
  pollDaemon();
}

WebKitWebView* createWebView() {
  std::string data = join(join(g_get_user_data_dir(), "ue-mcp"), "studio-window");
  std::string cache = join(join(g_get_user_cache_dir(), "ue-mcp"), "studio-window");
  makeDirs(data);
  makeDirs(cache);
  WebKitNetworkSession* session = webkit_network_session_new(data.c_str(), cache.c_str());

  WebKitUserContentManager* ucm = webkit_user_content_manager_new();
  gBridgeToken = newBridgeToken();
  std::string shimSource = kShim;
  size_t at = shimSource.find("__STUDIO_BRIDGE_TOKEN__");
  if (at != std::string::npos) shimSource.replace(at, std::strlen("__STUDIO_BRIDGE_TOKEN__"), gBridgeToken);
  WebKitUserScript* shim = webkit_user_script_new(shimSource.c_str(), WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, nullptr, nullptr);
  webkit_user_content_manager_add_script(ucm, shim);
  webkit_user_script_unref(shim);
  webkit_user_content_manager_register_script_message_handler_with_reply(ucm, "studio", nullptr);
  g_signal_connect(ucm, "script-message-with-reply-received::studio", G_CALLBACK(onScriptMessage), nullptr);

  WebKitSettings* settings = webkit_settings_new();
  bool devtools = !env("STUDIO_WINDOW_DEVTOOLS").empty();
  webkit_settings_set_enable_developer_extras(settings, devtools);
  webkit_settings_set_javascript_can_access_clipboard(settings, TRUE);
  // The page opens links after an await (a sign-in's URL comes back from the agent first).
  // Chromium, which the page is built for, keeps a click's activation for seconds;
  // WebKit's lapses sooner and blocks the popup. Every popup is handled in onCreate:
  // the daemon's own pages stay here, anything else goes to the system browser.
  webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
  webkit_settings_set_enable_back_forward_navigation_gestures(settings, FALSE);

  auto* view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "network-session", session, "user-content-manager", ucm, "settings", settings, nullptr));
  g_object_unref(session);
  g_object_unref(ucm);
  g_object_unref(settings);

  GdkRGBA bg = {0x0c / 255.0f, 0x0c / 255.0f, 0x0b / 255.0f, 1.0f};
  webkit_web_view_set_background_color(view, &bg);
  g_signal_connect(view, "decide-policy", G_CALLBACK(onDecidePolicy), nullptr);
  g_signal_connect(view, "load-changed", G_CALLBACK(onLoadChanged), nullptr);
  g_signal_connect(view, "load-failed", G_CALLBACK(onLoadFailed), nullptr);
  g_signal_connect(view, "notify::uri", G_CALLBACK(onUriChanged), nullptr);
  g_signal_connect(view, "create", G_CALLBACK(onCreate), nullptr);
  g_signal_connect(view, "permission-request", G_CALLBACK(onPermission), nullptr);
  g_signal_connect(view, "web-process-terminated", G_CALLBACK(onWebProcessTerminated), nullptr);
  return view;
}

// ---------------------------------------------------------------- the window's own chrome

// Studio has one header: the page's own top bar (header.bar). The desktop's
// title bar is gone; the window's buttons (a menu, minimize, maximize, close)
// float over the right end of the page's bar, which the shim keeps clear for
// them, and dragging the bar's empty parts moves the window. GTK draws the
// frame client-side, so the resize edges, shadow and rounded corners are its
// own. The page reports its theme and its bar's height (the shim's settheme),
// so the buttons take its colors and sit centered in it.
//
// The shim's part of this reads the page's header.bar: a change to the top
// bar's markup that drops that class leaves the buttons over the page.

/** The width the buttons take; the shim keeps 160px clear at the right of the page's bar for them. */
constexpr int kControlsWidth = 4 * 34 + 8;

void saveState();

/** The page's colors the chrome paints with; parsed and checked, never pasted from the page as is. */
struct Theme {
  GdkRGBA bar = {0x0c / 255.0f, 0x0c / 255.0f, 0x0b / 255.0f, 1};
  GdkRGBA panel = {0x13 / 255.0f, 0x13 / 255.0f, 0x12 / 255.0f, 1};
  GdkRGBA text = {0xec / 255.0f, 0xe9 / 255.0f, 0xe3 / 255.0f, 1};
  GdkRGBA accent = {0xe8 / 255.0f, 0x72 / 255.0f, 0x0c / 255.0f, 1};
  GdkRGBA line = {1, 1, 1, 0.12f};
  std::string font;
  int barHeight = 46;  // the page's top bar, which the buttons center in
};

Theme gTheme;
std::string gThemeCss;
GtkCssProvider* gCss = nullptr;
GtkWidget* gMaxButton = nullptr;
GtkWidget* gControls = nullptr;
bool gQuitting = false;
bool gCloseToTray = false;

std::string css(const GdkRGBA& c, float alpha = 1) {
  char buf[96];
  std::snprintf(buf, sizeof buf, "rgba(%d,%d,%d,%.3f)", static_cast<int>(c.red * 255 + 0.5f), static_cast<int>(c.green * 255 + 0.5f),
                static_cast<int>(c.blue * 255 + 0.5f), c.alpha * alpha);
  return buf;
}

/** A font list from the page's --sans: family names, quotes and commas only. */
std::string safeFont(const std::string& f) {
  if (f.empty() || f.size() > 300) return {};
  for (char c : f) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != ' ' && c != ',' && c != '"' && c != '\'' && c != '-') return {};
  }
  return f;
}

void applyChromeCss() {
  const Theme& t = gTheme;
  std::string font = t.font.empty() ? std::string() : "font-family: " + t.font + ";";
  std::string s =
      "window.studio { background: " + css(t.bar) + "; }"
      "window.studio.csd { border-radius: 10px; }"
      "window.studio.csd decoration { border-radius: 10px; box-shadow: 0 4px 16px 2px rgba(0,0,0,0.55), 0 0 0 1px " + css(t.line) + "; }"
      "window.studio.maximized, window.studio.fullscreen, window.studio.tiled { border-radius: 0; }"
      "window.studio.maximized decoration, window.studio.fullscreen decoration, window.studio.tiled decoration { border-radius: 0; box-shadow: none; }"
      ".studio-controls { background: none; padding: 0 6px 0 2px; }"
      "window.studio:backdrop .studio-controls { opacity: 0.75; }"
      ".studio-nobar { min-height: 0; padding: 0; margin: 0; background: none; border: none; box-shadow: none; }"
      ".studio-btn, .studio-menu > button { background: none; border: none; box-shadow: none; outline: none; min-width: 32px; min-height: 26px;"
      " padding: 0; margin: 0 0 0 2px; border-radius: 6px; color: " + css(t.text, 0.7f) + "; }"
      ".studio-btn:hover, .studio-menu > button:hover, .studio-menu > button:checked { background: " + css(t.text, 0.09f) + "; color: " + css(t.text) + "; }"
      ".studio-btn:active { background: " + css(t.text, 0.15f) + "; }"
      ".studio-close:hover { background: #c42b1c; color: #ffffff; }"
      ".studio-close:active { background: #a52314; color: #ffffff; }"
      "popover.studio-popover > contents { background: " + css(t.panel) + "; color: " + css(t.text) + "; border: 1px solid " + css(t.line) + "; border-radius: 8px; padding: 4px; " + font + " }"
      "popover.studio-popover > arrow { background: " + css(t.panel) + "; border-color: " + css(t.line) + "; }"
      "popover.studio-popover modelbutton { border-radius: 5px; padding: 5px 10px; min-height: 0; }"
      "popover.studio-popover modelbutton:hover { background: " + css(t.accent, 0.18f) + "; }"
      "popover.studio-popover check { color: " + css(t.accent) + "; }"
      "popover.studio-popover separator { background: " + css(t.line) + "; margin: 4px 2px; }";
  if (s == gThemeCss) return;
  gThemeCss = s;
  if (!gCss) {
    gCss = gtk_css_provider_new();
    gtk_style_context_add_provider_for_display(gdk_display_get_default(), GTK_STYLE_PROVIDER(gCss), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
  }
  gtk_css_provider_load_from_string(gCss, s.c_str());
}

/** The page's theme, from the shim: { bar, panel, text, accent, line, font }; a color that does not parse keeps its default. */
void notePageTheme(const std::string& arg) {
  json::Value v;
  if (!json::parse(arg, v) || !v.isObject()) return;
  Theme t;
  auto color = [&](const char* key, GdkRGBA& into) {
    const json::Value* c = v.get(key);
    GdkRGBA parsed;
    if (c && c->isString() && c->s.size() < 100 && gdk_rgba_parse(&parsed, c->s.c_str()) && parsed.alpha > 0) into = parsed;
  };
  color("bar", t.bar);
  color("panel", t.panel);
  color("text", t.text);
  color("accent", t.accent);
  color("line", t.line);
  // The window's outline must show on a dark desktop; a hairline the page uses inside it may not.
  if (t.line.alpha < 0.1f) t.line.alpha = 0.12f;
  if (const json::Value* f = v.get("font"); f && f->isString()) t.font = safeFont(f->s);
  if (const json::Value* h = v.get("barHeight"); h && h->isNumber() && h->n >= 24 && h->n <= 120) t.barHeight = static_cast<int>(h->n);
  gTheme = t;
  applyChromeCss();
  if (gControls) gtk_widget_set_size_request(gControls, kControlsWidth, gTheme.barHeight);
}

// The title bar's glyphs, drawn rather than taken from the icon theme, so they
// are the same on every desktop and take the bar's text color.
enum class Glyph { Minimize, Maximize, Restore, Close, Menu };

void drawGlyph(GtkDrawingArea* area, cairo_t* cr, int w, int h, gpointer data) {
  auto g = static_cast<Glyph>(GPOINTER_TO_INT(g_object_get_data(G_OBJECT(area), "glyph")));
  (void)data;
  double cx = w / 2.0, cy = h / 2.0;
  GdkRGBA c;
  gtk_widget_get_color(GTK_WIDGET(area), &c);
  gdk_cairo_set_source_rgba(cr, &c);
  cairo_set_line_width(cr, 1.1);
  const double k = 4.5;
  switch (g) {
    case Glyph::Minimize:
      cairo_move_to(cr, cx - k, cy + 0.5);
      cairo_line_to(cr, cx + k, cy + 0.5);
      break;
    case Glyph::Maximize:
      cairo_rectangle(cr, cx - k + 0.5, cy - k + 0.5, 2 * k - 1, 2 * k - 1);
      break;
    case Glyph::Restore:
      cairo_rectangle(cr, cx - k + 0.5, cy - k + 2.5, 2 * k - 3, 2 * k - 3);
      cairo_move_to(cr, cx - k + 2.5, cy - k + 2.5);
      cairo_line_to(cr, cx - k + 2.5, cy - k + 0.5);
      cairo_line_to(cr, cx + k - 0.5, cy - k + 0.5);
      cairo_line_to(cr, cx + k - 0.5, cy + k - 2.5);
      cairo_line_to(cr, cx + k - 2.5, cy + k - 2.5);
      break;
    case Glyph::Close:
      cairo_move_to(cr, cx - k, cy - k);
      cairo_line_to(cr, cx + k, cy + k);
      cairo_move_to(cr, cx + k, cy - k);
      cairo_line_to(cr, cx - k, cy + k);
      break;
    case Glyph::Menu:
      for (int i = -1; i <= 1; ++i) {
        cairo_new_sub_path(cr);
        cairo_arc(cr, cx + i * 4.5, cy, 1.15, 0, 2 * G_PI);
      }
      cairo_fill(cr);
      return;
    default:
      return;
  }
  cairo_stroke(cr);
}

GtkWidget* glyph(Glyph g, int size = 16) {
  GtkWidget* area = gtk_drawing_area_new();
  gtk_drawing_area_set_content_width(GTK_DRAWING_AREA(area), size);
  gtk_drawing_area_set_content_height(GTK_DRAWING_AREA(area), size);
  g_object_set_data(G_OBJECT(area), "glyph", GINT_TO_POINTER(static_cast<int>(g)));
  gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(area), drawGlyph, nullptr, nullptr);
  gtk_widget_set_halign(area, GTK_ALIGN_CENTER);
  gtk_widget_set_valign(area, GTK_ALIGN_CENTER);
  return area;
}

/** A title bar button: it never takes focus from the page. */
GtkWidget* chromeButton(Glyph g, const char* tooltip, GCallback onClick, const char* extraClass = nullptr) {
  GtkWidget* b = gtk_button_new();
  gtk_button_set_child(GTK_BUTTON(b), glyph(g));
  gtk_widget_add_css_class(b, "studio-btn");
  if (extraClass) gtk_widget_add_css_class(b, extraClass);
  gtk_widget_set_focusable(b, FALSE);
  gtk_widget_set_focus_on_click(b, FALSE);
  gtk_widget_set_tooltip_text(b, tooltip);
  gtk_widget_set_valign(b, GTK_ALIGN_CENTER);
  g_signal_connect(b, "clicked", onClick, nullptr);
  return b;
}

void onMinimize(GtkButton*, gpointer) { gtk_window_minimize(gMain); }
void onMaximize(GtkButton*, gpointer) {
  if (gtk_window_is_maximized(gMain)) gtk_window_unmaximize(gMain);
  else gtk_window_maximize(gMain);
}
void onClose(GtkButton*, gpointer) { gtk_window_close(gMain); }

void onMaximizedChanged(GObject*, GParamSpec*, gpointer) {
  if (!gMaxButton) return;
  bool max = gtk_window_is_maximized(gMain);
  GtkWidget* area = gtk_button_get_child(GTK_BUTTON(gMaxButton));
  g_object_set_data(G_OBJECT(area), "glyph", GINT_TO_POINTER(static_cast<int>(max ? Glyph::Restore : Glyph::Maximize)));
  gtk_widget_set_tooltip_text(gMaxButton, max ? "Restore" : "Maximize");
  gtk_widget_queue_draw(area);
}

// ---- the close preference: quit, or keep running in the system tray

std::string prefsPath() { return join(join(g_get_user_config_dir(), "ue-mcp"), "studio-window.json"); }

void loadPrefs() {
  std::string text;
  json::Value v;
  if (!readFile(prefsPath(), text) || !json::parse(text, v) || !v.isObject()) return;
  if (const json::Value* c = v.get("closeToTray"); c && c->isBool()) gCloseToTray = c->b;
}

void savePrefs() {
  makeDirs(dirOf(prefsPath()));
  writeFile(prefsPath(), std::string("{\"closeToTray\":") + (gCloseToTray ? "true" : "false") + "}\n");
}

void onCloseToTray(GSimpleAction* action, GVariant* value, gpointer) {
  gCloseToTray = g_variant_get_boolean(value);
  g_simple_action_set_state(action, value);
  savePrefs();
  logLine(std::string("close ") + (gCloseToTray ? "keeps Studio running in the system tray" : "quits Studio"));
}

/** Quit for real, whatever the close button does. */
void quitStudio() {
  logLine("quit");
  gQuitting = true;
  saveState();
  g_application_quit(gApp);
}

void onQuit(GSimpleAction*, GVariant*, gpointer) { quitStudio(); }

/** The menu's actions, on the application: app.close-to-tray and app.quit (Ctrl+Q). */
void addChromeActions() {
  loadPrefs();
  GSimpleAction* keep = g_simple_action_new_stateful("close-to-tray", nullptr, g_variant_new_boolean(gCloseToTray));
  g_signal_connect(keep, "change-state", G_CALLBACK(onCloseToTray), nullptr);
  g_action_map_add_action(G_ACTION_MAP(gApp), G_ACTION(keep));
  g_object_unref(keep);
  GSimpleAction* quit = g_simple_action_new("quit", nullptr);
  g_signal_connect(quit, "activate", G_CALLBACK(onQuit), nullptr);
  g_action_map_add_action(G_ACTION_MAP(gApp), G_ACTION(quit));
  g_object_unref(quit);
  const char* quitKeys[] = {"<Control>q", nullptr};
  gtk_application_set_accels_for_action(GTK_APPLICATION(gApp), "app.quit", quitKeys);
}

GtkWidget* chromeMenu() {
  GMenu* menu = g_menu_new();
  GMenu* window = g_menu_new();
  g_menu_append(window, "Keep running in the system tray when closed", "app.close-to-tray");
  g_menu_append_section(menu, nullptr, G_MENU_MODEL(window));
  GMenu* quit = g_menu_new();
  g_menu_append(quit, "Quit Studio", "app.quit");
  g_menu_append_section(menu, nullptr, G_MENU_MODEL(quit));
  GtkWidget* button = gtk_menu_button_new();
  gtk_menu_button_set_menu_model(GTK_MENU_BUTTON(button), G_MENU_MODEL(menu));
  gtk_menu_button_set_child(GTK_MENU_BUTTON(button), glyph(Glyph::Menu));
  gtk_widget_add_css_class(button, "studio-menu");
  gtk_widget_set_focusable(button, FALSE);
  gtk_widget_set_tooltip_text(button, "Studio window");
  gtk_widget_set_valign(button, GTK_ALIGN_CENTER);
  if (GtkPopover* pop = gtk_menu_button_get_popover(GTK_MENU_BUTTON(button))) gtk_widget_add_css_class(GTK_WIDGET(pop), "studio-popover");
  g_object_unref(window);
  g_object_unref(quit);
  g_object_unref(menu);
  return button;
}

/** The window's buttons: the menu, minimize, maximize and close, at the right of the page's top bar. */
GtkWidget* windowControls() {
  GtkWidget* box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_add_css_class(box, "studio-controls");
  gtk_box_append(GTK_BOX(box), chromeMenu());
  gtk_box_append(GTK_BOX(box), chromeButton(Glyph::Minimize, "Minimize", G_CALLBACK(onMinimize)));
  gMaxButton = chromeButton(Glyph::Maximize, "Maximize", G_CALLBACK(onMaximize));
  gtk_box_append(GTK_BOX(box), gMaxButton);
  gtk_box_append(GTK_BOX(box), chromeButton(Glyph::Close, "Close", G_CALLBACK(onClose), "studio-close"));
  gtk_widget_set_halign(box, GTK_ALIGN_END);
  gtk_widget_set_valign(box, GTK_ALIGN_START);
  gtk_widget_set_size_request(box, kControlsWidth, gTheme.barHeight);
  return box;
}

/** The page under the window's buttons: the buttons take clicks, everything else reaches the page. */
GtkWidget* chromeContent(GtkWidget* view) {
  GtkWidget* overlay = gtk_overlay_new();
  gtk_overlay_set_child(GTK_OVERLAY(overlay), view);
  gControls = windowControls();
  gtk_overlay_add_overlay(GTK_OVERLAY(overlay), gControls);
  return overlay;
}

/**
 * Start moving the window, for a drag the shim saw start on the page's top bar.
 * The desktop takes the pointer from here, as it does for a title bar's drag.
 */
bool beginMove() {
  GdkSurface* surface = gMain ? gtk_native_get_surface(GTK_NATIVE(gMain)) : nullptr;
  if (!surface || !GDK_IS_TOPLEVEL(surface)) return false;
  GdkSeat* seat = gdk_display_get_default_seat(gdk_surface_get_display(surface));
  GdkDevice* pointer = seat ? gdk_seat_get_pointer(seat) : nullptr;
  if (!pointer) return false;
  double x = 0, y = 0;
  GdkModifierType mask = static_cast<GdkModifierType>(0);
  gdk_surface_get_device_position(surface, pointer, &x, &y, &mask);
  // The button already up: the drag is over, and a move now would follow a released pointer.
  if (!(mask & GDK_BUTTON1_MASK)) return false;
  gdk_toplevel_begin_move(GDK_TOPLEVEL(surface), pointer, GDK_BUTTON_PRIMARY, x, y, GDK_CURRENT_TIME);
  return true;
}

/** The chrome on the main window: no desktop title bar, the frame clipped to its rounded corners. */
void dressWindow() {
  addChromeActions();
  applyChromeCss();
  gtk_widget_add_css_class(GTK_WIDGET(gMain), "studio");
  // An empty title bar: GTK keeps its client-side frame, and the page's own top bar is the header.
  GtkWidget* none = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_add_css_class(none, "studio-nobar");
  gtk_window_set_titlebar(gMain, none);
  gtk_widget_set_overflow(GTK_WIDGET(gMain), GTK_OVERFLOW_HIDDEN);
  g_signal_connect(gMain, "notify::maximized", G_CALLBACK(onMaximizedChanged), nullptr);
}

// ---------------------------------------------------------------- the system tray

// Studio's icon in the desktop's status area (KDE's system tray, and any panel
// that hosts StatusNotifierItems) for as long as the window runs. A click
// brings Studio forward, or hides it when it is already in front; its menu
// shows Studio or quits it. With "Keep running in the system tray when
// closed", closing hides the window, off the desktop and the taskbar, and the
// icon brings it back. The protocol is org.kde.StatusNotifierItem with a
// com.canonical.dbusmenu menu, both served here over the session bus; where
// no tray is running (no StatusNotifierWatcher), there is no icon and close
// does not hide the window.

void present();
void quitStudio();

const char* kTrayXml = R"XML(<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/><arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/><arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/><arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/><arg name="name" type="s" direction="in"/><arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/><arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/><arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/><arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow"><arg name="id" type="i" direction="in"/><arg name="needUpdate" type="b" direction="out"/></method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/><arg name="updatesNeeded" type="ai" direction="out"/><arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
    <signal name="LayoutUpdated"><arg name="revision" type="u"/><arg name="parent" type="i"/></signal>
    <signal name="ItemActivationRequested"><arg name="id" type="i"/><arg name="timestamp" type="u"/></signal>
  </interface>
</node>)XML";

constexpr const char* kTrayPath = "/StatusNotifierItem";
constexpr const char* kTrayMenuPath = "/StatusNotifierItem/Menu";
// The menu: the root (0), Show Studio, a separator, Quit Studio.
enum TrayItem { kTrayRoot = 0, kTrayShow = 1, kTraySeparator = 2, kTrayQuit = 3 };

GDBusNodeInfo* gTrayInfo = nullptr;
std::string gTrayBusName;
bool gTrayShown = false;  // the watcher has the icon: the tray holds Studio while its window is hidden
guint gTrayWatch = 0;

/** Studio's mark as the tray wants it: ARGB32 rows in network byte order, as in scripts/studio-mark.mjs. */
GVariant* trayPixmaps() {
  GVariantBuilder all;
  g_variant_builder_init(&all, G_VARIANT_TYPE("a(iiay)"));
  for (int size : {16, 22, 24, 32, 48, 64}) {
    std::vector<guint8> px(static_cast<size_t>(size) * size * 4);
    const double c = (size - 1) / 2.0, dot = size * 0.26, tile = size * 0.5, radius = size * 0.18;
    auto clamp = [](double v) { return v < 0 ? 0.0 : v > 1 ? 1.0 : v; };
    for (int y = 0; y < size; ++y) {
      for (int x = 0; x < size; ++x) {
        double qx = std::max(std::fabs(x - c) - (tile - radius), 0.0), qy = std::max(std::fabs(y - c) - (tile - radius), 0.0);
        double tileA = clamp(radius - std::hypot(qx, qy) + 0.5);
        double dotA = clamp(dot - std::hypot(x - c, y - c) + 0.5);
        guint8* p = &px[(static_cast<size_t>(y) * size + x) * 4];
        p[0] = static_cast<guint8>(tileA * 255);
        p[1] = static_cast<guint8>(0x13 + (0xe8 - 0x13) * dotA);
        p[2] = static_cast<guint8>(0x13 + (0x72 - 0x13) * dotA);
        p[3] = static_cast<guint8>(0x12 + (0x0c - 0x12) * dotA);
      }
    }
    GVariant* bytes = g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, px.data(), px.size(), 1);
    g_variant_builder_add(&all, "(ii@ay)", size, size, bytes);
  }
  return g_variant_builder_end(&all);
}

GVariant* noPixmaps() { return g_variant_new_array(G_VARIANT_TYPE("(iiay)"), nullptr, 0); }

std::string trayTitle() { return gOpt.title.empty() ? kDisplayName : std::string(kDisplayName) + " - " + gOpt.title; }

GVariant* trayProperty(GDBusConnection*, const gchar*, const gchar*, const gchar* iface, const gchar* name, GError**, gpointer) {
  std::string i = iface, n = name;
  if (i == "com.canonical.dbusmenu") {
    if (n == "Version") return g_variant_new_uint32(3);
    if (n == "TextDirection") return g_variant_new_string("ltr");
    if (n == "Status") return g_variant_new_string("normal");
    if (n == "IconThemePath") return g_variant_new_strv(nullptr, 0);
    return nullptr;
  }
  if (n == "Category") return g_variant_new_string("ApplicationStatus");
  if (n == "Id") return g_variant_new_string(kAppId);
  if (n == "Title") return g_variant_new_string(trayTitle().c_str());
  if (n == "Status") return g_variant_new_string("Active");
  if (n == "WindowId") return g_variant_new_int32(0);
  if (n == "IconName" || n == "OverlayIconName" || n == "AttentionIconName") return g_variant_new_string("");
  if (n == "IconPixmap") return trayPixmaps();
  if (n == "OverlayIconPixmap" || n == "AttentionIconPixmap") return noPixmaps();
  if (n == "ToolTip") return g_variant_new("(s@a(iiay)ss)", "", noPixmaps(), kDisplayName, gOpt.title.c_str());
  if (n == "ItemIsMenu") return g_variant_new_boolean(FALSE);
  if (n == "Menu") return g_variant_new_object_path(kTrayMenuPath);
  return nullptr;
}

GVariant* menuProps(int id) {
  GVariantBuilder p;
  g_variant_builder_init(&p, G_VARIANT_TYPE("a{sv}"));
  if (id == kTrayRoot) g_variant_builder_add(&p, "{sv}", "children-display", g_variant_new_string("submenu"));
  if (id == kTrayShow) g_variant_builder_add(&p, "{sv}", "label", g_variant_new_string("Show Studio"));
  if (id == kTraySeparator) g_variant_builder_add(&p, "{sv}", "type", g_variant_new_string("separator"));
  if (id == kTrayQuit) g_variant_builder_add(&p, "{sv}", "label", g_variant_new_string("Quit Studio"));
  return g_variant_builder_end(&p);
}

GVariant* menuNode(int id) {
  GVariantBuilder kids;
  g_variant_builder_init(&kids, G_VARIANT_TYPE("av"));
  if (id == kTrayRoot) {
    for (int k : {kTrayShow, kTraySeparator, kTrayQuit}) g_variant_builder_add(&kids, "v", menuNode(k));
  }
  return g_variant_new("(i@a{sv}@av)", id, menuProps(id), g_variant_builder_end(&kids));
}

bool knownItem(int id) { return id >= kTrayRoot && id <= kTrayQuit; }

/** Show Studio, or hide it when it is in front; never hidden where no tray can bring it back. */
void toggleFromTray() {
  if (!gMain) return;
  if (gtk_widget_get_visible(GTK_WIDGET(gMain)) && gtk_window_is_active(gMain)) gtk_widget_set_visible(GTK_WIDGET(gMain), FALSE);
  else present();
}

gboolean deferTrayQuit(gpointer) {
  quitStudio();
  return G_SOURCE_REMOVE;
}

void onMenuEvent(int id, const char* event) {
  if (std::string(event) != "clicked") return;
  if (id == kTrayShow) present();
  // After the call returns, so the menu's answer goes out before the window closes.
  if (id == kTrayQuit) g_idle_add(deferTrayQuit, nullptr);
}

void trayCall(GDBusConnection*, const gchar*, const gchar*, const gchar* iface, const gchar* method, GVariant* params,
              GDBusMethodInvocation* call, gpointer) {
  std::string i = iface, m = method;
  if (i == "org.kde.StatusNotifierItem") {
    if (m == "Activate" || m == "SecondaryActivate") toggleFromTray();
    g_dbus_method_invocation_return_value(call, nullptr);
    return;
  }
  if (m == "GetLayout") {
    gint32 parent = 0, depth = 0;
    g_variant_get(params, "(ii^a&s)", &parent, &depth, nullptr);
    g_dbus_method_invocation_return_value(call, g_variant_new("(u@(ia{sv}av))", 1u, menuNode(knownItem(parent) ? parent : kTrayRoot)));
    return;
  }
  if (m == "GetGroupProperties") {
    GVariantIter* ids = nullptr;
    g_variant_get(params, "(ai^a&s)", &ids, nullptr);
    GVariantBuilder out;
    g_variant_builder_init(&out, G_VARIANT_TYPE("a(ia{sv})"));
    gint32 id = 0;
    while (g_variant_iter_next(ids, "i", &id)) {
      if (knownItem(id)) g_variant_builder_add(&out, "(i@a{sv})", id, menuProps(id));
    }
    g_variant_iter_free(ids);
    g_dbus_method_invocation_return_value(call, g_variant_new("(@a(ia{sv}))", g_variant_builder_end(&out)));
    return;
  }
  if (m == "GetProperty") {
    gint32 id = 0;
    const gchar* name = nullptr;
    g_variant_get(params, "(i&s)", &id, &name);
    GVariant* props = menuProps(id);
    GVariant* v = g_variant_lookup_value(props, name, nullptr);
    g_variant_unref(g_variant_ref_sink(props));
    if (!v) return g_dbus_method_invocation_return_dbus_error(call, "com.canonical.dbusmenu.Error", "no such property");
    g_dbus_method_invocation_return_value(call, g_variant_new("(v)", v));
    g_variant_unref(v);
    return;
  }
  if (m == "Event") {
    gint32 id = 0;
    const gchar* event = nullptr;
    g_variant_get(params, "(i&svu)", &id, &event, nullptr, nullptr);
    onMenuEvent(id, event);
    g_dbus_method_invocation_return_value(call, nullptr);
    return;
  }
  if (m == "EventGroup") {
    GVariantIter* events = nullptr;
    g_variant_get(params, "(a(isvu))", &events);
    gint32 id = 0;
    const gchar* event = nullptr;
    GVariant* data = nullptr;
    guint32 time = 0;
    while (g_variant_iter_next(events, "(i&svu)", &id, &event, &data, &time)) {
      onMenuEvent(id, event);
      g_variant_unref(data);
    }
    g_variant_iter_free(events);
    g_dbus_method_invocation_return_value(call, g_variant_new("(@ai)", g_variant_new_array(G_VARIANT_TYPE_INT32, nullptr, 0)));
    return;
  }
  if (m == "AboutToShow") return g_dbus_method_invocation_return_value(call, g_variant_new("(b)", FALSE));
  if (m == "AboutToShowGroup") {
    GVariant* none = g_variant_new_array(G_VARIANT_TYPE_INT32, nullptr, 0);
    GVariant* none2 = g_variant_new_array(G_VARIANT_TYPE_INT32, nullptr, 0);
    return g_dbus_method_invocation_return_value(call, g_variant_new("(@ai@ai)", none, none2));
  }
  g_dbus_method_invocation_return_dbus_error(call, "org.freedesktop.DBus.Error.UnknownMethod", method);
}

const GDBusInterfaceVTable kTrayVtable = {trayCall, trayProperty, nullptr, {nullptr}};

void onTrayRegistered(GObject* source, GAsyncResult* res, gpointer) {
  GError* error = nullptr;
  GVariant* r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), res, &error);
  gTrayShown = r != nullptr;
  if (r) g_variant_unref(r);
  logLine(gTrayShown ? "tray icon shown" : std::string("the tray did not take Studio's icon: ") + (error ? error->message : "unknown"));
  g_clear_error(&error);
}

/** The tray is up (at start, or after the desktop restarted it): hand it the icon. */
void onWatcherAppeared(GDBusConnection* bus, const gchar*, const gchar* owner, gpointer) {
  (void)owner;
  g_dbus_connection_call(bus, "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher",
                         "RegisterStatusNotifierItem", g_variant_new("(s)", gTrayBusName.c_str()), nullptr, G_DBUS_CALL_FLAGS_NONE, 5000,
                         nullptr, onTrayRegistered, nullptr);
}

/** No tray: nothing holds Studio, so a hidden window comes back rather than being lost. */
void onWatcherVanished(GDBusConnection*, const gchar*, gpointer) {
  if (gTrayShown) logLine("the tray went away");
  gTrayShown = false;
  if (gMain && !gtk_widget_get_visible(GTK_WIDGET(gMain))) present();
}

/** Serve the icon and its menu, and watch for the tray. */
void startTray() {
  GDBusConnection* bus = g_application_get_dbus_connection(gApp);
  if (!bus) return;
  GError* error = nullptr;
  gTrayInfo = g_dbus_node_info_new_for_xml(kTrayXml, &error);
  if (!gTrayInfo) {
    logLine(std::string("tray: ") + (error ? error->message : "bad interface"));
    g_clear_error(&error);
    return;
  }
  bool ok = g_dbus_connection_register_object(bus, kTrayPath, gTrayInfo->interfaces[0], &kTrayVtable, nullptr, nullptr, &error) &&
            g_dbus_connection_register_object(bus, kTrayMenuPath, gTrayInfo->interfaces[1], &kTrayVtable, nullptr, nullptr, &error);
  if (!ok) {
    logLine(std::string("tray: ") + (error ? error->message : "could not serve the icon"));
    g_clear_error(&error);
    return;
  }
  // The item is named by the connection's unique name, which the watcher accepts in place of a well-known one.
  gTrayBusName = g_dbus_connection_get_unique_name(bus);
  gTrayWatch = g_bus_watch_name_on_connection(bus, "org.kde.StatusNotifierWatcher", G_BUS_NAME_WATCHER_FLAGS_NONE, onWatcherAppeared,
                                              onWatcherVanished, nullptr, nullptr);
}

// ---------------------------------------------------------------- the window

/** The window's size and whether it is maximized, in the Windows build's format: x y width height maximized. */
void saveState() {
  if (!gMain || gOpt.state.empty()) return;
  int w = 0, h = 0;
  gtk_window_get_default_size(gMain, &w, &h);
  if (w < 200 || h < 200) return;
  makeDirs(dirOf(gOpt.state));
  writeFile(gOpt.state, "0 0 " + std::to_string(w) + " " + std::to_string(h) + " " + (gtk_window_is_maximized(gMain) ? "1" : "0") + "\n");
}

/** Where it was last time; the desktop places it, since Wayland gives a program no say in where its window goes. */
void placeWindow() {
  std::string text;
  long x, y, w, h;
  int max = 0;
  if (readFile(gOpt.state, text) && std::sscanf(text.c_str(), "%ld %ld %ld %ld %d", &x, &y, &w, &h, &max) >= 4 && w >= 200 && h >= 200) {
    gtk_window_set_default_size(gMain, static_cast<int>(w), static_cast<int>(h));
    if (max) gtk_window_maximize(gMain);
    return;
  }
  gtk_window_set_default_size(gMain, 640, 900);
}

void present() {
  if (gMain) gtk_window_present(gMain);
}

/**
 * Close quits, unless the user chose to keep Studio running: then it hides, off
 * the desktop and the taskbar, and the tray icon brings it back. With no tray to
 * hold it, it minimizes instead, so it is never out of reach.
 */
gboolean onCloseRequest(GtkWindow* w, gpointer) {
  if (gCloseToTray && !gQuitting) {
    if (gTrayShown) {
      saveState();
      gtk_widget_set_visible(GTK_WIDGET(w), FALSE);
    } else {
      gtk_window_minimize(w);
    }
    return TRUE;
  }
  saveState();
  logLine("closed");
  return FALSE;
}

void startWindow() {
  installDesktopEntry();
  writePidFile();
  startTray();
  // Studio's own colors: dark, as the Windows build's title bar is.
  // GTK 4.20 names it gtk-interface-color-scheme; older GTK only has the dark-theme preference.
  GtkSettings* gs = gtk_settings_get_default();
  GParamSpec* scheme = g_object_class_find_property(G_OBJECT_GET_CLASS(gs), "gtk-interface-color-scheme");
  if (scheme && G_IS_PARAM_SPEC_ENUM(scheme)) {
    GEnumValue* dark = g_enum_get_value_by_nick(G_PARAM_SPEC_ENUM(scheme)->enum_class, "dark");
    if (dark) g_object_set(gs, "gtk-interface-color-scheme", dark->value, nullptr);
  } else {
    g_object_set(gs, "gtk-application-prefer-dark-theme", TRUE, nullptr);
  }

  gMain = GTK_WINDOW(gtk_application_window_new(GTK_APPLICATION(gApp)));
  std::string title = gOpt.title.empty() ? kDisplayName : std::string(kDisplayName) + " - " + gOpt.title;
  gtk_window_set_title(gMain, title.c_str());
  identify(gMain);
  dressWindow();
  placeWindow();
  g_signal_connect(gMain, "close-request", G_CALLBACK(onCloseRequest), nullptr);

  gWeb = createWebView();
  gtk_window_set_child(gMain, chromeContent(GTK_WIDGET(gWeb)));
  setEditor(gOpt.editorPid);
  loadLocation();
  goToLocation(gOpt.location);
  if (!gOpt.mode.empty() && gOpt.mode != "window") logLine("mode " + gOpt.mode + " is not available on Linux; opening as a window");
  gtk_window_present(gMain);
  gtk_widget_grab_focus(GTK_WIDGET(gWeb));
  pollDaemon();
  g_timeout_add(1000, onDaemonTimer, nullptr);
}

// ---------------------------------------------------------------- one window per project

/**
 * Every launch for this project's key arrives here, the first included: the
 * first starts the window, a later one hands over its editor and where the
 * panel opens, and brings the window forward.
 */
int onCommandLine(GApplication* app, GApplicationCommandLine* cmd, gpointer) {
  int argc = 0;
  gchar** argv = g_application_command_line_get_arguments(cmd, &argc);
  Options o;
  bool ok = parseArgs(argc, argv, o) && o.key == gOpt.key;
  std::string line = argLine(argc, argv);
  g_strfreev(argv);
  if (!ok) return 2;
  if (!gStarted) {
    gStarted = true;
    // A quit with no window to hand it to has nothing to close; it must not open one.
    if (o.quit) return 0;
    if (!gOpt.instanceTest.empty()) {
      // Tests: the single-instance protocol alone, no window and no browser.
      appendFile(gOpt.instanceTest, "ready " + std::to_string(getpid()) + "\n");
      g_application_hold(app);
      return 0;
    }
    startWindow();
    return 0;
  }
  if (!gOpt.instanceTest.empty()) {
    appendFile(gOpt.instanceTest, "args " + line + "\n");
    if (o.quit) {
      g_application_release(app);
      g_application_quit(app);
    }
    return 0;
  }
  // A launch from a different build replaces this one, so an update takes effect on the next open.
  if (!o.senderVersion.empty() && o.senderVersion != STUDIO_WINDOW_VERSION) {
    logLine("a launch from build " + o.senderVersion + " replaces this one");
    saveState();
    g_application_quit(app);
    return kReplaceMe;
  }
  if (o.quit) {
    quitStudio();
    return 0;
  }
  if (o.editorPid) setEditor(o.editorPid);
  if (!o.node.empty()) gOpt.node = o.node;
  if (!o.ueMcp.empty()) gOpt.ueMcp = o.ueMcp;
  goToLocation(o.location);
  present();
  return 0;
}

/** The application id: a D-Bus name per project key, so each project has its own window. */
std::string appId(const std::string& key) {
  std::string id = "com.ue_mcp.StudioWindow.k";
  for (char c : key) id += c == '-' ? '_' : c;
  return id;
}

}  // namespace

int main(int argc, char** argv) {
  if (!parseArgs(argc, argv, gOpt)) return 2;
  // WM_CLASS on X11, and the name the desktop shows before the window is matched.
  g_set_prgname(kAppId);
  g_set_application_name(kDisplayName);
  if (gOpt.probe) {
    // Reached at all: the libraries loaded. A display to open is the rest of it.
    return gtk_init_check() ? 0 : 4;
  }
  // The sender's build travels with the hand-off, as on Windows.
  std::vector<std::string> args(argv, argv + argc);
  args.push_back("--sender-version");
  args.push_back(STUDIO_WINDOW_VERSION);
  std::vector<char*> raw;
  for (std::string& a : args) raw.push_back(a.data());
  raw.push_back(nullptr);

  // A replaced window is on its way out; ask again until this launch is the one that runs.
  for (int attempt = 0; attempt < 100; ++attempt) {
    // Tests run the hand-off alone, with no window, so they need no display either.
    gApp = gOpt.instanceTest.empty() ? G_APPLICATION(gtk_application_new(appId(gOpt.key).c_str(), G_APPLICATION_HANDLES_COMMAND_LINE))
                                     : g_application_new(appId(gOpt.key).c_str(), G_APPLICATION_HANDLES_COMMAND_LINE);
    g_signal_connect(gApp, "command-line", G_CALLBACK(onCommandLine), nullptr);
    int status = g_application_run(gApp, static_cast<int>(raw.size() - 1), raw.data());
    bool wasPrimary = gStarted;
    g_object_unref(gApp);
    gApp = nullptr;
    if (wasPrimary && gOpt.instanceTest.empty()) removePidFile();
    if (wasPrimary || status != kReplaceMe) return status;
    g_usleep(100 * 1000);
  }
  return 1;
}
