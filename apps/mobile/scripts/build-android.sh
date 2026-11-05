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
# Prebuild only when the native config changed (app.json, the config plugins, the native
# dependencies), and never --clean: android/ keeps .cxx, build/ and the CMake output, so a JS or UI
# change rebuilds only the bundle and the APK.
native="$(cat app.json package.json plugins/*.js | sha256sum | cut -c1-16)"
if [ ! -d android ] || [ "$(cat android/.native-config 2>/dev/null)" != "$native" ]; then
  npx expo prebuild -p android --no-install
  printf '%s\n' "$native" > android/.native-config
fi
cd android
# CMake 3.22 ships a ninja that fails on paths past MAX_PATH, which the monorepo's
# nested expo-modules-core reaches: build with the newest CMake 3 installed.
cmake_dir="$(ls -d "$ANDROID_HOME"/cmake/3.* 2>/dev/null | sort -V | tail -1)"
if [ -n "$cmake_dir" ]; then
  printf 'cmake.dir=%s\n' "$(cygpath -m "$cmake_dir" 2>/dev/null || echo "$cmake_dir")" > local.properties
fi
# Within a 6 GB budget: one Gradle worker, native compiles capped at NATIVE_JOBS (2), no daemon left
# running. If the build fails, it is tried once more with one native job.
export NATIVE_JOBS="${NATIVE_JOBS:-2}" CMAKE_BUILD_PARALLEL_LEVEL="${NATIVE_JOBS:-2}"
build() { ./gradlew assembleRelease --console=plain --no-daemon --build-cache -I ../scripts/cmake-jobs.init.gradle -Dorg.gradle.workers.max="${GRADLE_WORKERS:-1}"; }
build || { echo "build failed; once more with one native job"; NATIVE_JOBS=1 CMAKE_BUILD_PARALLEL_LEVEL=1 build; }
