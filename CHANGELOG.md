# Changelog

All notable changes to R3write will be recorded here. Newest first.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.5.0] - 2026-08-13

### Added
- **System-wide autocorrect — engine (Phase 1).** A `WH_KEYBOARD_LL` hook watches typing in allowlisted applications; when a word is committed with a space, punctuation or Enter, a bundled SymSpell dictionary (82,833 entries, fully offline) decides whether it is a typo and replaces it in place. Off by default, and the hook is never installed until the frontend confirms both an active license and an explicit opt-in. No UI yet — Settings, the correction bubble, and the log panel land in Phases 2–4.
  - Correction fires only where a candidate is at least 10x more frequent than the runner-up. `teh` → `the` qualifies; genuinely ambiguous typos like `cta` (cat/act) are left alone.
  - Capitalisation is carried onto the correction, so a sentence-initial `Teh` becomes `The`.
  - Corrections are logged to `autocorrect-log.json` in the app data dir. **Raw keystrokes are never persisted** — the typing buffer is in memory, capped, and cleared on every invalidation.

- **Add applications by picking them, not by typing executable names.** Settings → Autocorrect gains an **Add application…** button listing currently-running windowed applications by name, so enabling Outlook is a click rather than knowing it is `outlook.exe`. The shipped allowlist now covers the native prose editors: `notepad.exe`, `wordpad.exe`, `winword.exe`, `outlook.exe`.
- **Terminals can be added, and now say what that costs.** Adding a console host (`cmd.exe`, `powershell.exe`, `WindowsTerminal.exe`, `wsl.exe`, `ssh.exe`, …) shows an explicit warning, and they are flagged in the picker. Two risks apply there and nowhere else: a shell password prompt is not a password *field*, so neither `ES_PASSWORD` nor UI Automation has anything to detect and what you type at a `sudo` or `ssh` prompt is read like ordinary text; and Enter runs the line, so a correction landing on a command, path or flag executes something you did not type. They stay out of the default list.
  - The previous Settings copy claimed terminals were "refused outright". They were not — the allowlist has no denylist behind it, so a typed-in `cmd.exe` always worked. The copy now describes what the code actually does.
- **Fixed: corrections could leave extra text behind.** `WH_KEYBOARD_LL` is a *pre-dispatch* hook — it sees the word-ending keystroke before the application does — while the correction runs on a separate thread. The replacement erases `word + delimiter`, so when that thread won the race the backspaces were queued while the delimiter was not yet on screen: one character too many was erased, taking a neighbouring character with it, and the user's space then arrived on top of the freshly typed correction. Corrections now wait 25ms for the delimiter to land, and anything typed during that wait bumps the hook's sequence counter and cancels the correction outright — so the wait costs at most a missed correction and never a wrong one.
- **Fixed: a correction on a word ended with Enter could join two lines.** The newline was re-injected as a `KEYEVENTF_UNICODE` control character, which most editors ignore, so the Enter that was erased with the word never came back. It is now sent as `VK_RETURN`.
- **Contextual arbitration for words the dictionary cannot judge (Phase 5).** Real-word errors (`form` for `from`, `their` for `there`) and plural morphology (`companys`) are spelled correctly, so the offline dictionary returns at distance 0 and the sentence stays wrong. When **Settings → Autocorrect → Ask the model about confusable words** is on, those specific words are sent to the configured provider with up to 80 characters of preceding context.
  - **Suggestion only. The model can never change text on its own.** A reply takes 300–2000ms, by which point the caret has moved, so the result appears in the bubble with an **Apply** button. Accepting re-verifies the target and erases and restores whatever was typed in the meantime, exactly as undo does.
  - **Off by default and separate from the master switch** — this is the one part of the feature that sends text off the machine, and the Settings copy names the provider it will go to.
  - Arbitration fires only for a short list of known confusables plus corrections suppressed as intended plurals — on the order of one word in a few hundred — and is debounced to at most one lookup every two seconds. Ordinary words are never sent.
  - Replies are constrained to a single word; anything else (an explanation, a phrase, an apology) is discarded rather than applied.
  - Rust detects the candidates but the request is made by the frontend, reusing the existing seven-provider client layer and its keyring-backed API keys rather than duplicating them.
