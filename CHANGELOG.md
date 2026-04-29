# Changelog

All notable changes to R3write will be recorded here. Newest first.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Styled rendered output in the quick-edit popup.**
  - The LLM is now allowed (and prompted) to use Markdown when the rewrite is naturally structured: blank-line-separated paragraphs, bullet/numbered lists, `**bold**` / `*italic*` emphasis, headings, blockquotes, and `inline code`. Single-sentence inputs stay unformatted.
  - The popup renders the reply via `marked` → `DOMPurify` (XSS-sanitised) and styles it with the existing `.tiptap` prose rules extended to a shared `.prose-r3w` class, so the popup matches the bundled editor visually.
  - Reply view is now a three-state toggle — **Rendered** (default), **Diff**, **Source** (raw Markdown).
  - **Diff** view strips Markdown from the rewrite before doing the inline word diff, so `**` / `*` / `#` markers no longer light up as additions against a plain-text original.
  - **Accept & paste** strips Markdown to clean prose before writing to the clipboard, so external paste-back is `item` / `bold` rather than `* item` / `**bold**`. The same stripped form is recorded in history.
  - New deps: `marked`, `dompurify`, `@types/dompurify`.
- **Richer "thinking" indicator while streaming.** Replaces the bare `Thinking…` text with a spinner, a phrase that rotates with elapsed time (`Thinking → Generating → Working on it → Still working — large input?`), animated dots, the active model name, and a live tenths-of-a-second elapsed timer. Disappears the moment the first token arrives; the existing `▍` caret then takes over for in-stream feedback.

### Fixed
- **Cross-window history broadcast.** The popup now emits `history:add` with `emitTo("main", …)` (explicit cross-window target) plus a `emit(…)` fallback, and surfaces failures via `console.error` instead of swallowing them. Accepted popup rewrites now reliably show up in the main window's History panel.

- **Multi-turn refinement in the quick-edit popup.**
  - The popup now shows a thread of turns: the initial action (Improve / Tone / Custom / etc.) and any follow-ups the user types.
  - After the first response is `ready`, a "Follow up…" input appears under the thread. Press Enter (or click Send) to send a refinement — e.g. "more concise", "less formal", "drop the second sentence". The full conversation is sent to Ollama on each turn so the model has context.
  - **Regenerate** redoes only the last turn; **Accept** pastes the latest assistant reply into the originating app; **Reject / Cancel / Esc** dismisses the whole thread.
  - The thread resets each time the popup is re-invoked with `Ctrl+Alt+G`.
  - History records the original selection, the FIRST action, and the FINAL accepted reply (intermediate turns are not persisted).
  - Quick-edit window grew to **520×520** with `minWidth: 420`, `minHeight: 360`, and `resizable: true` so the thread has room.
  - `OllamaClient` gained a `chat(messages, opts)` primitive; the existing `rewrite()` is now a thin wrapper that builds the initial messages array and delegates to `chat()`.
- **Milestone 5 (in progress) — system tray + window-to-tray + draggable popup + cross-window history.**
  - System tray icon (`tauri::tray::TrayIconBuilder`) with menu **Show R3write / Quick edit (Ctrl+Alt+G) / Quit**. Left-clicking the tray icon shows and focuses the main window.
  - Closing the main window now hides it to the tray instead of exiting; the global shortcut and tray remain alive in the background. Use the tray's **Quit** entry to actually exit.
  - The frameless quick-edit popup is now draggable: the header bar is a `data-tauri-drag-region`, with the close button stopping mousedown propagation so it still dismisses cleanly.
  - Quick-edit accepts now broadcast a `history:add` Tauri event with `{ id, timestamp, action, original, rewrite }`. The main window listens and appends to history, so popup rewrites are recorded alongside in-editor ones.
  - History persists to `localStorage` under `r3write.history.v1` (capped at 20 entries) and is restored on launch.

### Changed
- **In-editor `BubbleMenu` removed from the main editor render.** The system-wide `Ctrl+Alt+G` popup is now the only rewrite surface — it works inside the bundled editor as well as every other app, so the in-editor bubble was redundant. The dead bubble state, callbacks, and `BubbleContent` component were dropped from `App()`.

### Fixed
- **`Ctrl+Alt+G` capture no longer returns stale clipboard text.**
  - Before triggering the synthetic `Ctrl+C`, we release any user-held modifiers (`Ctrl`, `Alt`, `Shift`, `Meta`) so Windows sees a plain `Ctrl+C` instead of `Ctrl+Alt+C` (which was a no-op on most apps and the root cause of "selection_len=0" on press).
  - Added a clipboard sentinel: write a unique marker to the clipboard before the synthetic copy. If the marker is still there afterwards, the OS-level copy was a no-op and we treat it as "no selection" rather than feeding old clipboard contents to the LLM.
  - Original clipboard is restored in all paths (success, no-selection, error) so the user's clipboard is never left holding the sentinel or the captured selection.
  - Stderr logging surfaces shortcut registration outcome and `selection_len` per trigger for diagnostics.

