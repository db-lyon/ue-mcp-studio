// Unit tests for dock.h (the shared-memory protocol and where the window goes),
// location.h, connection.h, update.h, toast.h, input.h and channel.h.
// Built beside studio-window.exe; apps/window/test/dock.test.ts runs it.
// Prints "ok <name>" or "FAIL <name>: <what>" per case and exits non-zero on a failure.

#include <cstdio>
#include <map>
#include <vector>

#include "../src/channel.h"
#include "../src/connection.h"
#include "../src/dock.h"
#include "../src/input.h"
#include "../src/job.h"
#include "../src/location.h"
#include "../src/toast.h"
#include "../src/update.h"
#include "../src/watch.h"

namespace {

int failures = 0;
const char* current = "";
bool currentFailed = false;

#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      std::printf("FAIL %s: %s (line %d)\n", current, #cond, __LINE__); \
      currentFailed = true;                                           \
    }                                                                 \
  } while (0)

template <class F>
void test(const char* name, F body) {
  current = name;
  currentFailed = false;
  body();
  if (currentFailed) ++failures;
  else std::printf("ok %s\n", name);
}

struct Block {
  alignas(8) uint8_t bytes[dock::kSize] = {};
  volatile uint8_t* m() { return bytes; }
};

dock::Report sample() {
  dock::Report r;
  r.pid = 4242;
  r.host = 0x1234abcdULL;
  r.x = 10;
  r.y = 40;
  r.w = 800;
  r.h = 600;
  r.flags = dock::kOpen | dock::kVisible;
  r.frame = 7;
  return r;
}

dock::Host host(long x = 100, long y = 200) {
  dock::Host h;
  h.exists = true;
  h.visible = true;
  h.originX = x;
  h.originY = y;
  return h;
}

/** A z-order, top first; prev() walks up it. */
struct ZOrder {
  std::vector<uintptr_t> order;
  std::map<uintptr_t, bool> topmost;
  uintptr_t prev(uintptr_t w) const {
    for (size_t i = 0; i < order.size(); ++i) if (order[i] == w) return i ? order[i - 1] : 0;
    return 0;
  }
  uintptr_t slot(uintptr_t host, uintptr_t self) const {
    return dock::slotAbove(host, self, [&](uintptr_t w) { return prev(w); }, [&](uintptr_t w) { return topmost.count(w) ? topmost.at(w) : false; });
  }
  bool inSlot(uintptr_t s, uintptr_t self) const {
    return dock::inSlot(s, self, [&](uintptr_t w) { return prev(w); }, [&](uintptr_t w) { return topmost.count(w) ? topmost.at(w) : false; });
  }
};

}  // namespace