- **Autocorrect ranks candidates by typo shape, not just word frequency.** Corrections are scored by corpus frequency weighted by the mechanical shape of the edit — transposition and doubled keystrokes are the commonest typing errors by a wide margin, adjacent-key slips next, arbitrary substitutions least. Ranking on frequency alone could not separate `use` from `see` for input `usee` (a 1.06% gap), and left `adn` → `and` and `cta` → `cat` just under the old 10x bar. Those now correct; genuinely ambiguous words still do not.
  - The dominance threshold dropped 10x → 3x, since shape weighting now carries most of the discrimination. It is checked against a two-sided corpus in the tests — typos that must be fixed, and correctly-spelled words that must be left alone — rather than chosen by argument, which is how both previous thresholds went wrong.
  - **Words that look like intended plurals are left alone rather than made singular.** `companys` used to become `company`: a real word, and the wrong one — it silently changes the meaning of the sentence, which is a quieter failure than leaving the misspelling. `companies` is two edits away where `company` is one, so edit distance can never reach it; that needs the contextual pass.
  - `cargo test probe_candidates -- --nocapture` prints candidates, scores and ratios for any word, for tuning against real reports.
- **Autocorrect hardening after review.** Ten defects found by a multi-agent review of the unreleased feature, fixed before first release:
  - **The password probe read focus before it moved.** A low-level hook sees Tab and mouse-down *before* the target application processes them, so re-probing at that moment re-read the field being left and then marked the verdict fresh for 1500ms — the exact tab-into-a-password-box case the code claimed to cover. The probe is now deferred by one event, and every correction re-resolves the target immediately before injecting.
  - **A disable/enable cycle could strand a live keyboard hook** that `uninstall` could no longer find, leaving it capturing keystrokes after the user switched autocorrect off. Install/uninstall are now serialised behind one lock and `uninstall` joins the pump thread rather than posting and hoping.
  - **The toast's Undo button never worked**: the global mouse hook fired on mouse-*down* and retired the undo before React's mouse-*up* handler ran. Clicks on R3write's own windows no longer invalidate anything.
  - **Undo destroyed text typed after a correction.** It now erases and restores those characters instead of backspacing through them.
  - **`Ctrl+Alt+Z` could swallow — and then unregister — a user-rebound main hotkey.** The user's own hotkeys are matched first, and a colliding combination is left strictly alone.
  - **Shifted punctuation was injected back as the wrong character** (`teh?` became `the/`). Character translation now uses `ToUnicodeEx` in its non-state-mutating mode instead of the unshifted-only `MapVirtualKeyW`.
  - **Modifier state was read with `GetKeyState`**, which reports the hook thread's own permanently-empty input queue, so `Ctrl+V` could classify as typing `v`. Now `GetAsyncKeyState`.
  - The ~1s dictionary load moved out of the commit path, and the staleness guard that could never fire was replaced with a real sequence check against the hook's event counter.
  - A word ended with **Tab** is never corrected — Tab always moves focus, so the replacement would land in the next field.
  - The correction log could render one entry twice when a correction arrived while its initial fetch was in flight.
