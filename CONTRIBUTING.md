# Contributing

See [`CLAUDE.md`](CLAUDE.md) for the layout, the rule about depending on ue-mcp, signing and releases.

## One client, three places

Studio runs in three places that move together, with the same features in each, allowing for what each place can and cannot do:

- in the editor (the in-editor host and `studio-window.exe`, `apps/client-web` served by the daemon),
- in a paired browser (the same `apps/client-web` through the relay),
- in the Android app (`apps/mobile`).

So every user-facing change to `apps/client-web` ships with its `apps/mobile` counterpart in the same pull request. If the phone cannot have it, or it has to follow in a later pull request, the pull request says so and records it as an exception (below). There is no separate mobile branch: mobile work happens on `main` like everything else.

### What enforces it

`npm test` runs `apps/mobile/test/parity-gate.test.ts`, which fails when:

- a client-web visual QA scenario has no entry in `apps/mobile/visual-qa/parity.ts`. Each entry names the area that ports the scenario, or gives `notOnPhone` and the reason a paired phone never shows it. A new web view therefore needs its phone counterpart, or a stated exception, before the suite passes.
- an entry names a scenario the web client no longer has.
- `apps/client-web` or `apps/mobile` defines its own function, constant or class under a name `packages/client-core` or `packages/shared` exports. Logic and strings both clients use live in those packages and are imported, never copied. The few names that only coincide are listed in the test's `EXCEPTIONS`, each with its reason, and the test fails when one goes stale.

### Where shared code goes

- `packages/shared`: types and pure rules shared by the agent and the clients.
- `packages/client-core`: everything both clients do that is not drawing: the transport, the event stream and connection states, the lock, session sync, the chat and review models, copy (dialogs, approvals, errors). No React, no DOM, no React Native.
- `apps/client-web` and `apps/mobile` only draw, each in its own toolkit.

### Checking a change on the phone

- `node scripts/parity-mobile.mjs --web <dir>` shoots the phone's screens beside the web client's at 390 pixels and reports the difference per scenario (references from `node scripts/visual-qa.mjs --remote --grayscale-text --widths 390 --out <dir>`).
- `npx vitest run --project mobile-ui` runs the app's component tests. Their React Native fails where Android does: text outside `<Text>`, and an `accessibilityRole` Android does not accept.
- `node scripts/e2e-mobile-live.mjs --skip-live` runs the app's real entry against a fake relay; without `--skip-live` it pairs with a real project through the relay. `apps/mobile/README.md` has the rest, including Android builds.
