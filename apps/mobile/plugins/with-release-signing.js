// Signs release builds with the keystore named by environment variables, so no
// path or password is ever written into the generated project or into git.
// UEMCP_KEYSTORE, UEMCP_KEYSTORE_PASSWORD, UEMCP_KEY_ALIAS, UEMCP_KEY_PASSWORD.
const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const BLOCK = `
        release {
            if (System.getenv("UEMCP_KEYSTORE")) {
                storeFile file(System.getenv("UEMCP_KEYSTORE"))
                storePassword System.getenv("UEMCP_KEYSTORE_PASSWORD")
                keyAlias System.getenv("UEMCP_KEY_ALIAS")
                keyPassword System.getenv("UEMCP_KEY_PASSWORD") ?: System.getenv("UEMCP_KEYSTORE_PASSWORD")
            }
        }`;

module.exports = function withReleaseSigning(config) {
  config = withAppBuildGradle(config, (c) => {
    let src = c.modResults.contents;
    if (!src.includes("UEMCP_KEYSTORE")) {
      src = src.replace(/signingConfigs \{/, (m) => m + BLOCK);
      src = src.replace(
        /(release \{[^}]*?)signingConfig signingConfigs\.debug/,
        '$1signingConfig System.getenv("UEMCP_KEYSTORE") ? signingConfigs.release : signingConfigs.debug',
      );
    }
    c.modResults.contents = src;
    return c;
  });
  return withGradleProperties(config, (c) => {
    const set = (key, value) => {
      const item = c.modResults.find((p) => p.type === "property" && p.key === key);
      if (item) item.value = value;
      else c.modResults.push({ type: "property", key, value });
    };
    // 64-bit phones only: no 32-bit or emulator builds, which keeps the APK small enough to send.
    set("reactNativeArchitectures", "arm64-v8a");
    set("android.enableMinifyInReleaseBuilds", "true");
    set("android.enableShrinkResourcesInReleaseBuilds", "true");
    return c;
  });
};
