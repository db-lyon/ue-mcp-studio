// Docked mode: the editor plugin's dock tab reports where Studio goes, and
// studio-window.exe holds itself there as an unowned popup.
//
// The plugin writes its section of a named shared-memory block from Slate's
// tick, only when something changed, and signals a named event; the window
// reads it without ever sending the editor a message, so a busy game thread
// cannot stall it. The window writes its own section back (its mode, and
// requests to open or close the dock tab), which the plugin reads on tick.
//
// Names, for a project key K (the daemon's key):
//   Local\UEMCPStudioDock.K          the block, kSize bytes
//   Local\UEMCPStudioDock.K.changed  auto-reset event the plugin sets after a write
//
// Layout, little-endian, version kLayout. Each section is a seqlock: its
// writer makes seq odd, writes the fields, then makes seq even again.
//   0   u32 magic (kMagic)          4   u32 layout (kLayout)
//   plugin section
//   8   u32 seq                     12  u32 editor pid
//   16  u64 host HWND: the top-level window holding the tab
//   24  i32 x   28 i32 y   32 i32 w   36 i32 h
//       the tab's content area in physical pixels, relative to the host's client origin
//   40  u32 flags (kOpen, kVisible, kOverlay, kCutouts)
//   44  u32 frame: counts the plugin's writes
//   48  u32 cutout count, at most kMaxCutouts
//   96  the cutouts, 16 bytes each: i32 x, y, w, h, relative to the tab's
//       content origin (the docked window's origin), in physical pixels.
//       They are part of the plugin section and written under its seq.
//   studio section
//   64  u32 seq                     68  u32 window pid
//   72  u32 mode (Mode)             76  u32 request seq
//   80  u32 request (Request): what the window last asked the plugin for
//
// Cutouts are what the editor draws over the tab: drawers and in-window
// popups Slate paints inside the host window, and the editor's own windows
// (menus, tooltips, notifications, drag decorators, modals) above the host.
// No z-order lifts part of the host window over Studio, so Studio cuts those
// rects out of its window region and the editor shows through them. They were
// added to layout 1 without changing it: an older plugin never sets kCutouts,
// and an older window never reads them.
//
// The plugin keeps its own copy of this layout; change both together.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace dock {

constexpr uint32_t kMagic = 0x4B434453;  // "SDCK"
constexpr uint32_t kLayout = 1;
constexpr size_t kSize = 256;

constexpr size_t kOffMagic = 0, kOffLayout = 4;
constexpr size_t kOffPluginSeq = 8, kOffPluginPid = 12, kOffHost = 16, kOffX = 24, kOffY = 28, kOffW = 32, kOffH = 36, kOffFlags = 40, kOffFrame = 44;
constexpr size_t kOffCutoutCount = 48, kOffCutouts = 96, kCutoutBytes = 16;
constexpr size_t kOffStudioSeq = 64, kOffStudioPid = 68, kOffStudioMode = 72, kOffRequestSeq = 76, kOffRequest = 80;
constexpr uint32_t kMaxCutouts = (uint32_t)((kSize - kOffCutouts) / kCutoutBytes);

/** The dock tab exists. */
constexpr uint32_t kOpen = 1;
/** Its content is on screen: the front tab of its stack, painted, and its window not minimized. */
constexpr uint32_t kVisible = 2;
/** An editor menu, popup, modal or drag is open over the rect. */
constexpr uint32_t kOverlay = 4;
/** The report carries the cutout list (the count may be 0). An older plugin never sets it. */
constexpr uint32_t kCutouts = 8;

enum class Mode : uint32_t { None = 0, Window = 1, Docked = 2 };
enum class Request : uint32_t { None = 0, OpenTab = 1, CloseTab = 2 };

