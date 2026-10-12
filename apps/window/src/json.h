// A small JSON reader and writer: enough for the daemon's discovery file, the
// setup options the page sends, and the .uproject's plugin list.
#pragma once

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace json {

struct Value;
using Object = std::vector<std::pair<std::string, Value>>;
using Array = std::vector<Value>;

struct Value {
  enum class Kind { Null, Bool, Number, String, Array, Object } kind = Kind::Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::shared_ptr<Array> a;
  std::shared_ptr<Object> o;

  static Value str(const std::string& v) { Value x; x.kind = Kind::String; x.s = v; return x; }
  static Value boolean(bool v) { Value x; x.kind = Kind::Bool; x.b = v; return x; }
  static Value object() { Value x; x.kind = Kind::Object; x.o = std::make_shared<Object>(); return x; }

  bool isObject() const { return kind == Kind::Object && o; }
  bool isArray() const { return kind == Kind::Array && a; }
  bool isString() const { return kind == Kind::String; }
  bool isNumber() const { return kind == Kind::Number; }
  bool isBool() const { return kind == Kind::Bool; }

  const Value* get(const std::string& key) const {
    if (!isObject()) return nullptr;
    for (auto& [k, v] : *o) if (k == key) return &v;
    return nullptr;
  }
  Value* get(const std::string& key) {
    if (!isObject()) return nullptr;
    for (auto& [k, v] : *o) if (k == key) return &v;
    return nullptr;
  }
  void set(const std::string& key, Value v) {
    if (Value* existing = get(key)) *existing = std::move(v);
    else o->emplace_back(key, std::move(v));
  }
};

class Parser {
 public:
  explicit Parser(const std::string& text) : t(text) {}

  bool parse(Value& out) {
    ws();
    if (!value(out, 0)) return false;
    ws();
    return i == t.size();
  }

 private:
  const std::string& t;
  size_t i = 0;

  void ws() { while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) ++i; }
  bool lit(const char* w) {
    size_t n = strlen(w);
    if (t.compare(i, n, w) != 0) return false;
    i += n;
    return true;
  }

  bool value(Value& out, int depth) {
    if (depth > 64 || i >= t.size()) return false;
    char c = t[i];
    if (c == '{') return object(out, depth);
    if (c == '[') return array(out, depth);
    if (c == '"') { out.kind = Value::Kind::String; return string(out.s); }
    if (lit("true")) { out.kind = Value::Kind::Bool; out.b = true; return true; }
    if (lit("false")) { out.kind = Value::Kind::Bool; out.b = false; return true; }
    if (lit("null")) { out.kind = Value::Kind::Null; return true; }
    return number(out);
  }

  bool number(Value& out) {
    size_t start = i;
    if (i < t.size() && t[i] == '-') ++i;
    while (i < t.size() && (isdigit((unsigned char)t[i]) || t[i] == '.' || t[i] == 'e' || t[i] == 'E' || t[i] == '+' || t[i] == '-')) ++i;
    if (i == start) return false;
    out.kind = Value::Kind::Number;
    out.n = strtod(t.substr(start, i - start).c_str(), nullptr);
    return true;
  }

  static void utf8(std::string& s, unsigned cp) {
    if (cp < 0x80) s += (char)cp;
    else if (cp < 0x800) { s += (char)(0xC0 | (cp >> 6)); s += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { s += (char)(0xE0 | (cp >> 12)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
    else { s += (char)(0xF0 | (cp >> 18)); s += (char)(0x80 | ((cp >> 12) & 0x3F)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
  }

  bool hex4(unsigned& cp) {
    if (i + 4 > t.size()) return false;
    cp = 0;
    for (int k = 0; k < 4; ++k) {
      char h = t[i++];
      cp <<= 4;
      if (h >= '0' && h <= '9') cp |= h - '0';
      else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10;
      else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10;
      else return false;
    }
    return true;
  }

  bool string(std::string& out) {
    ++i;
    while (i < t.size()) {
      char c = t[i++];
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (i >= t.size()) return false;
      char e = t[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= t.size() && t[i] == '\\' && t[i + 1] == 'u') {
            i += 2;
            unsigned lo;
            if (!hex4(lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool array(Value& out, int depth) {
    ++i;
    out.kind = Value::Kind::Array;
    out.a = std::make_shared<Array>();
    ws();
    if (i < t.size() && t[i] == ']') { ++i; return true; }
    for (;;) {
      Value v;
      ws();
      if (!value(v, depth + 1)) return false;
      out.a->push_back(std::move(v));
      ws();
      if (i < t.size() && t[i] == ',') { ++i; continue; }
      if (i < t.size() && t[i] == ']') { ++i; return true; }
      return false;
    }
  }

  bool object(Value& out, int depth) {
    ++i;
    out.kind = Value::Kind::Object;
    out.o = std::make_shared<Object>();
    ws();
    if (i < t.size() && t[i] == '}') { ++i; return true; }
    for (;;) {
      ws();
      if (i >= t.size() || t[i] != '"') return false;
      std::string key;
      if (!string(key)) return false;
      ws();
      if (i >= t.size() || t[i] != ':') return false;
      ++i;
      ws();
      Value v;
      if (!value(v, depth + 1)) return false;
      out.o->emplace_back(std::move(key), std::move(v));
      ws();
      if (i < t.size() && t[i] == ',') { ++i; continue; }
      if (i < t.size() && t[i] == '}') { ++i; return true; }
      return false;
    }
  }
};

inline bool parse(const std::string& text, Value& out) {
  // A UTF-8 byte order mark is not JSON, but editors write one.
  if (text.size() >= 3 && (unsigned char)text[0] == 0xEF && (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) {
    return Parser(text.substr(3)).parse(out);
  }
  return Parser(text).parse(out);
}

inline std::string quote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += (char)c;
        }
    }
  }
  return out + "\"";
}

/** Serialized with tabs, the way Unreal writes its descriptors. */
inline void write(const Value& v, std::string& out, int indent = 0, bool pretty = true) {
  auto nl = [&](int d) {
    if (!pretty) return;
    out += "\n";
    out.append(d, '\t');
  };
  switch (v.kind) {
    case Value::Kind::Null: out += "null"; break;
    case Value::Kind::Bool: out += v.b ? "true" : "false"; break;
    case Value::Kind::Number: {
      char buf[64];
      if (v.n == (double)(long long)v.n) snprintf(buf, sizeof buf, "%lld", (long long)v.n);
      else snprintf(buf, sizeof buf, "%.17g", v.n);
      out += buf;
      break;
    }
    case Value::Kind::String: out += quote(v.s); break;
    case Value::Kind::Array: {
      out += "[";
      for (size_t k = 0; k < v.a->size(); ++k) {
        if (k) out += ",";
        nl(indent + 1);
        write((*v.a)[k], out, indent + 1, pretty);
      }
      if (!v.a->empty()) nl(indent);
      out += "]";
      break;
    }
    case Value::Kind::Object: {
      out += "{";
      bool first = true;
      for (auto& [k, item] : *v.o) {
        if (!first) out += ",";
        first = false;
        nl(indent + 1);
        out += quote(k);
        out += pretty ? ": " : ":";
        write(item, out, indent + 1, pretty);
      }
      if (!v.o->empty()) nl(indent);
      out += "}";
      break;
    }
  }
}

}  // namespace json
