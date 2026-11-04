#!/usr/bin/env bash
# Local signed release APK, no Expo account. Reads the keystore passwords from
# UEMCP_PASSWORDS_ENV (a passwords.env file kept outside git) and passes them to
# Gradle as environment variables only.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
envfile="${UEMCP_PASSWORDS_ENV:?set UEMCP_PASSWORDS_ENV to the passwords.env path}"
set -a; . "$envfile"; set +a
export UEMCP_KEYSTORE="${UEMCP_KEYSTORE:-$(dirname "$envfile")/ue-mcp-studio-release.jks}"
export UEMCP_KEYSTORE_PASSWORD="$BUBBLEWRAP_KEYSTORE_PASSWORD"
export UEMCP_KEY_PASSWORD="$BUBBLEWRAP_KEY_PASSWORD"
export UEMCP_KEY_ALIAS="${KEY_ALIAS:-uemcp-studio}"
export JAVA_HOME="${JAVA_HOME_17:-$LOCALAPPDATA/Android/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
cd "$here"
[ -d android ] || npx expo prebuild -p android --no-install
cd android
# CMake 3.22 ships a ninja that fails on paths past MAX_PATH, which the monorepo's
# nested expo-modules-core reaches: build with the newest CMake 3 installed.
cmake_dir="$(ls -d "$ANDROID_HOME"/cmake/3.* 2>/dev/null | sort -V | tail -1)"
if [ -n "$cmake_dir" ]; then
  printf 'cmake.dir=%s\n' "$(cygpath -m "$cmake_dir" 2>/dev/null || echo "$cmake_dir")" > local.properties
fi
./gradlew assembleRelease --console=plain