/** A rect in the docked window's own coordinates: physical pixels from its top-left corner. */
struct Rect {
  int32_t x = 0, y = 0, w = 0, h = 0;
  bool operator==(const Rect& o) const { return x == o.x && y == o.y && w == o.w && h == o.h; }
  bool operator!=(const Rect& o) const { return !(*this == o); }
};

struct Report {
  uint32_t pid = 0;
  uint64_t host = 0;
  int32_t x = 0, y = 0, w = 0, h = 0;
  uint32_t flags = 0;
  uint32_t frame = 0;
  uint32_t cutoutCount = 0;
  Rect cutouts[kMaxCutouts];
};

struct StudioSection {
  uint32_t pid = 0;
  Mode mode = Mode::None;
  uint32_t requestSeq = 0;
  Request request = Request::None;
};

inline uint32_t load32(const volatile uint8_t* m, size_t off) { return *reinterpret_cast<const volatile uint32_t*>(m + off); }
inline uint64_t load64(const volatile uint8_t* m, size_t off) { return *reinterpret_cast<const volatile uint64_t*>(m + off); }
inline void store32(volatile uint8_t* m, size_t off, uint32_t v) { *reinterpret_cast<volatile uint32_t*>(m + off) = v; }
inline void store64(volatile uint8_t* m, size_t off, uint64_t v) { *reinterpret_cast<volatile uint64_t*>(m + off) = v; }

/** Stamp an empty block; a block already stamped is left alone. */
inline void init(volatile uint8_t* m) {
  if (load32(m, kOffMagic) == kMagic) return;
  store32(m, kOffLayout, kLayout);
  store32(m, kOffMagic, kMagic);
}

inline bool stamped(const volatile uint8_t* m, size_t size) {
  return m && size >= kSize && load32(m, kOffMagic) == kMagic && load32(m, kOffLayout) == kLayout;
}

/**
 * The plugin's last report. False when the block is not a dock block of this
 * layout, the plugin never wrote, or a write stayed in progress.
 */
inline bool readReport(const volatile uint8_t* m, size_t size, Report& out) {
  if (!stamped(m, size)) return false;
  for (int attempt = 0; attempt < 64; ++attempt) {
    uint32_t before = load32(m, kOffPluginSeq);
    if (before & 1) continue;
    Report r;
    r.pid = load32(m, kOffPluginPid);
    r.host = load64(m, kOffHost);
    r.x = (int32_t)load32(m, kOffX);
    r.y = (int32_t)load32(m, kOffY);
    r.w = (int32_t)load32(m, kOffW);
    r.h = (int32_t)load32(m, kOffH);
    r.flags = load32(m, kOffFlags);
    r.frame = load32(m, kOffFrame);
    if (r.flags & kCutouts) {
      uint32_t n = load32(m, kOffCutoutCount);
      r.cutoutCount = n < kMaxCutouts ? n : kMaxCutouts;
      for (uint32_t i = 0; i < r.cutoutCount; ++i) {
        size_t at = kOffCutouts + i * kCutoutBytes;
        r.cutouts[i] = {(int32_t)load32(m, at), (int32_t)load32(m, at + 4), (int32_t)load32(m, at + 8), (int32_t)load32(m, at + 12)};
      }
    }
    if (load32(m, kOffPluginSeq) != before) continue;
    if (before == 0 || r.pid == 0) return false;
    out = r;
    return true;
  }
  return false;
}

