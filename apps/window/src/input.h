// When the owner last used the keyboard or mouse: the parts with no Windows
// calls, so apps/window/test/dock-test.cpp can check them.
//
// GetLastInputInfo counts input programs inject with SendInput. The editor's
// screen saver inhibitor sends a zero mouse move every 50 seconds while Play
// in Editor runs, which kept a computer nobody was at "in use" through a whole
// playtest loop. Low-level hooks see each real key and mouse event with a flag
// on the injected ones, and never see that zero move, so the window keeps its
// own clock from them.
#pragma once

#include <cstdint>

namespace input {

// KBDLLHOOKSTRUCT and MSLLHOOKSTRUCT flags, as winuser.h defines them.
constexpr uint32_t kKeyInjected = 0x10;       // LLKHF_INJECTED
constexpr uint32_t kKeyLowerIlInjected = 0x02;  // LLKHF_LOWER_IL_INJECTED
constexpr uint32_t kMouseInjected = 0x01;     // LLMHF_INJECTED
constexpr uint32_t kMouseLowerIlInjected = 0x02;  // LLMHF_LOWER_IL_INJECTED

/** A hooked key event came from a person, not from SendInput or another program. */
constexpr bool realKey(uint32_t flags) { return (flags & (kKeyInjected | kKeyLowerIlInjected)) == 0; }
constexpr bool realMouse(uint32_t flags) { return (flags & (kMouseInjected | kMouseLowerIlInjected)) == 0; }

/**
 * Milliseconds since the owner's last input, in tick-count time.
 * hooked: the hooks are installed and running.
 * lastReal: the tick of the last real event the hooks saw, or of GetLastInputInfo when they started.
 * lastAny: GetLastInputInfo's tick, which injected input moves too.
 * foregroundUnhookable: the window in front belongs to a process the hooks are not told about
 *   (an elevated one, for a window that is not), where only GetLastInputInfo sees the owner typing.
 */
inline uint64_t ageMs(uint64_t now, bool hooked, uint64_t lastReal, uint64_t lastAny, bool foregroundUnhookable) {
  uint64_t last = hooked && !foregroundUnhookable ? lastReal : lastAny;
  if (hooked && foregroundUnhookable && lastReal > last) last = lastReal;
  return now > last ? now - last : 0;
}

/**
 * GetLastInputInfo's 32-bit tick, widened against a 64-bit now, so the
 * difference stays right across the 49.7-day wrap of GetTickCount.
 */
inline uint64_t widenTick(uint64_t now64, uint32_t tick32) {
  uint32_t now32 = static_cast<uint32_t>(now64);
  uint32_t back = now32 - tick32;
  return now64 >= back ? now64 - back : 0;
}

}  // namespace input
