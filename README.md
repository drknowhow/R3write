# R3write

Inline AI rewrite for Windows. Select text anywhere, press `Ctrl+Alt+G`,
pick an action, paste the result back. Local by default (free Ollama),
multi-provider for speed (Gemini, OpenAI, Anthropic, Groq, OpenRouter,
Ollama Cloud).

> Current release: **1.3.0**. See [`CHANGELOG.md`](./CHANGELOG.md) for the
> full history.

## What it does

- **System-wide quick edit (primary flow)** — select text in any
  Windows app, press `Ctrl+Alt+G`. A small frameless popup appears at
  the cursor with Improve / Fix grammar / Shorten / Expand / Tone /
  Prompt / Custom-prompt actions. The popup shows a `Capturing…`
  placeholder immediately while the clipboard handoff runs in a
  background thread, then streams the rewrite. Accept pastes back
  into the originating app; the original clipboard is preserved.
- **Repeat last action** — same selection, press `Ctrl+Alt+Shift+G` to
  rerun the previous action with no picker. Custom prompts replay the
  most recent custom prompt verbatim.
- **Saved templates and recent custom prompts** — name your common
  custom prompts in Settings → Templates and they appear as a dropdown
  in the popup. Recent custom prompts surface as one-click chips
  underneath the custom-prompt input.
- **Style guide + protected terms** — Settings → Glossary lets you
  paste a persistent style guide (appended to every system prompt) and
  a list of protected terms the model must keep verbatim (names,
  identifiers, brand strings).
- **Paste-as toggle** — popup footer toggles between **Plain**
  (Markdown stripped, default) and **MD** (raw Markdown) so
  destinations like Slack, Discord, or code editors render structure
  intact.
- **Prompt section (token-efficient rewrites for LLMs / agents).**
  Three actions targeted at rewriting prompts rather than prose:
  *Compress tokens*, *Distill intent*, *Structure for agents*. All
  three are explicitly told not to invent new requirements.
- **Multi-turn refinement** — type a follow-up after the first reply
  ("more concise", "less formal"). Context is capped to
  `system + first turn + last assistant + new user` so regenerate
  cycles don't compound token cost.
- **Rendered / Diff toggle** — preview the rewrite as rendered
  Markdown or as a word-level inline diff against the original. The
  choice is persisted across sessions.
- **Educational + Affirmation channels** — optional side-cards under
  Settings → Feedback. "Why this works" explains the most important
  changes; "Note" adds one specific encouragement about what the
  original did well. Excluded from paste-back, history, and the Diff.
- **Main window = history + live health.** Compact list of recent
  rewrites (last 20). Header shows a status pill that polls the active
  provider every 60s — green/amber/red dot with latency tooltip. Click
  the pill to jump to Settings. Revert copies the original back to the
  clipboard for one-shot paste-over-the-rewrite.
- **First-run onboarding** — four-step walkthrough on first launch
  with a one-click jump to Settings.
- **Tray icon.** Closing the main window hides it to the tray; the
  global hotkey keeps working. Right-click for Show / Support / Quit.
- **Autostart at login** — toggle in Settings → Advanced registers a
  Windows per-user `Run` entry. Tray comes up on sign-in.
- **Export history** as JSON or Markdown from Settings → Advanced.
- **Modern UI.** System-aware light/dark theme with manual override,
  Radix-based dialogs, framer-motion transitions, Lucide icons,
  pre-hydration theme boot script so there's no flash.

## Providers

The dropdown is ordered free-first; the default for new installs is
**Ollama Cloud**.

| Provider        | Tier                  | Default model              | Notes                                 |
| --------------- | --------------------- | -------------------------- | ------------------------------------- |
| Ollama Cloud    | Free tier · BYO key   | `gemma4:31b-cloud`         | Default. Free quota + paid tiers.     |
| Local Ollama    | Free                  | `llama3.2`                 | Runs on your machine, no key.         |
| Google Gemini   | Free tier · BYO key   | `gemini-2.5-flash`         | Most generous free tier; very fast.   |
| Groq            | Free tier · BYO key   | `llama-3.3-70b-versatile`  | Fastest streaming token rate.         |
| OpenRouter      | Free tier · BYO key   | `anthropic/claude-sonnet-4`| Aggregator; many models.              |
| OpenAI          | BYO key               | `gpt-4.1-mini`             | Paid only.                            |
| Anthropic       | BYO key               | `claude-sonnet-4-6`        | Paid only.                            |

API keys are stored per-provider in **Windows Credential Manager** via
the `keyring` crate (service `R3write`, accounts
`r3write-api-key-<provider>` and the legacy `ollama-api-key` for
Ollama Cloud). They never touch `localStorage`.

## Stack

- **Tauri 2** (Rust) — Windows-targeted desktop shell, NSIS installer.
- **React 18 + TypeScript + Vite + Tailwind v4** — frontend.
- **Multi-page Vite build** — `index.html` (main window) and
  `quick-edit.html` (popup) are emitted as separate entries so the
  popup ships only what it needs.
- **Radix UI primitives** — `react-dialog`, `react-tooltip`,
  `react-dropdown-menu` for accessible headless components.
- **Framer Motion** — dialog enter/exit animations.
- **Lucide React** — icon set.
- **`marked` + `DOMPurify`** — Markdown → sanitised HTML for the
  rendered popup output.
- **`diff`** — inline word diff in the popup's Diff view and the
  main-window history list.
