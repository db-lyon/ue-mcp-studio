// Keeps react-native-webrtc's Java classes through R8. The library reaches org.webrtc from
// native code by name, and its prebuilt AAR references classes it does not ship (the dav1d
// decoder's JNI natives), so a minified release build fails without these rules.
const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const MARK = "# react-native-webrtc";
const RULES = `
${MARK}
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
`;

module.exports = function withWebrtcProguard(config) {
  return withDangerousMod(config, [
    "android",
    async (c) => {
      const file = path.join(c.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
      const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!src.includes(MARK)) fs.writeFileSync(file, src + RULES);
      return c;
    },
  ]);
};
