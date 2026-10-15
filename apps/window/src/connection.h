// The window's side of the connection to ue-mcp, while no page from ue-mcp is
// loaded: wait briefly for a daemon about to appear, start it with bounded
// retries and backoff, load Studio's page when one is live, and say when it
// needs the user. A loaded page runs the same policy itself
// (apps/client-web/src/connection.ts) and reports it, so the window leaves it
// in place. Pure: main.cpp feeds it what it reads and does what it returns.
#pragma once

#include <cstdint>
#include <string>

namespace conn {

using Ms = uint64_t;

/** No daemon: the editor may be starting one, so wait this long before starting it here. */
constexpr Ms kWaitMs = 5000;
/** A discovery file whose process is gone: ue-mcp crashed, nothing else will start it. */
constexpr Ms kCrashWaitMs = 1000;
/** An update in progress restarts the daemon; wait for it this long. */
constexpr Ms kUpdateWaitMs = 180000;
/** One start attempt waits this long for the discovery file. */
constexpr Ms kAttemptMs = 45000;
/** The wait before attempts 2 and 3. */
constexpr Ms kBackoffMs[] = {5000, 15000};
constexpr int kMaxAttempts = 3;
/** A load of Studio's page this long without an answer counts as failed. */
constexpr Ms kLoadWaitMs = 20000;
/** The wait before loads 2 and 3 of a page that did not load. */
constexpr Ms kLoadBackoffMs[] = {2000, 5000};
constexpr int kMaxLoads = 3;

enum class Phase { Waiting, Restarting, Starting, Loading, NeedsYou };
enum class Effect { None, Start, Load };

/** What the window reads each poll. */
struct Facts {
  bool live = false;      // a discovery file whose process runs
  bool stale = false;     // a discovery file whose process is gone
  bool updating = false;  // an update run from the panel is under way
  std::string token;      // the live daemon's token: a new daemon gets fresh loads
};

struct State {
  Phase phase = Phase::Waiting;
  Ms since = 0;  // when ue-mcp was first seen missing
  Ms deadline = 0;
  int attempt = 0;
  bool launched = false;
  int loads = 0;
  std::string loadToken;
  std::string why;
  std::string failure;
  bool noNode = false;
};

inline const char* phaseName(Phase p) {
  switch (p) {
    case Phase::Waiting: return "waiting";
    case Phase::Restarting: return "restarting";
    case Phase::Starting: return "starting";
    case Phase::Loading: return "loading";
    case Phase::NeedsYou: return "needsYou";
  }
  return "";
}

inline void wait(State& s, const Facts& f, Ms now) {
  s.attempt = 0;
  s.launched = false;
  s.failure.clear();
  s.noNode = false;
  if (f.updating) {
    s.phase = Phase::Restarting;
    s.why = "ue-mcp is restarting for an update";
    s.deadline = now + kUpdateWaitMs;
  } else {
    s.phase = Phase::Waiting;
    s.why = f.stale ? "ue-mcp stopped unexpectedly" : "ue-mcp is not running";
    s.deadline = now + (f.stale ? kCrashWaitMs : kWaitMs);
  }
}

/** The local page is shown: ue-mcp is away, or its page did not load. */
inline State begin(const Facts& f, Ms now) {
  State s;
  s.since = now;
  wait(s, f, now);
  return s;
}

inline void needsYou(State& s, const std::string& failure, bool noNode = false) {
  s.phase = Phase::NeedsYou;
  s.failure = failure;
  s.noNode = noNode;
  s.launched = false;
  s.deadline = 0;
}

inline void attempt(State& s, int n, Ms at) {
  s.phase = Phase::Starting;
  s.attempt = n;
  s.launched = false;
  s.deadline = at;
}

/** The attempt after a failed one, or needs you after the last. */
inline void next(State& s, Ms now, const std::string& failure) {
  if (s.attempt >= kMaxAttempts) {
    needsYou(s, "ue-mcp did not start after " + std::to_string(kMaxAttempts) + " attempts. " + failure);
    return;
  }
  int k = s.attempt - 1;
  attempt(s, s.attempt + 1, now + kBackoffMs[k < 1 ? k : 1]);
  s.failure = failure;
}

inline Effect launch(State& s, Ms now) {
  s.launched = true;
  s.deadline = now + kAttemptMs;
  return Effect::Start;
}

/** One poll. */
inline Effect tick(State& s, const Facts& f, Ms now) {
  if (f.live) {
    if (f.token != s.loadToken) {
      s.loadToken = f.token;
      s.loads = 0;
      if (s.phase == Phase::NeedsYou) s.phase = Phase::Loading;
    }
    if (s.phase == Phase::NeedsYou) return Effect::None;
    if (s.phase == Phase::Loading && now < s.deadline) return Effect::None;
    if (s.phase == Phase::Loading && s.launched) {
      // The last load never answered.
      ++s.loads;
      s.failure = "Studio's page did not answer within " + std::to_string(kLoadWaitMs / 1000) + " seconds.";
      if (s.loads >= kMaxLoads) {
        needsYou(s, "ue-mcp is running, but Studio's page did not load. " + s.failure);
        return Effect::None;
      }
    }
    s.phase = Phase::Loading;
    s.launched = true;
    s.deadline = now + kLoadWaitMs;
    return Effect::Load;
  }
  switch (s.phase) {
    case Phase::Loading:
      wait(s, f, now);
      return Effect::None;
    case Phase::Waiting:
      if (f.updating) {
        wait(s, f, now);
        return Effect::None;
      }
      [[fallthrough]];
    case Phase::Restarting:
      if (now < s.deadline) return Effect::None;
      attempt(s, 1, now);
      return launch(s, now);
    case Phase::Starting:
      if (now < s.deadline) return Effect::None;
      if (!s.launched) return launch(s, now);
      next(s, now, "ue-mcp did not answer within " + std::to_string(kAttemptMs / 1000) + " seconds of starting.");
      return Effect::None;
    case Phase::NeedsYou:
      return Effect::None;
  }
  return Effect::None;
}

/** How a start attempt went. error is why the command did not run. */
inline void started(State& s, bool ok, bool noNode, const std::string& error, Ms now) {
  if (s.phase != Phase::Starting || !s.launched) return;
  if (noNode) needsYou(s, "Node.js was not found. ue-mcp runs on Node.js; install it, then retry.", true);
  else if (!ok) next(s, now, "The start command did not run" + (error.empty() ? std::string(".") : ": " + error + "."));
}

/** The page from the live daemon did not load. */
inline void loadFailed(State& s, const std::string& why, Ms now) {
  ++s.loads;
  s.failure = "Studio's page did not load: " + why + ".";
  if (s.loads >= kMaxLoads) {
    needsYou(s, "ue-mcp is running, but Studio's page did not load. " + s.failure);
    return;
  }
  s.phase = Phase::Loading;
  s.launched = false;
  s.deadline = now + kLoadBackoffMs[s.loads - 1 < 1 ? s.loads - 1 : 1];
}

/** The user's Retry: start over at once. */
inline Effect retry(State& s, const Facts& f, Ms now) {
  if (s.phase != Phase::NeedsYou) return Effect::None;
  s.failure.clear();
  s.noNode = false;
  s.loads = 0;
  if (f.live) {
    s.phase = Phase::Loading;
    s.launched = true;
    s.deadline = now + kLoadWaitMs;
    return Effect::Load;
  }
  attempt(s, 1, now);
  return launch(s, now);
}

/** "8s", "1m 05s". */
inline std::string elapsed(Ms ms) {
  Ms t = ms / 1000;
  if (t < 60) return std::to_string(t) + "s";
  std::string sec = std::to_string(t % 60);
  return std::to_string(t / 60) + "m " + (sec.size() < 2 ? "0" : "") + sec + "s";
}

inline std::string headline(const State& s, Ms now) {
  std::string of = " (attempt " + std::to_string(s.attempt) + " of " + std::to_string(kMaxAttempts) + ")";
  switch (s.phase) {
    case Phase::Waiting: return "Connecting to ue-mcp";
    case Phase::Restarting: return s.why;
    case Phase::Starting:
      return !s.launched && s.deadline > now ? "Starting ue-mcp again in " + elapsed(s.deadline - now + 999) + of : "Starting ue-mcp" + of;
    case Phase::Loading: return "Loading Studio";
    case Phase::NeedsYou: return s.loads ? "Studio did not load" : "ue-mcp is not running";
  }
  return "";
}

inline std::string body(const State& s, Ms now) {
  std::string ago = elapsed(now - s.since);
  std::string failure = s.failure.empty() ? "" : " " + s.failure;
  switch (s.phase) {
    case Phase::Waiting:
      return s.why + ", " + ago + " so far. Studio starts it if it does not come up.";
    case Phase::Restarting:
      return "Waiting for it to come back, " + ago + " so far. Studio loads it as soon as it is up.";
    case Phase::Starting:
      return s.why + ", " + ago + "." + failure + " Studio loads it as soon as it is up.";
    case Phase::Loading:
      return "ue-mcp is running." + failure;
    case Phase::NeedsYou:
      return s.loads ? "" : s.why + ", " + ago + ".";
  }
  return "";
}

}  // namespace conn