int main() {
  test("an empty block has no report", [] {
    Block b;
    dock::Report r;
    CHECK(!dock::readReport(b.m(), dock::kSize, r));
  });

  test("a stamped block the plugin never wrote has no report", [] {
    Block b;
    dock::init(b.m());
    dock::Report r;
    CHECK(!dock::readReport(b.m(), dock::kSize, r));
  });

  test("a report round-trips through the layout", [] {
    Block b;
    dock::init(b.m());
    dock::writeReport(b.m(), sample());
    dock::Report r;
    CHECK(dock::readReport(b.m(), dock::kSize, r));
    CHECK(r.pid == 4242 && r.host == 0x1234abcdULL && r.x == 10 && r.y == 40 && r.w == 800 && r.h == 600);
    CHECK(r.flags == (dock::kOpen | dock::kVisible) && r.frame == 7);
    CHECK(dock::load32(b.m(), dock::kOffPluginSeq) == 2);
  });

  test("the fields sit at the documented offsets", [] {
    Block b;
    dock::init(b.m());
    dock::Report s = sample();
    s.x = -5;
    dock::writeReport(b.m(), s);
    CHECK(dock::load32(b.m(), 0) == 0x4B434453);
    CHECK(dock::load32(b.m(), 4) == 1);
    CHECK(dock::load32(b.m(), 12) == 4242);
    CHECK(dock::load64(b.m(), 16) == 0x1234abcdULL);
    CHECK((int32_t)dock::load32(b.m(), 24) == -5);
    CHECK(dock::load32(b.m(), 36) == 600);
    CHECK(dock::load32(b.m(), 40) == 3);
  });

  test("a write in progress is not read", [] {
    Block b;
    dock::init(b.m());
    dock::writeReport(b.m(), sample());
    dock::store32(b.m(), dock::kOffPluginSeq, 3);
    dock::Report r;
    CHECK(!dock::readReport(b.m(), dock::kSize, r));
  });

  test("another layout or a short block is refused", [] {
    Block b;
    dock::init(b.m());
    dock::writeReport(b.m(), sample());
    dock::Report r;
    CHECK(!dock::readReport(b.m(), 64, r));
    dock::store32(b.m(), dock::kOffLayout, 2);
    CHECK(!dock::readReport(b.m(), dock::kSize, r));
    dock::store32(b.m(), dock::kOffLayout, 1);
    dock::store32(b.m(), dock::kOffMagic, 0xdeadbeef);
    CHECK(!dock::readReport(b.m(), dock::kSize, r));
  });

  test("init leaves a stamped block and its report alone", [] {
    Block b;
    dock::init(b.m());
    dock::writeReport(b.m(), sample());
    dock::init(b.m());
    dock::Report r;
    CHECK(dock::readReport(b.m(), dock::kSize, r) && r.w == 800);
  });

  test("the studio section round-trips apart from the report", [] {
    Block b;
    dock::init(b.m());
    dock::writeReport(b.m(), sample());
    dock::StudioSection s;
    s.pid = 99;
    s.mode = dock::Mode::Docked;
    s.requestSeq = 5;
    s.request = dock::Request::OpenTab;
    dock::writeStudio(b.m(), s);
    dock::StudioSection got;
    CHECK(dock::readStudio(b.m(), dock::kSize, got));
    CHECK(got.pid == 99 && got.mode == dock::Mode::Docked && got.requestSeq == 5 && got.request == dock::Request::OpenTab);
    dock::Report r;
    CHECK(dock::readReport(b.m(), dock::kSize, r) && r.pid == 4242);
  });

  test("the saved mode parses", [] {
    CHECK(dock::parseMode("docked") == dock::Mode::Docked);
    CHECK(dock::parseMode(" window\r\n") == dock::Mode::Window);
    CHECK(dock::parseMode("") == dock::Mode::None);
    CHECK(dock::parseMode("dock") == dock::Mode::None);
  });

  test("window mode is a window whatever the dock says", [] {
    dock::Placement p = dock::place(dock::Mode::Window, true, sample(), true, host());
    CHECK(p.show == dock::Show::Window);
  });

  test("docked over the tab, at the host's client origin plus the report", [] {
    dock::Placement p = dock::place(dock::Mode::Docked, true, sample(), true, host(100, 200));
    CHECK(p.show == dock::Show::Docked);
    CHECK(p.x == 110 && p.y == 240 && p.w == 800 && p.h == 600);
  });

  test("the host moving moves the window without a new report", [] {
    dock::Placement p = dock::place(dock::Mode::Docked, true, sample(), true, host(-1900, 50));
    CHECK(p.x == -1890 && p.y == 90);
  });

  test("docked with no live dock is a window: an older plugin, or the editor gone", [] {
    CHECK(dock::place(dock::Mode::Docked, false, dock::Report(), false, dock::Host()).show == dock::Show::Window);
    CHECK(dock::place(dock::Mode::Docked, true, sample(), false, host()).show == dock::Show::Window);
    CHECK(!dock::canDock(true, false) && !dock::canDock(false, true) && dock::canDock(true, true));
  });

  test("hidden while the tab is closed, behind another tab, or empty", [] {
    dock::Report r = sample();
    r.flags = 0;
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host()).show == dock::Show::Hidden);
    r.flags = dock::kOpen;
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host()).show == dock::Show::Hidden);
    r = sample();
    r.w = 0;
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host()).show == dock::Show::Hidden);
  });

  test("hidden while the host is minimized; a window while it is hidden or gone, as an editor shuts down", [] {
    dock::Host h = host();
    h.iconic = true;
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, h).show == dock::Show::Hidden);
    h = host();
    h.visible = false;
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, h).show == dock::Show::Window);
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, dock::Host()).show == dock::Show::Window);
    // The plugin's last report on exit: no tab, no host.
    CHECK(dock::place(dock::Mode::Docked, true, dock::Report(), true, dock::Host()).show == dock::Show::Window);
  });

  test("hidden while the host is on another virtual desktop", [] {
    dock::Host h = host();
    h.elsewhere = true;
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, h).show == dock::Show::Hidden);
    CHECK(dock::place(dock::Mode::Window, true, sample(), true, h).show == dock::Show::Window);
  });

  test("an editor coming back stays a window until it shows the tab, then follows it", [] {
    dock::Report r = sample();
    r.flags = dock::kOpen;
    CHECK(dock::place(dock::Mode::Docked, true, r, true, dock::Host(), false).show == dock::Show::Window);
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host(), false).show == dock::Show::Window);
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, host(), false).show == dock::Show::Docked);
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host(), true).show == dock::Show::Hidden);
  });

  test("an overlay does not hide the window: the editor's popups stack above it", [] {
    dock::Report r = sample();
    r.flags |= dock::kOverlay;
    CHECK(dock::place(dock::Mode::Docked, true, r, true, host()).show == dock::Show::Docked);
  });

  test("the slot is directly above the host, under the editor's menu", [] {
    ZOrder z;
    z.order = {50, 30, 10};  // the editor's menu, the host, Studio below it
    uintptr_t s = z.slot(30, 10);
    CHECK(s == 50);
    CHECK(!z.inSlot(s, 10));
    z.order = {50, 10, 30};
    CHECK(z.slot(30, 10) == 50 && z.inSlot(50, 10));
  });

  test("the slot is the top when the host is on top", [] {
    ZOrder z;
    z.order = {30, 10};
    CHECK(z.slot(30, 10) == 0 && !z.inSlot(0, 10));
    z.order = {10, 30};
    CHECK(z.slot(30, 10) == 0 && z.inSlot(0, 10));
  });

  test("a topmost window above the host does not pull Studio into the topmost band", [] {
    ZOrder z;
    z.order = {70, 30, 10};
    z.topmost[70] = true;
    CHECK(z.slot(30, 10) == 0);
    z.order = {70, 10, 30};
    CHECK(z.inSlot(0, 10));
  });

  test("an unrelated window over the editor stays over Studio", [] {
    ZOrder z;
    z.order = {80, 30, 10};  // another app in front of the editor
    CHECK(z.slot(30, 10) == 80);
    z.order = {80, 10, 30};
    CHECK(z.inSlot(80, 10));
  });

  test("topmost while the editor or Studio is in front, not under an editor popup or behind another app", [] {
    CHECK(dock::wantTopmost(true, dock::kOpen | dock::kVisible));
    CHECK(!dock::wantTopmost(true, dock::kOpen | dock::kVisible | dock::kOverlay));
    CHECK(!dock::wantTopmost(false, dock::kOpen | dock::kVisible));
  });

  test("the panel's location carries to a new address", [] {
    CHECK(location::fragmentOf(L"http://127.0.0.1:5/ui/?token=ab#/chat/s-1") == L"#/chat/s-1");
    CHECK(location::fragmentOf(L"http://127.0.0.1:5/ui/") == L"");
    CHECK(location::withFragment(L"http://127.0.0.1:9/ui/?token=cd", L"#/chat/s-1") == L"http://127.0.0.1:9/ui/?token=cd#/chat/s-1");
    CHECK(location::withFragment(L"http://127.0.0.1:9/ui/#/flows", L"#/settings/project") == L"http://127.0.0.1:9/ui/#/settings/project");
    CHECK(location::withFragment(L"http://127.0.0.1:9/ui/", L"") == L"http://127.0.0.1:9/ui/");
  });

  test("a fragment that is not the panel's is not carried", [] {
    CHECK(location::safeFragment(L"#/chat/614e0ba1-1942"));
    CHECK(!location::safeFragment(L"#/chat/<script>"));
    CHECK(!location::safeFragment(L"/chat/x"));
    CHECK(!location::safeFragment(L"#/chat/a b"));
    CHECK(location::withFragment(L"http://h/ui/", L"#\"evil") == L"http://h/ui/");
  });

  // connection.h: the local page's states while no page from ue-mcp is loaded.
  auto none = [] { return conn::Facts(); };
  auto live = [](const char* token) {
    conn::Facts f;
    f.live = true;
    f.token = token;
    return f;
  };

  test("no daemon waits for one the editor may be starting, then starts it", [&] {
    conn::State s = conn::begin(none(), 1000);
    CHECK(s.phase == conn::Phase::Waiting && s.why == "ue-mcp is not running");
    CHECK(conn::headline(s, 1000) == "Connecting to ue-mcp");
    CHECK(conn::tick(s, none(), 1000 + conn::kWaitMs - 1) == conn::Effect::None);
    CHECK(conn::tick(s, none(), 1000 + conn::kWaitMs) == conn::Effect::Start);
    CHECK(s.phase == conn::Phase::Starting && s.attempt == 1 && s.launched);
    CHECK(conn::headline(s, 1000 + conn::kWaitMs) == "Starting ue-mcp (attempt 1 of 3)");
  });

  test("a crashed daemon is said so and started again at once", [&] {
    conn::Facts f;
    f.stale = true;
    conn::State s = conn::begin(f, 0);
    CHECK(s.why == "ue-mcp stopped unexpectedly");
    CHECK(conn::tick(s, f, conn::kCrashWaitMs) == conn::Effect::Start);
  });

  test("an update's restart waits for the successor and starts nothing", [&] {
    conn::Facts f;
    f.updating = true;
    conn::State s = conn::begin(f, 0);
    CHECK(s.phase == conn::Phase::Restarting);
    CHECK(conn::headline(s, 0) == "ue-mcp is restarting for an update");
    CHECK(conn::tick(s, f, conn::kUpdateWaitMs - 1) == conn::Effect::None);
    CHECK(conn::tick(s, live("ab"), conn::kUpdateWaitMs - 1) == conn::Effect::Load);
    CHECK(s.phase == conn::Phase::Loading);
  });

  test("an update that starts while waiting turns the wait into a restart", [&] {
    conn::State s = conn::begin(none(), 0);
    conn::Facts f;
    f.updating = true;
    CHECK(conn::tick(s, f, conn::kWaitMs) == conn::Effect::None);
    CHECK(s.phase == conn::Phase::Restarting && s.deadline == conn::kWaitMs + conn::kUpdateWaitMs);
  });

  test("starting retries with backoff, then needs you", [&] {
    conn::State s = conn::begin(none(), 0);
    conn::Ms t = conn::kWaitMs;
    CHECK(conn::tick(s, none(), t) == conn::Effect::Start);
    conn::started(s, true, false, "", t);
    t += conn::kAttemptMs;
    CHECK(conn::tick(s, none(), t) == conn::Effect::None);
    CHECK(s.attempt == 2 && !s.launched && s.failure.find("did not answer within 45 seconds") != std::string::npos);
    CHECK(conn::headline(s, t) == "Starting ue-mcp again in 5s (attempt 2 of 3)");
    CHECK(conn::tick(s, none(), t + conn::kBackoffMs[0] - 1) == conn::Effect::None);
    t += conn::kBackoffMs[0];
    CHECK(conn::tick(s, none(), t) == conn::Effect::Start);
    conn::started(s, false, false, "npx could not be started", t);
    CHECK(s.attempt == 3 && !s.launched && s.failure == "The start command did not run: npx could not be started.");
    t += conn::kBackoffMs[1];
    CHECK(conn::tick(s, none(), t) == conn::Effect::Start);
    t += conn::kAttemptMs;
    CHECK(conn::tick(s, none(), t) == conn::Effect::None);
    CHECK(s.phase == conn::Phase::NeedsYou);
    CHECK(s.failure.rfind("ue-mcp did not start after 3 attempts.", 0) == 0);
    CHECK(conn::headline(s, t) == "ue-mcp is not running");
    CHECK(conn::tick(s, none(), t + 600000) == conn::Effect::None);
    CHECK(conn::retry(s, none(), t + 1) == conn::Effect::Start);
    CHECK(s.phase == conn::Phase::Starting && s.attempt == 1 && s.launched);
  });

  test("missing Node.js needs you at once", [&] {
    conn::State s = conn::begin(none(), 0);
    conn::tick(s, none(), conn::kWaitMs);
    conn::started(s, false, true, "Node.js was not found", conn::kWaitMs);
    CHECK(s.phase == conn::Phase::NeedsYou && s.noNode);
  });

  test("a live daemon loads, and a page that does not load is retried, then needs you", [&] {
    conn::State s = conn::begin(none(), 0);
    CHECK(conn::tick(s, live("ab"), 10) == conn::Effect::Load);
    conn::loadFailed(s, "ue-mcp answered HTTP 503, it has no Studio page installed", 20);
    CHECK(s.phase == conn::Phase::Loading && s.loads == 1);
    CHECK(conn::tick(s, live("ab"), 20 + conn::kLoadBackoffMs[0] - 1) == conn::Effect::None);
    CHECK(conn::tick(s, live("ab"), 20 + conn::kLoadBackoffMs[0]) == conn::Effect::Load);
    conn::loadFailed(s, "x", 3000);
    CHECK(conn::tick(s, live("ab"), 3000 + conn::kLoadBackoffMs[1]) == conn::Effect::Load);
    // The third load never answers.
    CHECK(conn::tick(s, live("ab"), 8000 + conn::kLoadWaitMs) == conn::Effect::None);
    CHECK(s.phase == conn::Phase::NeedsYou && s.loads == 3);
    CHECK(conn::headline(s, 0) == "Studio did not load");
    CHECK(conn::tick(s, live("ab"), 60000) == conn::Effect::None);
    // A new daemon gets fresh loads.
    CHECK(conn::tick(s, live("cd"), 60001) == conn::Effect::Load);
    CHECK(s.loads == 0);
  });

  test("a daemon that goes away while its page loads is waited for again", [&] {
    conn::State s = conn::begin(none(), 0);
    conn::tick(s, live("ab"), 10);
    CHECK(conn::tick(s, none(), 20) == conn::Effect::None);
    CHECK(s.phase == conn::Phase::Waiting);
  });

  test("elapsed time reads as seconds, then minutes", [] {
    CHECK(conn::elapsed(8400) == "8s");
    CHECK(conn::elapsed(65000) == "1m 05s");
  });

  test("the refused screen's update takes only a release version", [] {
    CHECK(ueupdate::validVersion("1.4.11"));
    CHECK(ueupdate::validVersion("1.4.11-beta.8"));
    CHECK(ueupdate::validVersion("10.0.0-rc.1"));
    CHECK(!ueupdate::validVersion(""));
    CHECK(!ueupdate::validVersion("latest"));
    CHECK(!ueupdate::validVersion("1.4"));
    CHECK(!ueupdate::validVersion("1.4.11-"));
    CHECK(!ueupdate::validVersion("1.4.11 && calc"));
    CHECK(!ueupdate::validVersion("1.4.11-beta\"&calc"));
    CHECK(!ueupdate::validVersion("1.4.11-beta|x"));
  });

  test("the refused screen's update runs the target release's own apply, its exit to a file", [] {
    std::wstring c = ueupdate::command(L"C:\\node\\npx.cmd", L"1.4.11-beta.8", L"D:\\My Game\\Game.uproject", L"D:\\out.log", L"D:\\out.exit");
    CHECK(c == L"\"C:\\node\\npx.cmd\" -y --min-release-age=0 ue-mcp@1.4.11-beta.8 update \"D:\\My Game\\Game.uproject\" --apply-only"
               L" > \"D:\\out.log\" 2>&1 && (echo 0)> \"D:\\out.exit\" || (echo 1)> \"D:\\out.exit\"");
  });

  test("the refused screen's update result: nothing while it runs, then ok or what the CLI said", [] {
    CHECK(ueupdate::result(false, "", "", "1.4.11").empty());
    CHECK(ueupdate::result(true, "0 \r\n", "Bridge 1.4.11 installed\n", "1.4.11") == "{\"ok\":true}");
    CHECK(ueupdate::result(true, "1\r\n", "\x1b[31mx\x1b[0m one\nno prebuilt bridge for UE 5.7\r\n", "1.4.11") ==
          "{\"ok\":false,\"error\":\"ue-mcp 1.4.11 update failed:\\nx one\\nno prebuilt bridge for UE 5.7\"}");
    CHECK(ueupdate::result(true, "1", "", "1.4.11") == "{\"ok\":false,\"error\":\"ue-mcp 1.4.11 update failed\"}");
  });

  test("a failed update says npm's own error, without its log pointer", [] {
    std::string out = "a\nb\nnpm error code ETARGET\nnpm error No matching version found for ue-mcp@9.9.9.\n"
                      "npm error A complete log of this run can be found in: C:\\Users\\u\\AppData\\Local\\npm-cache\\_logs\\x.log\n";
    CHECK(ueupdate::failureText(out) == "code ETARGET\nNo matching version found for ue-mcp@9.9.9.");
    CHECK(ueupdate::failureText("1\n2\n3\n4\n5\n6\n7\n") == "3\n4\n5\n6\n7");
  });

  test("a job keeps its output and exit code in files, stderr apart when asked", [] {
    CHECK(job::wrap(L"x", L"o", L"e") == L"x > \"o\" 2>&1 && (echo 0)> \"e\" || (echo 1)> \"e\"");
    CHECK(job::wrap(L"x", L"o", L"e", L"r") == L"x > \"o\" 2> \"r\" && (echo 0)> \"e\" || (echo 1)> \"e\"");
    CHECK(job::npx(L"C:\\n\\npx.cmd", job::spec(L"beta", L""), L"projects --json") ==
          L"\"C:\\n\\npx.cmd\" -y --min-release-age=0 --package=ue-mcp@beta ue-mcp projects --json");
    CHECK(job::spec(L"beta", L"1.4.13") == L"ue-mcp@1.4.13");
    CHECK((job::lines("\x1b[32mok\x1b[0m a\r\n\n  \nb") == std::vector<std::string>{"ok a", "b"}));
  });

  test("the app reaches a daemon by project key, for the calls it needs and no others", [] {
    CHECK(job::validKey("0e9f3c9aae1e89bb"));
    CHECK(!job::validKey("0E9F3C9AAE1E89BB"));
    CHECK(!job::validKey("..\\..\\x.json"));
    CHECK(!job::validKey("0e9f3c9aae1e89b"));
    CHECK(job::allowed("GET", "/v1/health"));
    CHECK(job::allowed("GET", "/v1/update?channel=beta"));
    CHECK(job::allowed("GET", "/v1/ext/studio/updates"));
    CHECK(job::allowed("POST", "/v1/ext/studio/window"));
    CHECK(job::allowed("POST", "/v1/editor/start"));
    CHECK(!job::allowed("POST", "/v1/shutdown"));
    CHECK(!job::allowed("POST", "/v1/editor/stop"));
    CHECK(!job::allowed("GET", "/v1/sessions"));
    CHECK(!job::allowed("POST", "/v1/ext/studio/updates/plugin"));
    CHECK(!job::allowed("GET", "/v1/update?channel=x&y"));
    CHECK(!job::allowed("PUT", "/v1/ext/studio/window"));
  });

  test("a toast's text is escaped into its XML", [] {
    CHECK(toast::xml(L"Done: <a & b>", L"it's \"fine\"") ==
          L"<toast launch=\"studio\"><visual><binding template=\"ToastGeneric\"><text>Done: &lt;a &amp; b&gt;</text><text>it&apos;s &quot;fine&quot;</text></binding></visual></toast>");
    CHECK(toast::escape(std::wstring(L"a") + wchar_t(1) + L"b\nc") == L"a b\nc");
  });

  test("a toast's group is the project, cut to 64 characters", [] {
    CHECK(toast::group(L"") == L"studio");
    CHECK(toast::group(L"Vale") == L"Vale");
    CHECK(toast::group(std::wstring(80, L'x')).size() == 64);
  });

  test("the notify answer: ok, how, Windows' setting and the HRESULT", [] {
    CHECK(toast::answer(true, "toast", "enabled") == "{\"ok\":true,\"via\":\"toast\",\"setting\":\"enabled\"}");
    CHECK(toast::answer(false, "toast", toast::settingName(1)) == "{\"ok\":false,\"via\":\"toast\",\"setting\":\"disabled for Studio\"}");
    CHECK(toast::answer(false, "toast", {}, static_cast<int32_t>(0x80070490), "Element not found.") ==
          "{\"ok\":false,\"via\":\"toast\",\"hr\":\"0x80070490\",\"error\":\"Element not found.\"}");
    CHECK(std::string(toast::settingName(9)) == "unknown");
  });

  test("a second notify for the same notice shows nothing; an older page's notify without an id always shows", [] {
    toast::Shown shown;
    CHECK(shown.first("n1"));
    CHECK(!shown.first("n1"));
    CHECK(shown.first("n2"));
    CHECK(shown.first(""));
    CHECK(shown.first(""));
    for (int i = 0; i < 200; ++i) shown.first("x" + std::to_string(i));
    CHECK(shown.first("n1"));
    CHECK(toast::answer(true, "toast", {}, 0, {}, true) == "{\"ok\":true,\"via\":\"toast\",\"duplicate\":true}");
  });

  test("injected keys and mouse events are not the owner's input", [] {
    CHECK(input::realKey(0));
    CHECK(input::realKey(0x01));  // LLKHF_EXTENDED: a real arrow key
    CHECK(!input::realKey(0x10));
    CHECK(!input::realKey(0x12));
    CHECK(input::realMouse(0));
    CHECK(!input::realMouse(0x01));
    CHECK(!input::realMouse(0x03));
  });

  test("away is timed from real input; the editor's zero mouse move every 50 seconds does not reset it", [] {
    const uint64_t now = 10'000'000;
    // Real input ten minutes ago, Windows' last input (an injected move) two seconds ago.
    CHECK(input::ageMs(now, true, now - 600'000, now - 2'000, false) == 600'000);
    // Without the hooks only Windows' last input is known.
    CHECK(input::ageMs(now, false, now - 600'000, now - 2'000, false) == 2'000);
    // An elevated window in front, which the hooks are not told about: Windows' last input counts.
    CHECK(input::ageMs(now, true, now - 600'000, now - 2'000, true) == 2'000);
    CHECK(input::ageMs(now, true, now - 1'000, now - 2'000, true) == 1'000);
    // A tick from just after now reads as no time at all, not a wrapped huge age.
    CHECK(input::ageMs(now, true, now + 5, now, false) == 0);
  });

  test("Windows' 32-bit last input tick widens across the 49.7-day wrap", [] {
    const uint64_t wrap = 0x100000000ULL;
    CHECK(input::widenTick(wrap * 3 + 1000, 400) == wrap * 3 + 400);
    // Taken just before the wrap, read just after it.
    CHECK(input::widenTick(wrap * 3 + 100, 0xFFFFFF00u) == wrap * 3 - 256);
    CHECK(input::widenTick(500, 900) == 0);
  });

  test("versions compare by semver, prerelease numbers by value", [] {
    CHECK(appchannel::compareVersions("0.1.35-beta.10", "0.1.35-beta.9") > 0);
    CHECK(appchannel::compareVersions("0.1.35", "0.1.35-beta.9") > 0);
    CHECK(appchannel::compareVersions("0.1.35-beta.6", "0.1.36-beta.1") < 0);
    CHECK(appchannel::compareVersions("v0.1.35-beta.6", "0.1.35-beta.6") == 0);
    CHECK(appchannel::compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
    CHECK(appchannel::compareVersions("1.0.0-beta", "1.0.0-alpha.9") > 0);
    CHECK(appchannel::compareVersions("1.0.0-rc.1", "1.0.0-beta.11") > 0);
  });

  test("the channel file is Studio's: beta when it says so, else stable, written as the agent writes it", [] {
    CHECK(appchannel::parse("{\n  \"channel\": \"beta\"\n}\n") == "beta");
    CHECK(appchannel::parse("{\"channel\":\"stable\"}") == "stable");
    CHECK(appchannel::parse("{\"channel\":\"nightly\"}") == "stable");
    CHECK(appchannel::parse("not json") == "stable");
    CHECK(appchannel::fileText("beta") == "{\n  \"channel\": \"beta\"\n}\n");
    CHECK(appchannel::fileText("anything") == "{\n  \"channel\": \"stable\"\n}\n");
    CHECK(appchannel::parse(appchannel::fileText("beta")) == "beta");
    CHECK(appchannel::npmTag("beta") == "beta");
    CHECK(appchannel::npmTag("stable") == "latest");
  });

  test("beta takes the newest release carrying latest.json by semver, never a draft", [] {
    const char* body = R"([
      {"tag_name":"v0.1.35-beta.9","draft":false,"prerelease":true,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v0.1.36-beta.1","draft":true,"prerelease":true,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v0.1.35-beta.10","draft":false,"prerelease":true,"assets":[{"name":"latest.json"},{"name":"UE-MCP-Setup.exe"}]},
      {"tag_name":"v0.1.35-beta.11","draft":false,"prerelease":true,"assets":[{"name":"notes.md"}]},
      {"tag_name":"v0.1.34","draft":false,"prerelease":false,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v0.1.35-beta.12\"&calc","draft":false,"assets":[{"name":"latest.json"}]}
    ])";
    appchannel::Pick p = appchannel::newest(body);
    CHECK(p.tag == "v0.1.35-beta.10");
    CHECK(p.url == "https://github.com/db-lyon/ue-mcp-studio/releases/download/v0.1.35-beta.10/latest.json");
    CHECK(p.error.empty());
  });

  test("beta takes a stable release newer than every prerelease", [] {
    appchannel::Pick p = appchannel::newest(R"([{"tag_name":"v0.1.35-beta.6","draft":false,"assets":[{"name":"latest.json"}]},{"tag_name":"v0.1.35","draft":false,"assets":[{"name":"latest.json"}]}])");
    CHECK(p.tag == "v0.1.35");
  });

  test("the editor plugin's newest release is read from its own repo, by its plugin.json", [] {
    const char* body = R"([
      {"tag_name":"v0.1.9-beta.2","draft":false,"prerelease":true,"assets":[{"name":"plugin.json"}]},
      {"tag_name":"v0.1.10-beta.1","draft":false,"prerelease":true,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v0.1.8","draft":false,"prerelease":false,"assets":[{"name":"plugin.json"}]}
    ])";
    appchannel::Pick p = appchannel::newest(body, appchannel::kPluginRepo, "plugin.json");
    CHECK(p.tag == "v0.1.9-beta.2");
    CHECK(p.url == "https://github.com/db-lyon/ue-mcp-studio-plugin/releases/download/v0.1.9-beta.2/plugin.json");
    CHECK(appchannel::newest("[]", appchannel::kPluginRepo, "plugin.json").error.find("editor plugin") != std::string::npos);
  });

  test("latest.json's pluginChannel is followed only into the plugin's own releases", [] {
    CHECK(appchannel::pluginChannel("https://github.com/db-lyon/ue-mcp-studio-plugin/releases/download/v0.1.8/plugin.json") ==
          "https://github.com/db-lyon/ue-mcp-studio-plugin/releases/download/v0.1.8/plugin.json");
    CHECK(appchannel::pluginChannel("https://example.com/plugin.json") == appchannel::kPluginLatest);
    CHECK(appchannel::pluginChannel("https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest/download/other.zip") == appchannel::kPluginLatest);
    CHECK(appchannel::pluginChannel("") == appchannel::kPluginLatest);
  });

  test("a release list with nothing to take, or not a list, says why", [] {
    CHECK(!appchannel::newest("[]").error.empty());
    CHECK(appchannel::newest("[]").url.empty());
    CHECK(!appchannel::newest("{\"message\":\"API rate limit exceeded\"}").error.empty());
    CHECK(!appchannel::newest("<html>").error.empty());
  });

  test("a release list GitHub refused names the rate limit", [] {
    CHECK(appchannel::listFailure(true, 403, "").find("rate limit") != std::string::npos);
    CHECK(appchannel::listFailure(true, 429, "").find("rate limit") != std::string::npos);
    CHECK(appchannel::listFailure(true, 500, "") == "GitHub answered HTTP 500 for the release list.");
    CHECK(appchannel::listFailure(false, 0, "timed out").find("timed out") != std::string::npos);
  });

  test("the app reads again for discovery files and state.json, never for daemon logs", [] {
    CHECK(watch::relevant(watch::Root::Daemons, L"0e9f3c9aae1e89bb.json"));
    CHECK(watch::relevant(watch::Root::Daemons, L"0E9F3C9AAE1E89BB.JSON"));
    CHECK(!watch::relevant(watch::Root::Daemons, L"0e9f3c9aae1e89bb.log"));
    CHECK(!watch::relevant(watch::Root::Daemons, L"sub\\x.json"));
    CHECK(watch::relevant(watch::Root::Home, L"state.json"));
    CHECK(!watch::relevant(watch::Root::Home, L"state.json.tmp"));
    CHECK(!watch::relevant(watch::Root::Home, L"version-check.json"));
  });

  test("a project reads again for its .uproject, solution files and plugin descriptors, not for build output", [] {
    CHECK(watch::relevant(watch::Root::Project, L"Vale.uproject"));
    CHECK(watch::relevant(watch::Root::Project, L"Vale.sln"));
    CHECK(watch::relevant(watch::Root::Project, L"Vale.slnx"));
    CHECK(watch::relevant(watch::Root::Project, L"Vale.code-workspace"));
    CHECK(!watch::relevant(watch::Root::Project, L"Saved\\Logs\\Vale.log"));
    CHECK(!watch::relevant(watch::Root::Project, L"README.md"));
    CHECK(watch::relevant(watch::Root::Plugins, L"UE_MCP_Studio\\UE_MCP_Studio.uplugin"));
    CHECK(watch::relevant(watch::Root::Plugins, L"UE_MCP_Studio"));
    CHECK(!watch::relevant(watch::Root::Plugins, L"UE_MCP_Studio\\Intermediate\\Build\\x.uplugin"));
    CHECK(!watch::relevant(watch::Root::Plugins, L"UE_MCP_Studio\\Binaries\\Win64\\UnrealEditor-UE_MCP_Studio.dll"));
    CHECK(!watch::relevant(watch::Root::Plugins, L"UE_MCP_Studio\\Source\\Private\\StudioDock.cpp"));
  });

  test("a burst of changes reads once when it settles, and a folder that keeps changing still reads", [] {
    CHECK(watch::delay(1000, 1000) == 1500);
    CHECK(watch::delay(1000, 5000) == 1500);
    CHECK(watch::delay(1000, 8000) == 1000);
    CHECK(watch::delay(1000, 9000) == 0);
    CHECK(watch::delay(1000, 20000) == 0);
  });

  std::printf(failures ? "%d failed\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