- **Provider clients** — Ollama (`/api/chat` NDJSON), OpenAI-compatible
  SSE (OpenAI / Groq / OpenRouter via `/v1/chat/completions`),
  Anthropic (`/v1/messages` SSE), Gemini
  (`:streamGenerateContent?alt=sse`). All routed through
  `tauri-plugin-http` so CORS does not apply.
- **enigo** — keyboard simulation for the `Ctrl+C` / `Ctrl+V` capture
  and paste-back.
- **keyring (windows-native)** — per-provider API key storage in
  Windows Credential Manager.

## Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://rustup.rs/) stable + the **Microsoft C++ Build Tools**
  (Visual Studio 2022 with the "Desktop development with C++" workload)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (preinstalled on most up-to-date Windows installs)
- A provider key, or a local
  [Ollama](https://ollama.com/download) install. The free Local Ollama
  path needs no key at all; cloud providers each have their own free
  tier or paid signup.

## Run

```powershell
npm install
npm run tauri:dev
```

First launch shows a four-step onboarding dialog. After dismissing it:

1. Click the status pill or **Settings** in the top-right.
2. Pick a provider in **Model → Provider**. Each is tagged `Free`,
   `Free tier · BYO key`, or `BYO key`.
3. Paste your API key if the provider needs one.
4. Click **Test connection** to verify the model responds.
5. Save.

Then select text in any app and press `Ctrl+Alt+G`.

## Build a release installer

```powershell
npm run tauri:build
```

The NSIS installer lands in
`src-tauri/target/release/bundle/nsis/R3write_<version>_x64-setup.exe`.

Code signing is not yet wired up; without it Windows SmartScreen will
warn on install. Azure Trusted Signing is the recommended modern path.

## Configuration

Settings are stored in `localStorage` under `r3write.settings.v1`.
Notable fields:

| Field                | Default                | Notes                                                                 |
| -------------------- | ---------------------- | --------------------------------------------------------------------- |
| `provider`           | `ollama-cloud`         | One of the seven providers above. Legacy `cloud` / `local` migrate.   |
| `baseUrl`            | provider-dependent     | Auto-filled when provider changes.                                    |
| `model`              | provider-dependent     | Any model name the provider serves.                                   |
| `apiKey`             | — (keyring)            | Stored per-provider in Windows Credential Manager.                    |
| `hotkey`             | `Ctrl+Alt+G`           | Repeat-last uses the same key + Shift.                                |
| `bubbleShortcuts`    | `1`-`4`, `C`, `Enter`, `R` | In-popup keys for actions / accept / regenerate.                  |
| `viewMode`           | `rendered`             | `rendered` or `diff` — persisted.                                     |
| `lastAction`         | `null`                 | Used by the repeat hotkey.                                            |
| `pasteFormat`        | `plain`                | `plain` strips Markdown on accept; `markdown` pastes raw.             |
| `customPromptHistory`| `[]`                   | Last 12 custom prompts (most recent first).                           |
| `savedTemplates`     | `[]`                   | Named custom prompts surfaced as a popup dropdown.                    |
| `styleGuide`         | `""`                   | Appended to every system prompt.                                      |
| `protectedTerms`     | `""`                   | Comma / newline separated; preserved verbatim by the model.           |
| `clickOutsideDismiss`| `true`                 | Closes the popup on window-blur (drag-safe).                          |
| `autostart`          | `false`                | Mirrors the Windows per-user `Run` registry value.                    |
| `originalExpanded`   | `false`                | Popup `Original` pane height preference.                              |
| `popupAnchor`        | `mouse`                | Where the popup opens relative to the cursor.                         |
| `hasOnboarded`       | `false`                | True after the first-run dialog is dismissed.                         |
| `educational`        | `false`                | "Why this works" side-card.                                           |
| `affirm`             | `false`                | "Note" side-card.                                                     |

Theme preference is stored under `r3write.theme.v1` (`system` /
`light` / `dark`) and applied pre-hydration to avoid flash. History
lives under `r3write.history.v1` (last 20 entries).

## Layout

```
R3write/
├── CHANGELOG.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts            # multi-page entry: index.html + quick-edit.html
├── index.html                # main window — pre-hydration theme boot
├── quick-edit.html           # popup window — pre-hydration theme boot
├── src/
│   ├── entry-main.tsx        # renders <App />
│   ├── entry-quick-edit.tsx  # renders <QuickEdit />
│   ├── main.tsx              # App, QuickEdit, provider clients, Settings, dialogs
│   ├── theme.ts              # useTheme() hook, View Transitions crossfade
│   └── index.css             # Tailwind import, design tokens, prose styles
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json       # two windows: main + quick-edit (own HTML)
    ├── capabilities/default.json
    ├── icons/{icon.png, icon.ico}
    └── src/main.rs           # hotkeys + clipboard capture + paste-back +
                              # autostart + per-provider keyring commands
```

Conventions:
- Flat folder structure; no per-feature directories until justified.
- One React module (`src/main.tsx`) exports `App` and `QuickEdit`; the
  two entry shims render them into their respective HTML.
- **Every behavior change adds an entry to `CHANGELOG.md` under
  `[Unreleased]`.**

## Known limitations

- Quick-edit relies on the OS handing focus back to the previous app
  in ~90 ms after the popup hides. Most apps cope; some Electron apps
  with custom focus handling may not.
- No single-instance lock or auto-updater yet (autostart is shipped).
- Code signing is not configured; Windows SmartScreen will warn until
  the build is signed.
- Popup is positioned near the mouse, not the text caret — keyboard-
  only users may see the popup at an unrelated location on screen.
  Caret-anchored positioning is tracked for a future release.

## License

TBD.