- **Password-field detection via UI Automation (Phase 1b).** Chromium, Electron and Java draw their own text boxes inside a single window handle, so the Win32 `ES_PASSWORD` style cannot tell a password box from a search box in any of them. A UIA `IsPassword` probe now covers that gap. The two signals are combined so that **either** source claiming "password" refuses, and **neither** being able to answer also refuses — silence is never read as permission.
  - The probe runs on the autocorrect worker thread (never the keyboard hook — `GetFocusedElement` is a cross-process call, and a hook callback that overruns Windows' timeout is silently torn down).
  - It re-runs on the events that actually move focus — a mouse press, a Tab — because tabbing from a username box to a password box in the same page changes neither the process nor the window handle. A 1500ms backstop covers focus moves with no signal at all.
  - Keystrokes from a field R3write is not cleared for are no longer **buffered**, not merely left uncorrected.
- **Autocorrect settings + correction log (Phases 3–4).** A new **Autocorrect** tab in Settings (beside Glossary, whose protected terms it reuses) with the master switch, the bubble toggle, the application allowlist, the shortest word to correct, and log retention. The main window's panel header is now a switcher between **History** (rewrites you asked for) and **Autocorrect** (fixes that happened while you typed), the latter listing each correction newest-first with its app and a **Copy original** button.
  - The Settings copy states plainly what the feature does and what it refuses to do — terminals, password fields, elevated windows, remote desktop, IME/CJK, and for now browsers and Electron apps, since Windows only exposes "this is a password field" for native text boxes.
  - The log offers **Copy original**, not an in-place revert: by the time you are reading the list the caret has moved, and re-injecting would damage whatever now sits under it. In-place revert is the bubble's Undo and `Ctrl+Alt+Z`, both of which expire on purpose.
  - The installer checkbox seeds the enabled state on first run only, then marks itself seeded so it can never override a later choice made in Settings.
- **Autocorrect correction toast + undo (Phase 2).** A third frameless always-on-top window (`autocorrect-bubble`) appears in the bottom-right of the work area after a correction, showing `teh → the` with **Undo** and a dismiss button. It never takes focus (`SW_SHOWNOACTIVATE`), fades after 4s, and pauses that timer while the pointer is over it. **`Ctrl+Alt+Z`** reverts the last correction globally, whether or not the toast is still up.
  - There is no in-place underline, and there will not be one: R3write cannot draw inside another app's text field, and a caret-anchored overlay has no caret to anchor to in Chromium, Electron or Java apps.
  - The Undo affordance disappears exactly when it stops being safe — the undo is retired on any buffer invalidation *and on the next committed word*, and the toast is taken down with it.
  - Its own Vite entry, so the toast bundle is 3 kB and drags in none of the main window's Settings/history tree.
- **Installer opt-in for autocorrect.** A new "Optional features" page in the Windows installer, between the install-directory and start-menu steps, offers *Enable system-wide autocorrect*. It defaults to **unchecked** — a feature that reads keystrokes is never pre-ticked — and records the choice at `HKCU\Software\R3write\AutocorrectOptIn`. The choice seeds the first-run default in Settings; it is a preference, not a switch, and cannot by itself start the keyboard hook (that still needs an active license and an explicit enable).

- **AI transparency disclosures, in the app and on the site.** R3write is an AI system and is itself built with AI; neither was stated anywhere a user would actually look. Now:
  - The quick-edit popup carries a permanent `AI-generated · review before use` line in its footer — in the window chrome rather than a dismissible notice, because it has to hold for every rewrite and not just the first one.
  - A new **AI** tab in Settings (between Autocorrect and Advanced) names the provider and model currently in use, states what leaves the machine on that configuration, and reflects whether autocorrect's contextual check is on — the one path that sends text off the machine independently of the rewrite hotkey.
  - A full disclosure page at [`docs/ai-transparency.html`](https://drknowhow.github.io/R3write/ai-transparency.html): the three paths by which text can leave, whose terms apply once it arrives, which half of autocorrect is a language model and which is a dictionary, the fact that R3write was built with AI assistance, and the transparency duty that lands on *users* who publish AI-assisted text on matters of public interest (EU AI Act Art. 50(4)).
  - On machine-readable marking (Art. 50(2)): stated plainly rather than glossed. R3write pastes plain text through the clipboard, which carries no metadata channel that survives the paste, so no marker is embedded today. The exemption for "assistive function for standard editing" plausibly covers `Fix grammar` and the offline autocorrect but not `Improve` / `Expand` / `Tone`; the transitional deadline is 2 December 2026.
  - `capabilities/default.json` allows `https://drknowhow.github.io/*` so the in-app link to the disclosure actually opens. It is a distinct host from `github.com` and was not covered by the existing rule.
- **`docs/lemonsqueezy-product.md`** — paste-source for the Lemon Squeezy listing, mirroring `docs/sponsors-profile.md`. Product copy, long description, receipt text and a pre-save checklist, so the store page stops drifting from the release.

### Changed
- **The GitHub Pages site is rewritten for 1.5.0.** New autocorrect section (including what the feature refuses to do, which is the part worth trusting it for), an AI transparency section, and the version eyebrow moved off the stale `v1.4.0`. The `~3.6 MB` installer-size claim is gone rather than guessed at.
- **The NSIS installer template is now forked into `src-tauri/installer/`.** Tauri 2's template has no Components page and both finish-page checkbox slots were already used, so `bundle.windows.nsis.template` was the only supported way to add the opt-in page. A pristine upstream copy (`installer.upstream.nsi`, tauri-cli 2.10.1) sits beside it so Tauri upgrades stay a mechanical three-way merge — see `src-tauri/installer/README.md`.
- **All synthetic keyboard input now routes through one tagged chokepoint** (`autocorrect::inject`), replacing enigo. enigo cannot set `dwExtraInfo`, so with a keyboard hook installed the `Ctrl+C` in `capture_selection` and the `Ctrl+V` in `accept_rewrite` would have come back through the hook indistinguishable from the user typing — R3write's own quick-edit paste would have fed itself into the autocorrect buffer. Every event we synthesize now carries `R3W_INJECT_TAG`; the hook drops tagged events unconditionally, and treats *untagged* injected events as foreign input that invalidates the buffer.

### Removed
- **`enigo` dependency.** Superseded by direct `SendInput` calls through the tagged inject module.

## [1.4.1] - 2026-05-21

### Fixed
- **Quick-edit popup opening empty on the first hotkey press.** The async-first capture flow (introduced in 1.4.0) called `WebviewWindow::show()` on the previously-hidden popup, which on Windows resolves to `ShowWindow(SW_SHOW)` and activates the window — stealing focus from the source app before the capture thread sent Ctrl+C. The synthesized copy then landed in the empty webview instead of the user's selection, the clipboard sentinel survived, and the popup rendered with no input. The trigger path now shows the window via `ShowWindow(SW_SHOWNOACTIVATE)` (Windows-only path through the `windows` crate); the explicit `set_focus()` already in the capture thread still runs once capture finishes, so the popup grabs focus at the right moment.

## [1.4.0] - 2026-05-17

### Added
- **Lemon Squeezy license activation.** Hard gate on the main window and the quick-edit popup until a valid license key is entered. New **License** tab in Settings shows status (masked key, customer email, activations used / limit, last-validated timestamp) with **Re-validate** and **Deactivate this machine** controls. Activation calls `api.lemonsqueezy.com/v1/licenses/activate`; subsequent launches call `/validate`. License key and Lemon Squeezy `instance_id` live in Windows Credential Manager alongside the provider API keys. Offline `/validate` failures fall back to the cached active state so a paid user with a dropped connection isn't locked out; an explicit invalid response (refund, manual revoke) re-shows the gate.

### Changed
- **Dual distribution.** The Windows installer is published on **both** GitHub releases (free download — `releases/latest/download/R3write-setup.exe`) **and** the [Lemon Squeezy checkout](https://drknowhow.lemonsqueezy.com/checkout/buy/627f5ad5-2aa2-4503-b79a-245e53abdbb3) (pay what you want, $5 minimum). The binary is identical on both paths; what unlocks the app is the license key, which comes from Lemon Squeezy.
- **Hero site (`docs/`) + README.** Download buttons point to the GitHub installer; a secondary "Get activation key" button points to Lemon Squeezy. Install steps reflect the flow: install free, paste key on first launch.
- **`scripts/release.sh`.** Step 7 re-attaches the versioned + stable-named installers to the GitHub release and reminds the operator to also upload to Lemon Squeezy.

## [1.3.0] - 2026-05-17

### Added
- **Google Gemini provider.** Streams via `:streamGenerateContent?alt=sse` against the Generative Language API. Default model `gemini-2.5-flash` (most generous free tier of any major cloud LLM, no card required). Auth via `x-goog-api-key`; key stored in its own keyring entry like the other providers.
- **Provider tier taxonomy.** Every provider in Settings → Model is now tagged:
  - `Free` — Local Ollama (runs on your machine, no key).
  - `Free tier · BYO key` — Ollama Cloud, Gemini, Groq, OpenRouter (your own key, provider offers a free quota).
  - `BYO key` — OpenAI, Anthropic (your own key, paid to the provider).

  A one-line caption under the picker explains the three tiers. Provider dropdown is reordered so Free / Free-tier options surface first; the default remains Ollama Cloud for new installs.

## [1.2.1] - 2026-05-16

### Fixed
- **Quick-edit popup closing while being dragged.** With "Click outside to dismiss" enabled, the native window-drag operation produced a brief webview blur that was misread as the user clicking away. The blur handler now ignores blur cycles that occur during a mouse drag and defers the dismiss long enough for focus to return.
- **Settings dialog tab strip overflowing.** With seven tabs the horizontal `flex-1` strip clipped the longer labels and looked broken on the 480 px main window. Tabs now live in a 124 px vertical sidebar; the dialog widens up to 640 px when room allows and the content column scrolls independently.
- **Settings dialog perceived slow open.** The autostart status probe (`reg query` subprocess, 50–150 ms on Windows) is now deferred past the open animation so the dialog paints immediately and the toggle hydrates after.

## [1.2.0] - 2026-05-16

### Added
- **Multi-provider support.** New providers alongside Ollama: OpenAI, Anthropic, Groq, OpenRouter. Each gets its own keyring entry (`r3write-api-key-<provider>`), so switching providers doesn't blow away the others' keys. Provider catalog drives the Settings picker, the StatusPill label, and the API-key placeholder hint. Legacy `provider: "cloud" | "local"` is migrated to `"ollama-cloud" | "ollama-local"` on load.
- **Live health pill.** The header status pill now polls the active provider every 60s (`/api/tags` for Ollama, `/v1/models` for OpenAI-style, a 1-token probe for Anthropic) and renders a colored dot — green/amber/red/unknown — with a tooltip and latency. Clicking it opens Settings.
- **Repeat-last-action hotkey.** Press the main hotkey with Shift held (default `Ctrl+Alt+Shift+G`) to skip the picker and rerun the last action on the new selection. Custom prompts replay the most recent custom prompt verbatim.
- **First-run onboarding.** New dialog appears once on first launch with a 4-step walkthrough and a one-click jump to Settings. Tracked via `settings.hasOnboarded`.
- **Saved templates.** Settings → Templates lets you save named custom prompts. They surface in the popup as a `Templates` dropdown next to `Tone` / `Prompt` / `Custom…`.
- **Recent custom prompts.** Custom prompts are remembered (most-recent 12) and surface as quick-replay chips beneath the custom-prompt input.
- **Style guide + protected terms.** Settings → Glossary lets you paste a persistent style guide (appended to every system prompt) and a list of protected terms the model must keep verbatim — names, identifiers, brand strings.
- **Paste-as toggle.** Popup footer adds a `Plain | MD` toggle: `Plain` strips Markdown on Accept (existing behavior), `MD` pastes Markdown verbatim for destinations like Slack, Discord, or code editors. Choice persists.
- **Export history.** Settings → Advanced exports the saved history as `.json` or `.md`.
- **Autostart at login.** Settings → Advanced toggles a Windows per-user autostart entry (`HKCU\…\Run`), wired through new `autostart_set` / `autostart_get` Tauri commands.
- **Click-outside dismiss.** Window-blur dismisses the popup unless mid-stream. Toggleable in Settings → Advanced; Esc always works.
- **Expandable Original pane.** Toggle the popup's `Original` between collapsed (~2 lines) and expanded (~5 lines); preference persists.
- **Token estimate.** Popup shows word count and an approximate token count for the selection.
- **Persisted UI prefs.** `viewMode` (Rendered/Diff), `lastAction`, `originalExpanded`, and `pasteFormat` are saved across sessions.

### Changed
- **Bundle split.** `index.html` and a new `quick-edit.html` are emitted as separate Vite multi-page entries (`src/entry-main.tsx`, `src/entry-quick-edit.tsx`). Tauri's quick-edit window now loads its own HTML. Removes the dead-code `TipTap`/`StarterKit` editor from the main bundle entirely (saves ~150 KB minified + cuts cold-start parse cost).
- **Capture flow.** The Rust hotkey handler now shows the popup *first* (no focus steal) with a `Capturing…` placeholder, then runs the clipboard dance in a background thread. A clipboard-change poll replaces the fixed 180 ms wait, so the visible stall is gone on fast apps. Three events drive the popup: `capture-start`, `captured-text`, `captured-text-repeat`.
- **Capped follow-up context.** Regenerate / multi-step follow-ups no longer re-send every intermediate assistant turn; the popup now sends `system + first user/assistant + previous assistant + new user` to bound token cost.
- **Revert (main window).** Replaced the broken hidden-TipTap revert with a clipboard-restore-and-drop: clicking Revert puts the original text on the user's clipboard so they can paste it over the rewrite in the source app, then removes the entry from history.
- **Provider-aware health probes** in Settings → Test connection: routes through `makeClient(...)` so OpenAI / Anthropic / Groq / OpenRouter are exercised via their real dialects.

### Removed
- **TipTap, ProseMirror, and `findTextRangeInDoc`** — the hidden in-app editor was unused except by a broken revert path. Dropped from `package.json` and the bundle.

## [1.1.0] - 2026-05-01

### Added
- **Prompt rewrite section (token-efficient prompts for LLMs / agents).**
  New `Prompt` dropdown in the QuickEdit popup, parallel to `Tone`, with
  three actions tailored at rewriting prompts (not prose):
  - **Compress tokens** — minimum-token rewrite that preserves every
    instruction, constraint, example, named entity, identifier, and
    quoted string verbatim while cutting filler, hedges, and politeness.
  - **Distill intent** — strips to the goal, hard constraints, output
    format, and any literals that must appear verbatim.
  - **Structure for agents** — restructures under `Role` / `Goal` /
    `Inputs` / `Constraints` / `Output format` / `Examples`, omitting
    empty sections.

  All three explicitly tell the model not to invent new requirements,
  which is the failure mode of a naive "shorten" pass on a prompt.
  Wired through the existing `ActionId` / `actionInstruction` /
  `actionLabel` plumbing, so the history list pretty-prints them as
  `Prompt: Compress` / `Prompt: Distill` / `Prompt: Structure`.
- **API key lock + clear flow.** Settings → cloud → API key now shows a
  locked masked field when a key is already saved (and auto-locks the
  moment Test connection succeeds). Two new buttons sit next to it:
  - **Edit** — unlocks the field and clears the draft so the user can
    paste a fresh key.
  - **Clear** — two-step confirm pill (auto-resets after 4s); on confirm
    it calls `secret_delete` directly so the credential is removed from
    Windows Credential Manager immediately, regardless of whether the
    user later cancels the modal.

### Fixed
- **Cloud Ollama 401 in the quick-edit popup.** The popup is rendered in a
  separate webview with its own React app and never read the keyring on
  mount, so `OllamaClient` had an empty `apiKey` and the cloud chat
  request went out without an `Authorization` header. `OllamaClient.chat`
  now falls back to the keyring when the in-memory key is empty —
  preserving Settings → Test against unsaved draft keys while letting the
  popup pick up keys saved after it mounted.
- **Local Ollama 403 in installed builds.** `tauri-plugin-http` auto-injects
  the webview's `Origin` (`http://tauri.localhost` in production), which
  Ollama's CORS check rejects with a flat 403 — so Settings showed
  "Cannot reach Ollama at http://localhost:11434: HTTP 403" and Test
  Connection failed even with Ollama running. Two-part fix:
  - Enable the plugin's `unsafe-headers` Cargo feature so it doesn't
    `append()` a second `Origin` header on top of ours.
  - Both `/api/tags` and `/api/chat` requests set `Origin` explicitly to
    the target URL's origin, so Ollama sees a same-origin request and
    accepts it.

### Changed
- **API key now stored in Windows Credential Manager.** The Ollama Cloud
  API key moves out of `localStorage` and into the Windows Credential
  Manager (service `R3write`, account `ollama-api-key`) via the `keyring`
  crate. Any pre-existing localStorage value is migrated to the credential
  store on first launch and stripped from `r3write.settings.v1` on the
  next save.
  - Rust: new `secret_set` / `secret_get` / `secret_delete` Tauri commands
    (`src-tauri/src/main.rs`) backed by `keyring::Entry`.
  - JS: `loadApiKey` / `saveApiKey` helpers; settings hydration is gated
    on the keyring read so we don't overwrite a stored secret with the
    empty default before it loads.
  - Settings UI helper text updated to reflect the new storage location.

## [1.0.0] - 2026-05-01

First stable release. Captures every milestone shipped to date and marks the
core feature set as production-ready: system-wide quick edit via global
hotkey, Ollama (cloud + local) streaming, multi-turn refinement, Markdown +
diff views, in-app history with Revert, system tray, modern UI with
system-aware dark mode, configurable hotkey, and Educational / Affirmation
feedback channels.

### Added
- **Configurable global hotkey.** New **Settings → Hotkey** field replaces the hardcoded `Ctrl+Alt+G` binding.
  - JS: new `HotkeyBinding` shape `{ ctrl, alt, shift, meta, code }` (DOM `KeyboardEvent.code`-based, layout-independent), `DEFAULT_HOTKEY`, `sameHotkey()`, `prettyKeyCode()` helpers. Added `hotkey: HotkeyBinding` to `OllamaSettings`; `loadSettings`'s spread-merge auto-fills the default for existing v1 entries.
  - New `HotkeyCapture` + `KbdDisplay` components: click the field to enter capture mode, press any combo with at least one modifier, Esc cancels. Reset button snaps back to `Ctrl+Alt+G`.
  - Save flow invokes the new Rust IPC command `set_hotkey` **before** persisting; if the new combo can't be registered (already owned by the OS or another app), the danger pill surfaces the error and `onSave` does NOT run, so settings stay in sync with what's actually bound.
  - Mount-time effect in `App()` re-applies the persisted hotkey on app start. Rust still registers the default `Ctrl+Alt+G` in `setup()` so the shortcut works during the brief window before React loads.
  - Rust: new `CurrentHotkey` Mutex state holding the currently-registered `Shortcut`, new `parse_code` mapping DOM-style code names to `tauri_plugin_global_shortcut::Code` (letters, digits, F1-F12, arrows, common punctuation). `set_hotkey` unregisters the previous binding, registers the new one, and on failure attempts a best-effort restore of the previous binding before returning the error to the JS layer.

### Added
- **Feedback channels — Educational + Affirmation toggles.** Two new independent toggles under **Settings → Feedback**:
  - **Educational** appends 1–2 sentences explaining what changed in the rewrite and why.
  - **Affirmation** appends one short, specific sentence of encouragement about the user's original.
  - Both default OFF, can be enabled independently, and apply to every turn (first action + follow-ups).
  - Implemented as a single streaming LLM call: the system prompt instructs the model to append hidden separators `===R3W-EDU===` / `===R3W-AFFIRM===` after the rewrite, which the client parses on completion via `parseFeedback()`. Models that ignore the markers degrade silently — the entire reply is treated as the rewrite.
  - Channels render as separate side-cards ("Why this works" / "Note") below the result strip, with `framer-motion` fade-in. They are explicitly **excluded** from paste-back, history, and Diff (only `parseFeedback(text).main` is used for those).
  - New `OllamaSettings` keys `educational` / `affirm`; `loadSettings` already merges defaults so existing `r3write.settings.v1` entries auto-upgrade with both toggles off.
  - New `ToggleRow` switch component (Radix-free, custom CSS, `role="switch"` + `aria-checked`).
  - `SYSTEM_PROMPT` constant replaced by `buildSystemPrompt(settings)` builder; both call sites (`OllamaClient.rewrite`, `QuickEdit.streamInto`) now read from the dynamic prompt so toggling at runtime takes effect on the next rewrite.

- **UI overhaul — modern minimal + dark mode.**
  - System-aware light/dark theme with manual override (System / Light / Dark) via a header dropdown. Pre-hydration boot script in `index.html` reads `r3write.theme.v1` from `localStorage` and applies `data-theme` to `<html>` before first paint, eliminating the flash of unstyled / wrong-theme content. Theme transitions wrap in `document.startViewTransition` where supported (WebView2 122+) for a free crossfade.
  - CSS custom-property design tokens on `:root` and `[data-theme="dark"]` (`--bg`, `--bg-elev`, `--bg-subtle`, `--fg`, `--fg-muted`, `--fg-subtle`, `--border`, `--border-strong`, `--accent`, `--accent-fg`, `--accent-hover`, `--danger`, `--danger-bg`, `--r3w-add`, `--r3w-del`, `--shadow-sm`, `--shadow-md`). Tailwind v4 `@theme` block exposes them as utilities (`bg-bg-elev`, `text-fg-muted`, `border-accent`, …).
  - Dark-mode-friendly `caret-color` and `::selection` rules for the editor; themed inline-diff add/remove backgrounds and foregrounds.
  - **Refined header** with brand mark, model · provider StatusPill, theme toggle (DropdownMenu), Info button, Settings button. Lucide icons throughout. Every icon button is wrapped in a Radix Tooltip.
  - **Radix Dialog + Framer Motion** for Settings and the new About / Info modal — focus traps, Escape handling, fade + scale transitions.
  - New `src/theme.ts` exporting a `useTheme()` hook that subscribes to `prefers-color-scheme` and persists choice.
  - New deps: `@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`, `framer-motion`, `lucide-react`.
- **Main window is now the history view.** The bundled scratch editor's welcome content was moved to an Info modal; the editor itself is kept mounted (hidden) so history `Revert` still has a ProseMirror doc to operate on. The History side-sheet was inlined as the primary content of the main window — the History toggle button is gone because there is nothing to toggle. Default window size 480 × 640.
- **Settings — Test connection.** A new button issues a tiny `chat({role:"user",content:"ping"})` against the *current draft* settings, waits for the first streamed token, then aborts the rest of the stream. Reports success with first-token latency in ms (green pill) or the upstream error message (red pill). 15 second timeout via `AbortController`. Editing any field clears a stale result; closing the dialog aborts an in-flight test.
- **About / Info modal.** New `InfoDialog` (Radix) holds the welcome / usage text that previously lived in the editor's initial document — invoked from the new Info icon in the header.

### Changed
- **`ThinkingIndicator` rewritten to use refs + `requestAnimationFrame`.** Replaces the previous `setNow(Date.now())` 10 Hz state-driven timer; the spinner phrase and elapsed counter now update via direct DOM `textContent` writes, so the component records zero React commits while streaming.
- **`RenderedMarkdown` and `DiffView` memoised.** `RenderedMarkdown` is wrapped in `React.memo` (the `marked → DOMPurify` pipeline was already memoised on `markdown`); `DiffView` now memoises `diffWordsWithSpace` keyed on `(original, rewritePlain)`.
- **History rows memoised with bucketed `now`.** Extracted `HistoryRow` (`React.memo`) — only re-renders when its entry id changes or `now` crosses a 30-second boundary, so `timeAgo` ticks no longer re-render every visible row simultaneously. Hover the relative timestamp for an exact-time tooltip.
- **Vite `manualChunks` (id-based).** `tiptap`, `markdown`, `radix`, `motion`, and `icons` chunks split out so changes in app code do not invalidate the heavy vendor bundles.
- **Main window default size**: 1100 × 750 → **480 × 640**, centered. Min 380 × 320.
- **Pre-hydration `<meta name="color-scheme" content="light dark">`** added to `index.html` so the OS-level scrollbar / form controls / underlying webview pick the right native palette before React mounts.

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
