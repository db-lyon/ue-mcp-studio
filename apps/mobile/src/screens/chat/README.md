# Chat area: where things live and the interfaces between them

The app ports the web client one file to one file: `apps/client-web/src/chat/X.tsx` becomes a mobile file with the **same exported names and the same props** (DOM-only props adapted). Those props are the interfaces; a port that keeps them drops into the rest without changes elsewhere. Read the web file for the full prop list.

## Layout

| Part | Mobile path | Owner |
|---|---|---|
| Chat orchestration (list or open session, session sync, events, send/queue/stop, where every card goes) | `src/views/Chat.tsx` (`Chat`) | integrator (chat-core) |
| Sessions list, row menu (rename, archive, delete), header, threads and subagent tiles, queue, sheet, skeletons | `src/chat/SessionRow.tsx`, `ChatHeader.tsx`, `Threads.tsx`, `Queue.tsx`, `Sheet.tsx`, `Skeleton.tsx` | integrator (chat-core) |
| Transcript container (messages, markdown and code, asset links and tiles, attachments, tool rows and lazy results, progress folding, subagent threads, streaming, new-messages pill) | `src/chat/Transcript.tsx` (`MainTranscript`, `SubagentThread`), `AssetLink.tsx`, `AssetTile.tsx`; markdown in `src/ui/Markdown.tsx` | integrator (transcript) |
| Transcript item cards | `src/screens/chat/items/` | area-c |
| Composer and pickers | `src/screens/chat/composer/` (moved from `src/chat/Composer.tsx` and friends) | area-d |
| Shell (bar, drawer, banners, overlays, lock) | `src/AppShell.tsx`, `src/views/*` | integrator |

## Item renderer interface (area-c)

`MainTranscript` draws each main-thread entry (client-core's `mainTimeline`) and hands the card kinds to these components, exactly as the web `Transcript.tsx` does:

| Entry | Component and props |
|---|---|
| `kind: "review"` | `TurnReviewCard({ review: TurnReview })`, session id from `SessionIdContext` |
| `kind: "compaction"` | `CompactionMarker({ entry })` |
| `kind: "dialog"` (ended) | `DialogLine({ dialog: EditorDialog })` |

`views/Chat.tsx` places the waiting cards below the transcript, above the composer, in the web order:

| Card | Component and props |
|---|---|
| Open editor dialogs of this session | `DialogCards({ dialogs: EditorDialog[], now: number })` |
| Calls waiting for approval | `Approvals({ sessionId: string, approvals: ApprovalRequest[] })` |
| Forms ue-mcp raised | `FormCards({ forms: PendingForm[], runs: QaRun[] })` |
| Checkpoints (opened from the header) | `ReviewPanel({ sessionId, review, timeline, onChanged })` in a `Sheet` |

Area-c exports these names from `src/screens/chat/items/index.ts`; Chat and Transcript import them from there. Until then they import from the current paths and stubs.

## Composer slots (area-d)

`views/Chat.tsx` renders, in this order under the cards:

- `PillRow({ pills, actions, onClear })`
- `Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onSendNow, onStop, files, onAddFiles, onRemoveFile, picker, extras, stage, height, onHeight, commands, flows, actions, mentions, children })`, where `picker` is `<ModelAndEffort settings onSettings />` plus `<ContextMeter ... />` and `files`/`onAddFiles` take `PickedFile[]` from `useAttachments()` (share-to-app adds through the same `onAddFiles`)
- `FlowLauncher({ text, run, onClose })` and `ActionLauncher({ text, run, onClose })` above it while a `/flow` or `/action` is being filled in
- `ContextWarning({ view, runtime, busy, onCompact, onDismiss })` above the pills when the context is high

Area-d exports these names from `src/screens/chat/composer/index.ts`.

## Shared pieces

- Theme, fonts and controls: `src/ui` (`useTheme().c.*`, `T`, `font()`, `labelFont()`, `Button`, `Card`, `Banner`, `Label`, `Chip`, `Pill`, `Dot`, `Input`, `Seg`, `Check`, `Row`, `Sheet`, `Output`, `DiffView`, `Markdown`, `Spinner`, `RemoveButton`). Add a primitive as a new file plus one export line in `src/ui/index.ts`.
- Daemon calls: `useProjectNav().api` (`studioApi` in `packages/client-core/src/studio-api.ts`); events: `project.onEvent`. Pure logic shared with the web client goes in `packages/client-core`.
- Native: `src/native/haptics.ts` (`haptic.tap/select/success/warning/error`), `keyboard.tsx` (`KeyboardAvoidingView`, `KeyboardStickyView`), `share.tsx` (`useSharedFiles`), `shortcuts.ts` (`publishRecentSessions`), each with a `.web` variant for the harness and tests.
- Verification: `scripts/parity-mobile.mjs` against `scripts/visual-qa.mjs --remote --widths 390`; scenario owners in `apps/mobile/visual-qa/parity.ts`; component tests in `apps/mobile/ui-test`.

## Text metrics

The bundled TTFs and the web's variable woff2 files lay out identically (same advance widths and line boxes); what differed was arithmetic and antialiasing.

- **Line heights.** A CSS multiple (`12px/1.6`) is laid out at the product cut down to Chrome's 1/64 px unit; a px value (`19.2px`) is rounded to it, so passing the raw product drifts a pixel over a long page. Write a multiple from the CSS through `font(t, role, weight, size, lh)` or `lineBox(size, lh)`, never `size * lh`. `t.base.lineHeight` and `t.label.lineHeight` are already laid out this way. Write a px line height from the CSS as is.
- **`line-height: normal`.** A `font` shorthand with no line height (`.md code { font: 12px var(--mono) }`) resets it to the font's own: use `monoNormal(t, size)`, not the parent's. Inline code (`inlineCode(t)`) does.
- **Buttons.** `button` gives everything inside it `letter-spacing: 0.02em` at the button's own font size (0.24 px at 12 px); the editor themes' `button` rule (`400 12px/1.2` sans, no spacing) outranks most class rules that set a font on a button. Check the computed style, not the class rule alone.
- **Antialiasing in the harness.** Chrome draws text greyscale on a GPU layer without an opaque background, subpixel elsewhere. The harness drops react-native-web's `translateZ(0)` on ScrollViews (`visual-qa/main.tsx`); a scrolling list over a panel paints that panel (`backgroundColor: t.c.panel`), as the transcript does. Text the web composites itself (the blurred top bar, `.empty`'s scroller in the editor themes) stays greyscale there and subpixel in the app.
- **Glyphs.** Draw the web's svg icons with `react-native-svg` from the same path data, not from bordered views.