/** The plugin's write, as the plugin does it; here for tests. */
inline void writeReport(volatile uint8_t* m, const Report& r) {
  uint32_t seq = load32(m, kOffPluginSeq);
  store32(m, kOffPluginSeq, seq | 1);
  store32(m, kOffPluginPid, r.pid);
  store64(m, kOffHost, r.host);
  store32(m, kOffX, (uint32_t)r.x);
  store32(m, kOffY, (uint32_t)r.y);
  store32(m, kOffW, (uint32_t)r.w);
  store32(m, kOffH, (uint32_t)r.h);
  store32(m, kOffFlags, r.flags);
  store32(m, kOffFrame, r.frame);
  uint32_t n = r.cutoutCount < kMaxCutouts ? r.cutoutCount : kMaxCutouts;
  store32(m, kOffCutoutCount, n);
  for (uint32_t i = 0; i < n; ++i) {
    size_t at = kOffCutouts + i * kCutoutBytes;
    store32(m, at, (uint32_t)r.cutouts[i].x);
    store32(m, at + 4, (uint32_t)r.cutouts[i].y);
    store32(m, at + 8, (uint32_t)r.cutouts[i].w);
    store32(m, at + 12, (uint32_t)r.cutouts[i].h);
  }
  store32(m, kOffPluginSeq, (seq | 1) + 1);
}

inline void writeStudio(volatile uint8_t* m, const StudioSection& s) {
  uint32_t seq = load32(m, kOffStudioSeq);
  store32(m, kOffStudioSeq, seq | 1);
  store32(m, kOffStudioPid, s.pid);
  store32(m, kOffStudioMode, (uint32_t)s.mode);
  store32(m, kOffRequestSeq, s.requestSeq);
  store32(m, kOffRequest, (uint32_t)s.request);
  store32(m, kOffStudioSeq, (seq | 1) + 1);
}

inline bool readStudio(const volatile uint8_t* m, size_t size, StudioSection& out) {
  if (!stamped(m, size)) return false;
  for (int attempt = 0; attempt < 64; ++attempt) {
    uint32_t before = load32(m, kOffStudioSeq);
    if (before & 1) continue;
    StudioSection s;
    s.pid = load32(m, kOffStudioPid);
    s.mode = (Mode)load32(m, kOffStudioMode);
    s.requestSeq = load32(m, kOffRequestSeq);
    s.request = (Request)load32(m, kOffRequest);
    if (load32(m, kOffStudioSeq) != before) continue;
    out = s;
    return true;
  }
  return false;
}

/** The saved choice: "docked" or "window", any surrounding whitespace allowed. */
inline Mode parseMode(const std::string& text) {
  size_t a = text.find_first_not_of(" \t\r\n");
  size_t b = text.find_last_not_of(" \t\r\n");
  std::string t = a == std::string::npos ? std::string() : text.substr(a, b - a + 1);
  if (t == "docked") return Mode::Docked;
  if (t == "window") return Mode::Window;
  return Mode::None;
}

inline const char* modeName(Mode m) { return m == Mode::Docked ? "docked" : "window"; }

// ---------------------------------------------------------------- where the window goes

/** The host window as the window sees it, read without sending it a message. */
struct Host {
  bool exists = false;   // a window of the reporting editor
  bool visible = false;
  bool iconic = false;
  bool elsewhere = false;  // cloaked: on another virtual desktop
  long originX = 0, originY = 0;  // its client origin on screen
};

enum class Show { Window, Docked, Hidden };

struct Placement {
  Show show = Show::Window;
  long x = 0, y = 0, w = 0, h = 0;
};

/** A live dock tab can host the window: the plugin reported, and its editor still runs. */
inline bool canDock(bool haveReport, bool writerAlive) { return haveReport && writerAlive; }

/**
 * Where the window goes. In window mode, and in docked mode with no live dock
 * to follow (an older plugin, no editor), it is an ordinary window. With a
 * live dock it is over the tab's content while the tab shows, and hidden
 * otherwise. A busy editor writes nothing, so its last report holds.
 *
 * `tabSeen` is whether this editor has shown the tab yet. An editor coming
 * back from a restart or a crash reports before its tab appears, and Studio
 * stays a window through that, so it never vanishes between the two. With no
 * visible host (an editor shutting down or not yet up) it is a window too;
 * only a host that is there, minimized, on another virtual desktop or showing
 * another tab, hides it. The docked window is a tool window, which Windows
 * shows on every desktop, so it hides itself where the editor is not.
 */
