# UE-MCP Studio for Android

The Studio client as a native app (React Native, Expo SDK 58, Hermes), for a phone paired with a computer through the relay. It is the paired browser's Studio, drawn natively: the same screens, the same rules from `packages/client-core` and `packages/shared`, the same end-to-end sealing from `packages/remote`. It adds a native way in (scan a pairing code, share to the app, shortcuts) and never takes the browser's: it claims no https link on the relay's host.

Every user-facing change to `apps/client-web` ships with its counterpart here in the same pull request, or a recorded exception. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md); `apps/mobile/test/parity-gate.test.ts` enforces it in `npm test`.

## Layout

- `App.tsx`: the entry. Pairing, projects, About, and a project's shell.
- `src/relay.ts`: pairing and the sealed transport to a computer through the relay.
- `src/AppShell.tsx`, `src/views/`, `src/screens/`: the screens. `src/screens/chat/README.md` has the chat's layout and its owners.
- `src/ui/`: the component library, the web client's three themes and fonts.
- `src/native/`: the native pieces (biometrics, haptics, share, shortcuts, keyboard, network), each with a `.web` variant for tests and the visual QA page.
- `visual-qa/`: the app on react-native-web against the web client's fixture daemon; `parity.ts` is the inventory of every web scenario and what the phone does with it.
- `ui-test/`: component tests (`npx vitest run --project mobile-ui`).

## Building the APK

`scripts/build-android.sh` makes a signed release APK locally. It reads the keystore passwords from the file `UEMCP_PASSWORDS_ENV` names, which stays outside git, and passes them to Gradle as environment variables.

```bash
UEMCP_PASSWORDS_ENV=/path/to/passwords.env bash apps/mobile/scripts/build-android.sh
```

- It prebuilds only when `app.json` (apart from its version), `package.json` or a config plugin changed, and never cleans, so a JS or UI change rebuilds in a few minutes.
- It stays within about 6 GB: one Gradle worker, a 2 GB JVM, Kotlin compiled in it, two native compile jobs (`scripts/cmake-jobs.init.gradle`), no daemon left running.
- arm64 only, minified, native libraries compressed: about 23 MB.

## Not done yet

- The web client still has its own same-origin event stream (`apps/client-web/src/api.ts` `subscribeEvents`, `daemonIdentity`, `notThere`); the app uses client-core's. Moving the web onto client-core's removes the last exceptions in the parity gate.
- iOS.
