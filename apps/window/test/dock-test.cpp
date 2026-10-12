// Unit tests for dock.h: the shared-memory protocol and where the window goes.
// Built beside studio-window.exe; apps/window/test/dock.test.ts runs it.
// Prints "ok <name>" or "FAIL <name>: <what>" per case and exits non-zero on a failure.

#include <cstdio>
#include <map>
#include <vector>

#include "../src/dock.h"

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

  test("hidden while the host is minimized, hidden or gone", [] {
    dock::Host h = host();
    h.iconic = true;
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, h).show == dock::Show::Hidden);
    h = host();
    h.visible = false;
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, h).show == dock::Show::Hidden);
    CHECK(dock::place(dock::Mode::Docked, true, sample(), true, dock::Host()).show == dock::Show::Hidden);
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

  std::printf(failures ? "%d failed\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
