<p align="center">
  <img src="docs/icon.png" alt="R3write icon" width="140" />
</p>

<h1 align="center">R3write</h1>

<p align="center">
  <strong>Inline AI rewrite for Windows.</strong><br/>
  Select text in any app. Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd>. Pick an action. Paste the result back.<br/>
  Local-by-default with free Ollama, multi-provider for speed — Gemini, OpenAI, Anthropic, Groq, OpenRouter, Ollama Cloud.<br/>
  <strong>New in 1.5:</strong> system-wide autocorrect that fixes typos as you type — offline, in the apps you choose, off until you turn it on.
</p>

<p align="center">
  <a href="https://drknowhow.github.io/R3write/"><strong>Website &rarr;</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/drknowhow/R3write/releases/latest/download/R3write-setup.exe"><strong>Download</strong></a> &nbsp;·&nbsp;
  <a href="https://drknowhow.lemonsqueezy.com/checkout/buy/627f5ad5-2aa2-4503-b79a-245e53abdbb3">Buy activation key</a> &nbsp;·&nbsp;
  <a href="https://github.com/drknowhow/R3write/releases/latest">Release notes</a> &nbsp;·&nbsp;
  <a href="./CHANGELOG.md">Changelog</a> &nbsp;·&nbsp;
  <a href="https://drknowhow.github.io/R3write/ai-transparency.html">AI transparency</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue"/>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db"/>
  <a href="https://drknowhow.lemonsqueezy.com/checkout/buy/627f5ad5-2aa2-4503-b79a-245e53abdbb3"><img alt="License" src="https://img.shields.io/badge/license-Beta%20%C2%B7%20Pay%20what%20you%20want-7c3aed"/></a>
</p>

---

<p align="center">
  <img src="docs/screenshots/hero-popup.png" alt="R3write popup mid-rewrite, showing the original sentence, the streamed Improve rewrite, +12 -6 words / first-token latency stats, follow-up tone chips, and accept/regenerate/reject pills" />
</p>

<p align="center">
  <em>Select text in Word, the popup streams an Improve rewrite, you Accept &amp; paste — every keystroke without leaving the source app.</em>
</p>

## Why R3write

- **Inline, not a tab.** No window-switching. The rewrite happens where you're already typing.
- **Free by default.** Local Ollama is the zero-cost path — no key, no quota, no network. Cloud providers are opt-in for speed or quality.
- **Bring your own key.** Every cloud provider uses your own API key, stored per-provider in Windows Credential Manager — never on disk in plain text, never proxied through anyone else's server.
- **Word-level diff.** See exactly what changed, every time. Green additions, red deletions, on the same surface where you accepted the rewrite.
- **Typos fixed offline.** Autocorrect matches against a dictionary compiled into the app — 82,833 entries, no network, no model, no key. It runs only in the applications you list, and only after you switch it on.

## Quick install

R3write is **free to install** and **pay-what-you-want to unlock**.