inline Placement place(Mode mode, bool haveReport, const Report& r, bool writerAlive, const Host& host, bool tabSeen = true) {
  Placement p;
  if (mode != Mode::Docked || !canDock(haveReport, writerAlive)) return p;
  bool shown = (r.flags & kOpen) && (r.flags & kVisible) && r.w > 0 && r.h > 0 && host.exists && host.visible && !host.iconic && !host.elsewhere;
  bool hostThere = host.exists && (host.visible || host.iconic);
  if (!shown && (!tabSeen || !hostThere)) return p;
  p.show = Show::Hidden;
  if (!shown) return p;
  p.show = Show::Docked;
  p.x = host.originX + r.x;
  p.y = host.originY + r.y;
  p.w = r.w;
  p.h = r.h;
  return p;
}

/**
 * The window Studio is placed under so that it sits directly above the host:
 * the first window above the host that is not Studio, so the editor's menus,
 * popups and modals (above the host) stay above Studio too. 0 means the top
 * of the non-topmost band, also used when that window is topmost.
 *
 * prev(w) is the next window up the z-order (GW_HWNDPREV), 0 at the top;
 * topmost(w) is whether it has WS_EX_TOPMOST.
 */
template <class Prev, class Topmost>
uintptr_t slotAbove(uintptr_t host, uintptr_t self, Prev prev, Topmost topmost) {
  uintptr_t above = prev(host);
  while (above && above == self) above = prev(above);
  return above && !topmost(above) ? above : 0;
}

/**
 * Topmost while the editor or Studio is in front, so the editor rising on a
 * click cannot cover the docked window for a frame; not while an editor menu,
 * popup or modal is over the tab, which must draw above Studio.
 */
inline bool wantTopmost(bool editorOrStudioInFront, uint32_t flags) { return editorOrStudioInFront && !(flags & kOverlay); }

// ---------------------------------------------------------------- what the editor draws over the tab

/**
 * The rects to cut out of the docked window, w by h physical pixels: the
 * report's cutouts clipped to the window, the empty ones dropped. Empty when
 * nothing is over the tab, and from a plugin that does not report cutouts,
 * whose overlays only the kOverlay restack can show.
 */
inline std::vector<Rect> cutouts(const Report& r, long w, long h) {
  std::vector<Rect> out;
  if (!(r.flags & kCutouts) || w <= 0 || h <= 0) return out;
  uint32_t n = r.cutoutCount < kMaxCutouts ? r.cutoutCount : kMaxCutouts;
  for (uint32_t i = 0; i < n; ++i) {
    const Rect& c = r.cutouts[i];
    if (c.w <= 0 || c.h <= 0) continue;
    long left = c.x > 0 ? c.x : 0;
    long top = c.y > 0 ? c.y : 0;
    long right = (long)c.x + c.w < w ? (long)c.x + c.w : w;
    long bottom = (long)c.y + c.h < h ? (long)c.y + c.h : h;
    if (right <= left || bottom <= top) continue;
    out.push_back({(int32_t)left, (int32_t)top, (int32_t)(right - left), (int32_t)(bottom - top)});
  }
  return out;
}

/** Whether the docked window shows at (x, y) of its own coordinates once the cutouts are taken out: Studio there, or the editor. */
inline bool showsStudio(const std::vector<Rect>& cuts, long w, long h, long x, long y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  for (const Rect& c : cuts) {
    if (x >= c.x && x < (long)c.x + c.w && y >= c.y && y < (long)c.y + c.h) return false;
  }
  return true;
}

/** Whether Studio already sits in that slot: directly under it, or at the top of the non-topmost band. */
template <class Prev, class Topmost>
bool inSlot(uintptr_t slot, uintptr_t self, Prev prev, Topmost topmost) {
  uintptr_t above = prev(self);
  return slot ? above == slot : (!above || topmost(above));
}

}  // namespace dock