### Added
- **Diff preview before Accept (in-editor BubbleMenu and quick-edit popup).**
  - Word-level diff (via `diff` package's `diffWordsWithSpace`) shown as the default `ready`-phase view: removals struck through in red, additions highlighted in green.
  - "Show plain / Show diff" toggle on the bubble lets you flip to the raw rewrite.
  - `originalText` is captured at action start and threaded into the bubble props.
- **In-app rewrite history with one-click Revert (main editor only).**
  - Last 20 accepted rewrites kept in memory: `{ id, timestamp, action, original, rewrite }`.
  - History button in the header opens a modal listing each entry with its action label, time-ago timestamp, inline diff, and a Revert button.
  - Revert finds the rewrite text in the current document via `findTextRangeInDoc` (a PM-doc walk that builds a text+positions map) and replaces it with the original. Refuses to revert if the rewrite no longer appears or appears more than once.
  - Quick-edit popup writes to other apps, so it relies on the host app's native undo and is not tracked here.
- **README.md** — top-level docs covering features, stack, prerequisites, run/build steps, settings, layout, and known limitations.
- **Milestone 4 — Global shortcut + system-wide quick-edit popup.**
  - New frameless `quick-edit` window (always-on-top, no taskbar icon, hidden until invoked) declared in `tauri.conf.json`.
  - Global shortcut **Ctrl+Alt+G** registered via `tauri-plugin-global-shortcut`.
  - Trigger flow (Rust): save current clipboard → simulate `Ctrl+C` (via `enigo`) → read selection from clipboard → bail if empty → position popup at cursor and emit `captured-text` event.
  - `accept_rewrite` Tauri command: hide popup, wait for focus to return to the originating app, write rewrite to clipboard, simulate `Ctrl+V`, then restore the original clipboard contents.
  - `dismiss_popup` Tauri command (Esc / Reject) restores the original clipboard without pasting.
  - `QuickEdit` React component in `src/main.tsx` shares `OllamaClient` + settings with the main editor; window-aware routing in `main.tsx` decides which UI to render based on `getCurrentWebviewWindow().label`.
  - Capability allowlist extended to both windows and includes `clipboard-manager:default` and `global-shortcut:default`.
- **Milestone 3 — Ollama integration (cloud + local).**
  - Replaced `MockLLM` with `OllamaClient` (same `LLMClient` interface) speaking Ollama's `/api/chat` NDJSON streaming protocol.
  - Default provider: **Ollama Cloud**, default model: **`gemma4:31b-cloud`**. Local mode swaps to `http://localhost:11434` and `llama3.2`.
  - Per-action prompt templates centralised in `actionInstruction()`; system prompt enforces "rewritten text only, no preamble".
  - HTTP traffic routed through `tauri-plugin-http` (Rust) so CORS does not apply to either local Ollama or Ollama Cloud.
  - Capability file `src-tauri/capabilities/default.json` allowlists only `ollama.com`, `*.ollama.com`, and `localhost:11434` / `127.0.0.1:11434` for `http:default`.
  - Settings modal: provider toggle, base URL, model name, API key (cloud only). Persisted to `localStorage` under `r3write.settings.v1`. Selecting a provider auto-fills its default base URL + model.
  - Bubble error state now renders the upstream error message from Ollama.
- **Milestone 2 — Tiptap BubbleMenu + mock LLM rewrite flow.**
  - Selection-driven `BubbleMenu` with primary actions (Improve, Fix grammar, Shorten, Expand), a Tone submenu (Professional / Casual / Friendly / Confident), and a Custom prompt input.
  - State machine inside the bubble: `idle` → `streaming` → `ready` (or `error`), with Accept / Reject / Regenerate / Cancel.
  - `LLMClient` interface declared in `src/main.tsx`; `MockLLM` ships a deterministic transform per action and yields chunks every ~25 ms to simulate streaming.
  - Selection range is captured at action start and re-applied on Accept so `insertContent` replaces exactly the original span even after focus shifts to the bubble.
  - `AbortController` cancels in-flight rewrites on Cancel / Reject / Regenerate.
- **Milestone 1 — initial scaffold.**
  - Tauri 2 + React + TypeScript + Vite scaffold targeting Windows.
  - Tailwind CSS v4 (no config file, uses `@tailwindcss/vite`).
  - Tiptap editor with `StarterKit` rendered in the main window.
  - Single-file React entry (`src/main.tsx`) hosting app shell and editor.
  - Single-file Rust entry (`src-tauri/src/main.rs`) with default Tauri builder.
  - Conventions: flat folder layout (`src/` frontend, `src-tauri/` Rust); every behavior change adds an entry to this file under `[Unreleased]`.

### Notes / TODO
- Bundle icons are placeholders; run `npx @tauri-apps/cli icon <source.png>` before `tauri build` for production icons.
- API key currently lives in `localStorage`; will move to Windows Credential Manager (via the `keyring` crate) before shipping.
- Quick-edit relies on the OS giving focus back to the originating app between popup hide and `Ctrl+V`. A 90 ms sleep covers most cases; flaky in apps that delay focus restoration. UI Automation backend can replace this for problem apps later.
- Code-signing the installer is still TODO (Azure Trusted Signing recommended).
- Milestone 5 (proposed): tray icon + autostart + single-instance lock + auto-update.
