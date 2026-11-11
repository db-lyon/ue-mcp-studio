// The app's release channel: the Stable or Beta choice Studio keeps in
// ~/.ue-mcp/studio/update-channel.json (apps/agent/src/updates.ts), one
// preference for the machine. Stable follows the latest release's latest.json;
// Beta reads the release list, since GitHub never serves a prerelease as
// latest, and takes the newest release by semver. It also picks ue-mcp's npm
// dist-tag. Pure: app.cpp reads the file and the network.
#pragma once

#include <cctype>
#include <cstdlib>
#include <string>
#include <vector>

#include "json.h"

namespace appchannel {

inline const char* kRepo = "db-lyon/ue-mcp-studio";
inline const char* kLatest = "https://github.com/db-lyon/ue-mcp-studio/releases/latest/download/latest.json";
inline const char* kReleases = "https://api.github.com/repos/db-lyon/ue-mcp-studio/releases?per_page=30";
/** The Studio editor plugin, released on its own: its repo, its release list and its latest release's plugin.json. */
inline const char* kPluginRepo = "db-lyon/ue-mcp-studio-plugin";
inline const char* kPluginReleases = "https://api.github.com/repos/db-lyon/ue-mcp-studio-plugin/releases?per_page=30";
inline const char* kPluginLatest = "https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest/download/plugin.json";

/** "beta" when the file says so, else "stable", as the agent's readChannel reads it. */
inline std::string parse(const std::string& text) {
  json::Value v;
  if (!json::parse(text, v)) return "stable";
  const json::Value* c = v.get("channel");
  return c && c->isString() && c->s == "beta" ? "beta" : "stable";
}

/** The file's text, written as the agent's writeChannel writes it. */
inline std::string fileText(const std::string& channel) { return "{\n  \"channel\": \"" + std::string(channel == "beta" ? "beta" : "stable") + "\"\n}\n"; }

/** ue-mcp's npm dist-tag for the channel. */
inline std::string npmTag(const std::string& channel) { return channel == "beta" ? "beta" : "latest"; }

/**
 * -1, 0 or 1 as a is older than, the same as or newer than b, by semver:
 * major.minor.patch, then a release over its prereleases, then the prerelease
 * identifiers in turn, numbers by value (beta.10 after beta.9). A leading v is ignored.
 */
inline int compareVersions(std::string a, std::string b) {
  if (!a.empty() && (a[0] == 'v' || a[0] == 'V')) a.erase(0, 1);
  if (!b.empty() && (b[0] == 'v' || b[0] == 'V')) b.erase(0, 1);
  auto split = [](const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t i = 0;
    for (;;) {
      size_t j = s.find(sep, i);
      out.push_back(s.substr(i, j == std::string::npos ? std::string::npos : j - i));
      if (j == std::string::npos) break;
      i = j + 1;
    }
    return out;
  };
  auto numeric = [](const std::string& s) {
    if (s.empty()) return false;
    for (char c : s) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    return true;
  };
  auto cut = [](const std::string& v, std::string& core, std::string& pre) {
    size_t plus = v.find('+');
    std::string s = v.substr(0, plus);
    size_t dash = s.find('-');
    core = s.substr(0, dash);
    pre = dash == std::string::npos ? "" : s.substr(dash + 1);
  };
  std::string ca, pa, cb, pb;
  cut(a, ca, pa);
  cut(b, cb, pb);
  std::vector<std::string> x = split(ca, '.'), y = split(cb, '.');
  for (size_t i = 0; i < 3; ++i) {
    long xi = i < x.size() ? atol(x[i].c_str()) : 0, yi = i < y.size() ? atol(y[i].c_str()) : 0;
    if (xi != yi) return xi < yi ? -1 : 1;
  }
  if (pa == pb) return 0;
  if (pa.empty()) return 1;
  if (pb.empty()) return -1;
  std::vector<std::string> p = split(pa, '.'), q = split(pb, '.');
  for (size_t i = 0; i < p.size() && i < q.size(); ++i) {
    bool np = numeric(p[i]), nq = numeric(q[i]);
    if (np && nq) {
      long u = atol(p[i].c_str()), w = atol(q[i].c_str());
      if (u != w) return u < w ? -1 : 1;
    } else if (np != nq) {
      return np ? -1 : 1;
    } else if (p[i] != q[i]) {
      return p[i] < q[i] ? -1 : 1;
    }
  }
  if (p.size() == q.size()) return 0;
  return p.size() < q.size() ? -1 : 1;
}

/** A tag that may go into a download address: v, then digits, dots and a -prerelease of [0-9A-Za-z.]. */
inline bool safeTag(const std::string& tag) {
  if (tag.size() < 6 || tag[0] != 'v' || !std::isdigit(static_cast<unsigned char>(tag[1]))) return false;
  for (char c : tag) if (!std::isalnum(static_cast<unsigned char>(c)) && c != '.' && c != '-') return false;
  return true;
}

struct Pick {
  /** The release's tag, such as v0.1.35-beta.6; empty when none fits. */
  std::string tag;
  /** Its latest.json. */
  std::string url;
  std::string error;
};

/**
 * The newest release in GitHub's release list that is not a draft and carries
 * `asset` (latest.json, or plugin.json in the editor plugin's own repo),
 * prereleases included, by semver rather than by list order.
 */
inline Pick newest(const std::string& body, const std::string& repo = kRepo, const std::string& asset = "latest.json") {
  Pick r;
  json::Value list;
  if (!json::parse(body, list) || !list.isArray()) {
    r.error = "GitHub's release list could not be read.";
    return r;
  }
  for (const json::Value& rel : *list.a) {
    const json::Value* draft = rel.get("draft");
    const json::Value* tag = rel.get("tag_name");
    const json::Value* assets = rel.get("assets");
    if ((draft && draft->isBool() && draft->b) || !tag || !tag->isString() || !safeTag(tag->s) || !assets || !assets->isArray()) continue;
    bool carries = false;
    for (const json::Value& a : *assets->a) {
      const json::Value* name = a.get("name");
      if (name && name->isString() && name->s == asset) carries = true;
    }
    if (!carries) continue;
    if (r.tag.empty() || compareVersions(tag->s, r.tag) > 0) r.tag = tag->s;
  }
  if (r.tag.empty()) r.error = (repo == kRepo ? "No release of UE-MCP carries " : "No release of the editor plugin carries ") + asset + " yet.";
  else r.url = "https://github.com/" + repo + "/releases/download/" + r.tag + "/" + asset;
  return r;
}

/**
 * Why the release list was not read: GitHub's rate limit for callers that do
 * not sign in (403 or 429), another status, or the network.
 */
inline std::string listFailure(bool answered, unsigned long status, const std::string& network) {
  if (!answered) return "GitHub's release list could not be read: " + network + ".";
  if (status == 403 || status == 429)
    return "GitHub's rate limit for release checks was reached (60 an hour from this network). Try again in an hour, or switch to Stable.";
  return "GitHub answered HTTP " + std::to_string(status) + " for the release list.";
}

/**
 * The editor plugin's plugin.json as latest.json names it, when that is an
 * address in the plugin's own GitHub releases; else its latest release's.
 */
inline std::string pluginChannel(const std::string& named) {
  const std::string prefix = "https://github.com/" + std::string(kPluginRepo) + "/releases/";
  const std::string file = "/plugin.json";
  if (named.size() < prefix.size() + file.size() || named.rfind(prefix, 0) != 0 || named.compare(named.size() - file.size(), file.size(), file) != 0) return kPluginLatest;
  for (char c : named) if (std::isspace(static_cast<unsigned char>(c)) || c == '"' || c == '\\') return kPluginLatest;
  return named;
}

}  // namespace appchannel
