// The panel's location: the hash of the page's URL (#/chat/<session>, ...).
// The window keeps the last one and puts it on every load of the UI, so a
// daemon back on a new port, or a new window process, opens where the
// panel was.
#pragma once

#include <cwctype>
#include <string>

namespace location {

/** The URL's fragment, '#' included, or empty. */
inline std::wstring fragmentOf(const std::wstring& url) {
  size_t k = url.find(L'#');
  return k == std::wstring::npos ? std::wstring() : url.substr(k);
}

/** A fragment the panel writes: '#' then letters, digits and / _ - . only. */
inline bool safeFragment(const std::wstring& f) {
  if (f.empty()) return true;
  if (f[0] != L'#' || f.size() > 512) return false;
  for (size_t i = 1; i < f.size(); ++i) {
    wchar_t c = f[i];
    if (!(iswalnum(c) && c < 128) && c != L'/' && c != L'_' && c != L'-' && c != L'.') return false;
  }
  return true;
}

/** The URL with its fragment replaced by the kept one; an unsafe one is dropped. */
inline std::wstring withFragment(const std::wstring& url, const std::wstring& fragment) {
  size_t k = url.find(L'#');
  std::wstring base = k == std::wstring::npos ? url : url.substr(0, k);
  return safeFragment(fragment) ? base + fragment : base;
}

}  // namespace location
