// Unit tests for dock.h (the shared-memory protocol and where the window goes),
// location.h and connection.h.
// Built beside studio-window.exe; apps/window/test/dock.test.ts runs it.
// Prints "ok <name>" or "FAIL <name>: <what>" per case and exits non-zero on a failure.

#include <cstdio>
#include <map>
#include <vector>

#include "../src/connection.h"
#include "../src/dock.h"
#include "../src/location.h"

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

  std::printf(failures ? "%d failed\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