1. **[Download R3write →](https://github.com/drknowhow/R3write/releases/latest/download/R3write-setup.exe)** from GitHub and run the installer.
2. **[Buy a license key →](https://drknowhow.lemonsqueezy.com/checkout/buy/627f5ad5-2aa2-4503-b79a-245e53abdbb3)** at the Lemon Squeezy checkout (pay what you want, $5 minimum). The receipt email includes your key.
3. **Paste the key on first launch** to activate. Without a key the app stays locked on the activation screen; with one it unlocks the main window and the quick-edit popup permanently on that machine. The activation gate itself has a **Buy a key** button if you skipped step 2.

See the [release page](https://github.com/drknowhow/R3write/releases/latest) for release notes and changelog.

**Or build from source:**

```powershell
git clone https://github.com/drknowhow/R3write
cd R3write
npm install
npm run tauri:dev
```

**Prerequisites:** Windows 10/11 · Node ≥ 20 · Rust stable + MSVC Build Tools · WebView2 (preinstalled on recent Windows).

On first launch a four-step onboarding shows you where to set up a provider. Default is Ollama Cloud (free tier); switch to Local Ollama for zero-cost local inference or any of the other five cloud providers from `Settings → Model → Provider`.

Autocorrect is a separate opt-in. The installer offers it unchecked on an *Optional features* page; that only seeds a preference, so turn it on properly — and choose which applications it runs in — under `Settings → Autocorrect`.

---

## What's in it

### One hotkey, any app

<p align="center">
  <img src="docs/screenshots/popup-actions.png" alt="The action picker after capturing a selection from Word — chips for Improve, Fix grammar, Shorten, Expand, Tone, Prompt, and Custom" />
</p>

Word, Slack, browsers, code editors, terminals — anywhere there's text. The popup opens at your cursor with `Improve` / `Fix grammar` / `Shorten` / `Expand` / `Tone` / `Prompt` / `Custom`. Each chip has a numeric shortcut (`1`-`4`, `C`) so you never need the mouse. Pick one and the rewrite streams in.

Repeat the same action on a new selection with <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> — no picker, no clicks.

### Word-level diff

<p align="center">
  <img src="docs/screenshots/popup-diff.png" alt="Diff view inside the popup — the rewrite is rendered as a word-level inline diff with green additions and red strike-through deletions" />
</p>

Toggle the rewrite into `Diff` view to see exactly what changed: green for additions, red strike-through for deletions, with a running `+N -M words` tally and the first-token latency. Sanitised for both light and dark themes.

### Your providers, your keys

<p align="center">
  <img src="docs/screenshots/settings-providers.png" alt="Settings dialog with the Provider dropdown open, showing all seven providers and their tier tags" />
</p>

| Provider | Tier | Default model | Notes |
|---|---|---|---|
| **Local Ollama** | Free | `llama3.2` | runs on your machine, no key |
| **Ollama Cloud** | Free tier · BYO key | `gemma4:31b-cloud` | default for new installs |
| **Google Gemini** | Free tier · BYO key | `gemini-2.5-flash` | most generous free tier; very fast |
| **Groq** | Free tier · BYO key | `llama-3.3-70b-versatile` | fastest streaming token rate |
| **OpenRouter** | Free tier · BYO key | `anthropic/claude-sonnet-4` | aggregator, many models |
| **OpenAI** | BYO key | `gpt-4.1-mini` | paid only |
| **Anthropic** | BYO key | `claude-sonnet-4-6` | paid only |

Each provider has its own keyring entry in Windows Credential Manager. Switch providers and the others' keys stay put. A live status pill in the header polls the active provider every 60 s — green/amber/red.

### History at a glance

<p align="center">
  <img src="docs/screenshots/main-window.png" alt="Main window history list, showing three Improve rewrites with rich word-level diff highlighting and Revert buttons" width="600" />
</p>

Last 20 rewrites with action, time, word-level diff, and one-click Revert (copies the original back to your clipboard for paste-over-the-rewrite). Closing the main window keeps R3write running in the system tray so the global hotkey still fires.

### Autocorrect, system-wide and offline

The rewrite hotkey handles the paragraph you meant to write. Autocorrect handles the word you didn't.

A `WH_KEYBOARD_LL` hook watches typing in the applications *you* list. When a word is committed with a space, punctuation or <kbd>Enter</kbd>, it is checked against a SymSpell dictionary compiled into the binary — 82,833 entries, fully offline — and replaced in place if it is a typo. Capitalisation carries onto the correction, so a sentence-initial `Teh` becomes `The`.

- **Off until you turn it on.** The installer offers it on an *Optional features* page, unchecked. That records a preference and nothing more — the hook is never installed until the app has both an active license and an explicit switch in `Settings → Autocorrect`.
- **Pick apps from a list**, by name, rather than knowing that Outlook is `outlook.exe`. Ships with Notepad, WordPad, Word and Outlook. Nothing outside your list is buffered, let alone corrected.
- **Undo that expires on purpose.** A toast in the bottom-right shows `teh → the` with an **Undo** button; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Z</kbd> reverts the last correction whether the toast is up or not. Both retire on any buffer invalidation *and* on the next committed word — exactly when reverting would stop being safe.
- **Ranked by typo shape, not just frequency.** Candidates are scored by corpus frequency weighted by the mechanical shape of the edit — transpositions and doubled keystrokes first, adjacent-key slips next, arbitrary substitutions last. Ambiguous words are left alone, and words that look like intended plurals are never quietly made singular (`companys` does not become `company`).
- **A correction log**, not a keystroke log. The typing buffer is in memory, capped, and cleared on every invalidation; raw keystrokes are never written to disk. The main window's panel header switches between **History** (rewrites you asked for) and **Autocorrect** (fixes that happened while you typed).

**Where it refuses to run.** The feature fails closed — when a check cannot answer, that counts as a refusal:

| Context | Behaviour |
|---|---|
| Password fields | Refused. Both the Win32 `ES_PASSWORD` style and a UI Automation `IsPassword` probe are consulted; **either** saying "password" refuses, and **neither** being able to answer refuses too. |
| Elevated windows | Refused — a non-elevated process cannot send input to one. |
| Remote desktop sessions | Refused. |
| IME / CJK composition | Refused — no single committed word to correct. |
| Browsers and Electron apps | Refused for now; Windows only reports password fields for native text boxes and Chromium draws its own. |
| Apps not on your list | Not corrected, and not buffered. |
| Terminals | **Allowed, flagged, and off the default list.** A shell password prompt is not a password *field*, so nothing can detect it; and <kbd>Enter</kbd> runs the line, so a correction landing on a path or a flag executes something you didn't type. |

**Optional contextual check (off by default).** Real-word errors (`form` for `from`) and plural morphology are spelled correctly, so the offline dictionary has nothing to say. With `Settings → Autocorrect → Ask the model about confusable words` on, those specific words — plus up to 80 characters of preceding context — go to your configured provider. It fires for a short list of known confusables, at most once every two seconds, and can only ever **suggest**: the reply appears in the bubble behind an **Apply** button, because by the time it arrives (300–2000 ms) the caret has moved. This is the one part of autocorrect that sends anything off the machine, which is why it is a separate switch from the master one.

---

## Power features

- **Saved templates** &mdash; name your common custom prompts in `Settings → Templates`; they surface as a popup dropdown next to `Tone` / `Prompt` / `Custom`.
- **Recent custom prompts** &mdash; last 12 surface as one-click chips beneath the custom-prompt input.
- **Glossary &amp; protected terms** &mdash; `Settings → Glossary` appends a persistent style guide to every system prompt and locks listed terms (names, identifiers, brand strings) so the model preserves them verbatim.
- **Paste-as toggle** &mdash; `Plain` strips Markdown for clean prose; `MD` preserves Markdown for Slack, Discord, code editors. Choice persists.
- **Three Prompt actions** for rewriting LLM/agent prompts &mdash; `Compress tokens` / `Distill intent` / `Structure for agents`. None invent new requirements.
- **Multi-turn refinement** &mdash; follow up with "more concise", "less formal", etc. Context is capped to `system + first turn + last assistant + new user` so cycles don't compound token cost.
- **Educational + Affirmation channels** (optional) &mdash; the model adds a "Why this works" note or a one-line encouragement, in a side-card. Excluded from paste-back and history.
- **Customisable hotkeys** &mdash; rebind both the main hotkey and every in-popup shortcut.
- **Autostart at login** &mdash; toggle in `Settings → Advanced` (writes the Windows per-user `Run` registry key).
- **Export history** as JSON or Markdown from `Settings → Advanced`.
- **System / light / dark theme** with manual override, pre-hydration boot script (no flash), View Transitions API crossfade where supported.
- **First-run onboarding** &mdash; four-step walkthrough and one-click jump to Settings.

## How it works under the hood

R3write is a two-window Tauri 2 app:

- **Main window** &mdash; history list, status pill, settings, system tray host.
- **Quick-edit popup** &mdash; frameless `alwaysOnTop` window, pre-mounted, shown at cursor.

The hotkey handler in Rust shows the popup immediately with a `Capturing…` placeholder, then runs the clipboard dance in a background thread (release modifiers, write sentinel, simulate `Ctrl+C`, poll for clipboard change, restore original). The captured text streams to the popup; the popup makes a single streaming request to the active provider via `tauri-plugin-http` and writes tokens directly to the DOM via `requestAnimationFrame` (so React re-renders stay at ~3 per response).

Each window loads its own HTML and JS entry (`index.html` + `quick-edit.html`) so the popup ships only what it needs &mdash; cold-start parse cost stays small even as the main window grows new tabs.

## Stack

- **Tauri 2** (Rust) &mdash; Windows shell, NSIS installer
- **React 18 + TypeScript + Vite + Tailwind v4** &mdash; frontend
- **Multi-page Vite build** &mdash; separate entries per window
- **Radix UI + Framer Motion + Lucide React** &mdash; accessible primitives, animations, icons
- **`marked` + `DOMPurify` + `diff`** &mdash; Markdown rendering and inline diff
- **`windows` crate** &mdash; raw `SendInput` for all synthetic keystrokes, `WH_KEYBOARD_LL` for the autocorrect hook, UI Automation for password-field detection
- **SymSpell** &mdash; 82,833-entry frequency dictionary compiled into the binary for offline autocorrect
- **keyring (windows-native)** &mdash; per-provider API key storage

## Configuration

Settings persist in `localStorage` under `r3write.settings.v1`; API keys live in Windows Credential Manager (`service: R3write`, `account: r3write-api-key-<provider>` or the legacy `ollama-api-key` for Ollama Cloud). The full schema lives in `DEFAULT_SETTINGS` in [`src/main.tsx`](src/main.tsx); the most user-facing fields:

| Field | Default | Notes |
|---|---|---|
| `provider` | `ollama-cloud` | Any of the seven providers; legacy `cloud` / `local` migrate on first load. |
| `model` | provider-dependent | Any model name your provider serves. |
| `hotkey` | `Ctrl+Alt+G` | Repeat-last uses the same combo + Shift. |
| `viewMode` | `rendered` | `rendered` or `diff` &mdash; persisted. |
| `pasteFormat` | `plain` | `plain` strips Markdown on Accept; `markdown` keeps it. |
| `savedTemplates` | `[]` | Named custom prompts shown in the popup. |
| `styleGuide` | `""` | Appended to every system prompt. |
| `protectedTerms` | `""` | Comma- or newline-separated; preserved verbatim. |
| `clickOutsideDismiss` | `true` | Closes the popup on window-blur (drag-safe). |
| `autostart` | `false` | Mirrors the Windows per-user `Run` registry value. |

Theme preference is stored under `r3write.theme.v1` and applied pre-hydration; history under `r3write.history.v1` (last 20 entries).

## Build a release installer

```powershell
npm run tauri:build
```

NSIS installer lands in `src-tauri/target/release/bundle/nsis/R3write_<version>_x64-setup.exe`. Code signing isn't wired up &mdash; Windows SmartScreen will warn on install until the build is signed (Azure Trusted Signing is the recommended modern path).

For a full release cut (version bump in all three manifests, CHANGELOG promote, build, tag, push, and GitHub release with notes), use the helper. The installer is distributed via [Lemon Squeezy](https://drknowhow.lemonsqueezy.com) — upload it there after each build.

```bash
scripts/release.sh 1.5.0
```

Run it from anywhere inside the repo. It refuses to proceed unless you're on `main`, the working tree is clean, you're in sync with origin, the tag doesn't already exist, and the `[Unreleased]` section in `CHANGELOG.md` has content (which becomes the release notes verbatim).

## Layout

```
R3write/
├── README.md
├── CHANGELOG.md
├── docs/                        # GitHub Pages site
│   ├── index.html
│   ├── ai-transparency.html     # full AI disclosure
│   ├── styles.css
│   ├── icon.png
│   └── screenshots/             # the shots used above
├── index.html                   # main window — pre-hydration theme boot
├── quick-edit.html              # popup window — pre-hydration theme boot
├── autocorrect-bubble.html      # correction toast window
├── vite.config.ts               # multi-page input (main + quick-edit + bubble)
├── src/
│   ├── entry-main.tsx           # renders <App />
│   ├── entry-quick-edit.tsx     # renders <QuickEdit />
│   ├── entry-autocorrect-bubble.tsx
│   ├── main.tsx                 # App, QuickEdit, provider clients, dialogs
│   ├── AutocorrectBubble.tsx    # correction toast — its own 3 kB bundle
│   ├── autocorrect.ts           # JS side of the Rust autocorrect bridge
│   ├── license.ts               # Lemon Squeezy activation
│   ├── theme.ts                 # useTheme() hook, View Transitions crossfade
│   └── index.css                # Tailwind + design tokens + prose styles
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json          # three windows: main + quick-edit + autocorrect-bubble
    ├── capabilities/default.json
    ├── installer/               # forked NSIS template + pristine upstream copy
    ├── resources/               # SymSpell frequency dictionary
    └── src/
        ├── main.rs              # hotkeys + capture + paste-back + autostart + keyring
        └── autocorrect/         # hook, buffer, dict, shape, target, inject, bubble
```

## AI transparency

R3write is an AI system, and it is built with AI. Both are worth stating plainly. The full disclosure lives at **[drknowhow.github.io/R3write/ai-transparency.html](https://drknowhow.github.io/R3write/ai-transparency.html)**; the short version:

- **Its output is machine-generated.** Every rewrite comes from a language model, not from rules. Models invent specifics, drop qualifiers that mattered, and strengthen claims you deliberately hedged. Read the rewrite before you accept it — that is what the diff view is for. The popup carries a permanent `AI-generated · review before use` line, and `Settings → AI` names the provider and model in use.
- **R3write ships no model and runs no server.** Requests go from your machine to the provider *you* configured, with *your* key, over a direct connection. Nothing is proxied, mirrored or logged anywhere the author can reach.
- **Three paths send anything at all:** a cloud provider (the selection + prompt), autocorrect's optional contextual check (one word + ≤80 characters of context, **off by default**), and license activation (key + machine id, no document text). Local Ollama and the offline dictionary send nothing.
- **No telemetry, and no training on your text.** Once text reaches a provider, that provider's terms govern it — worth reading rather than assuming, especially on free tiers.
- **R3write itself was built with AI assistance.** Its Rust and TypeScript, its website and much of this documentation were written by the author working with AI coding assistants. Review and responsibility are the author's; the keystrokes largely were not. The source is public so that claim is checkable.
- **If you publish what you rewrite,** EU AI Act Art. 50(4) may require *you* to label AI-generated text published to inform the public on matters of public interest, unless a person has genuinely reviewed it. R3write cannot discharge that for you.

On machine-readable marking (Art. 50(2)): R3write does not currently embed a marker in the text it pastes back — it writes plain text through the clipboard, which has no metadata channel that survives the paste. The transitional deadline is 2 December 2026 and the approach is being worked out in the open; [issues welcome](https://github.com/drknowhow/R3write/issues).

*Descriptive, not legal advice — see the full page for the caveat.*

## About

R3write started as a personal itch: every time I needed to clean up a paragraph, tighten a Slack message, or rewrite a sentence I'd just typed, I'd <kbd>Alt</kbd>+<kbd>Tab</kbd> into a chatbot, paste the text, copy the response back, switch back, and lose my train of thought. For the small rewrites I do constantly, a 30-second chat is overkill.

R3write replaces the tab switch with a hotkey. Select text in any app, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>, pick an action, paste back. The rewrite happens where you're already typing.

### Principles

- **Local by default.** The free path uses Ollama on your machine. No network, no key, no quota.
- **Bring your own key.** Every cloud provider uses your API key directly. R3write doesn't proxy anything through its own server. There *is* no R3write server.
- **No telemetry.** R3write doesn't phone home, doesn't track usage, doesn't collect analytics.
- **Your data stays where you put it.** Selections go to the provider you configured. That's it.

### Built by

[@drknowhow](https://github.com/drknowhow). Issues, ideas, and PRs welcome on [GitHub](https://github.com/drknowhow/R3write/issues).

## Supporters

R3write is free during beta thanks to people who tip and sponsor it. Sponsorship is what keeps the app free while it's finding its shape; it directly funds the next features on the roadmap (caret-anchored popup positioning, per-action model overrides, A/B regenerate, recipe chaining, eventual macOS support).

[<img alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor%20on%20GitHub-%E2%99%A5-ea4aaa?style=for-the-badge&logo=github" />](https://github.com/sponsors/drknowhow) &nbsp; [<img alt="Buy me a coffee" src="https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?style=for-the-badge&logoColor=black" />](https://buymeacoffee.com/drknowhow)

<!-- sponsors -->
*Become the first listed sponsor — your name (and avatar, if you'd like) goes here.*
<!-- sponsors -->

## Known limitations

- Quick-edit relies on the OS handing focus back to the previous app ~90 ms after the popup hides. Most apps cope; some Electron apps with custom focus handling may not.
- No single-instance lock or auto-updater yet (autostart is shipped).
- Code signing isn't configured; Windows SmartScreen will warn on install.
- Popup is anchored to the mouse, not the text caret &mdash; keyboard-only users may see it land somewhere unrelated. Caret-anchored positioning is tracked for a future release.
- Autocorrect does not run in browsers or Electron apps yet, because Windows only reports password fields for native text boxes and Chromium draws its own. The refusal is deliberately conservative until that gap closes.
- Autocorrect draws no in-place underline and will not: R3write cannot render inside another app's text field, and a caret-anchored overlay has no caret to anchor to in Chromium, Electron or Java apps. The bottom-right toast is the affordance.
- Rewritten text carries no machine-readable AI marker &mdash; see [AI transparency](#ai-transparency).

## Changelog

Full history in [`CHANGELOG.md`](./CHANGELOG.md). Latest: **1.5.0** &mdash; system-wide offline autocorrect, and the AI transparency disclosures.

## License

R3write is in **beta** — see [`LICENSE`](./LICENSE) for the full terms.

Source is published on GitHub for transparency and contribution; it is not released under an open-source license at this time. R3write uses a pay-what-you-want model ($5 minimum) per major version; once a version is purchased it remains yours.
