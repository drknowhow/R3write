# R3write

Local-first inline AI rewrite for Windows. Select text anywhere, press
`Ctrl+Alt+G`, pick an action, paste the result back. Built on Ollama
(cloud or local), so the model and your data stay where you choose.

> Status: pre-1.0. Milestones 1–5 landed plus a UI overhaul; autostart
> and auto-update are still ahead. See [`CHANGELOG.md`](./CHANGELOG.md)
> for the full log.

## What it does

- **System-wide quick edit (primary flow)** — select text in any
  Windows app, press `Ctrl+Alt+G`. A small frameless popup appears at
  the cursor with Improve / Fix grammar / Shorten / Expand / Tone /
  Custom-prompt actions. Streaming preview, Accept / Reject /
  Regenerate. Accept pastes the rewrite into the originating app; the
  original clipboard is preserved.
  - **Styled rendered output** — when the rewrite is naturally
    structured (lists, multi-paragraph prose, emphasis, headings, code),
    the popup renders Markdown via `marked` + `DOMPurify` so you preview
    real bullets and bold instead of `*` / `**` markers. Toggle between
    **Rendered**, **Diff** (word-level diff vs the original, Markdown
    stripped for readability), and **Source** (raw Markdown).
  - **Multi-turn refinement** — after the first reply, type a follow-up
    ("more concise", "less formal", "drop the second sentence"); the
    full thread is sent on each turn so the model has context.
    *Regenerate* redoes only the last turn.
  - **Live thinking indicator** while streaming — spinner, rotating
    phrase, animated dots, model name, elapsed timer. Implemented with
    refs + `requestAnimationFrame`, so the indicator updates without
    triggering React re-renders.
  - **Accept** strips Markdown to clean prose before pasting, so
    external apps receive plain-text bullets/paragraphs rather than
    `* item` / `**bold**`.
  - The popup is draggable and resizable from its header / corner.
- **Main window = history view.** The main window opens as a compact
  list of recent rewrites (last 20). Each entry shows the action, a
  word-level inline diff (sanitised for both light and dark themes), an
  exact-time tooltip, and a one-click Revert. There is no longer a
  scratch editor on the main screen — the popup is the editing surface,
  the main window is the audit trail.
- **Modern UI.**
  - **System-aware light / dark theme** with manual override (System /
    Light / Dark) via the header dropdown. Pre-hydration boot script
    in `index.html` applies the theme before first paint, so there is
    no flash. Theme transitions use the View Transitions API where
    available for a free crossfade.
  - **Refined header** — brand mark, model · provider status pill,
    theme toggle, Info, Settings. Lucide icons throughout, Radix
    Tooltip on every icon button.
  - **Radix-based dialogs** — Settings and the About / Info modal use
    `@radix-ui/react-dialog` with focus traps, Escape handling, and
    `framer-motion` fade + scale transitions.
  - CSS custom-property design tokens (`--bg`, `--fg`, `--accent`, …)
    drive both themes. Tailwind v4's `@theme` block exposes them as
    utilities (`bg-bg-elev`, `text-fg-muted`, `border-accent`, …).
- **Settings — test connection.** A **Test connection** button in the
  Settings dialog issues a tiny `chat({role:"user",content:"ping"})`
  against the *current draft* settings, waits for the first streamed
  token, and reports success (with first-token latency in ms) or the
  exact upstream error. 15 second timeout. Editing any field clears a
  stale result so a green "Connected" never lingers after you change
  the model name.
- **Settings — feedback channels (Educational + Affirmation).** Two
  independent toggles under **Settings → Feedback**:
  - **Educational** — after each rewrite, the model adds 1–2 short
    sentences explaining the most important changes and why they
    improve the writing.
  - **Affirmation** — adds one short sentence of specific encouragement
    about what the original did well.

  Both default OFF, can be enabled independently, and apply to every
  turn (initial action and follow-ups). Channels render as separate
  side-cards below the rewrite ("Why this works" / "Note") and are
  **excluded** from paste-back, history, and the Diff view — only the
  rewrite itself is treated as the artifact. The model produces them
  in a single streaming call by appending hidden separators
  (`===R3W-EDU===` / `===R3W-AFFIRM===`) which the client parses;
  models that ignore the markers degrade silently to the plain rewrite.
- **Tray icon.** R3write lives in the system tray. Closing the main
  window hides it to the tray (the app keeps running so the global
  shortcut still fires). Right-click the tray for **Show R3write /
  Quick edit / Quit**; left-click reopens the main window.
- **About modal.** The previous in-editor welcome text now lives behind
  the **Info** icon in the header — same usage hints, kept off the
  primary surface.

Default model is `gemma4:31b-cloud` via Ollama Cloud. Switch to a local
Ollama instance from Settings.

## Stack

- **Tauri 2** (Rust) — Windows-targeted desktop shell, NSIS installer.
- **React 18 + TypeScript + Vite + Tailwind v4** — frontend.
- **Tiptap (StarterKit)** — kept mounted (hidden) so history `Revert`
  has a ProseMirror doc to operate against; not user-visible.
- **Radix UI primitives** — `react-dialog`, `react-tooltip`,
  `react-dropdown-menu` for accessible, headless dialog/menu/tooltip
  components.
- **Framer Motion** — dialog enter/exit animations.
- **Lucide React** — icon set.
- **`marked` + `DOMPurify`** — Markdown → sanitised HTML for the
  rendered popup output.
- **`diff`** — inline word diff in the popup's Diff view and the
  main-window history list.
- **Ollama** — `/api/chat` streaming, routed through
  `tauri-plugin-http` so CORS does not apply.
- **enigo** — keyboard simulation for the `Ctrl+C` / `Ctrl+V` capture
  and paste-back.

`vite.config.ts` splits the bundle into `tiptap`, `markdown`, `radix`,
`motion`, and `icons` chunks so iterating on app code does not bust
the heavy vendor caches.

## Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://rustup.rs/) stable + the **Microsoft C++ Build Tools**
  (Visual Studio 2022 with the "Desktop development with C++" workload)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (preinstalled on most up-to-date Windows installs)
- An Ollama Cloud API key, or a local
  [Ollama](https://ollama.com/download) install with whatever model you
  want to point R3write at

## Run

```powershell
npm install
npm run tauri:dev
```

The first launch:

1. Click **Settings** in the top-right of the main window.
2. Pick **Ollama Cloud** (default) or **Local Ollama**.
3. Paste your API key (cloud only) and confirm the model name.
4. Click **Test connection** to verify the model responds.
5. Save.

Then select text in any app and press `Ctrl+Alt+G` to open the
rewrite popup.

## Build a release installer

```powershell
npm run tauri:build
```

The NSIS installer lands in
`src-tauri/target/release/bundle/nsis/`.

The placeholder app icon should be regenerated before shipping:

```powershell
npx @tauri-apps/cli icon path/to/source.png
```

Code signing is not yet wired up; without it Windows SmartScreen will
warn on install. Azure Trusted Signing is the recommended modern path.

## Configuration

Settings are stored in `localStorage` under `r3write.settings.v1`:

| Field      | Default              | Notes                                        |
| ---------- | -------------------- | -------------------------------------------- |
| provider   | `cloud`              | `cloud` or `local`                           |
| baseUrl    | `https://ollama.com` | auto-filled when provider toggles            |
| model      | `gemma4:31b-cloud`   | any Ollama model name your provider serves   |
| apiKey     | (empty)              | required for cloud; ignored for local        |

Theme preference is stored under `r3write.theme.v1` (`system` /
`light` / `dark`) and applied pre-hydration to avoid flash.

API keys live in `localStorage` for now; they will move to Windows
Credential Manager (via the `keyring` crate) before 1.0.

## Layout

```
R3write/
├── CHANGELOG.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts        # manualChunks for tiptap/markdown/radix/motion/icons
├── index.html            # pre-hydration theme boot script
├── src/
│   ├── main.tsx          # entry, App, OllamaClient, QuickEdit, dialogs, history
│   ├── theme.ts          # useTheme() hook, View Transitions crossfade
│   └── index.css         # Tailwind import, design tokens (light + dark), prose styles
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/{icon.png, icon.ico}
    └── src/main.rs       # shortcut + clipboard + paste-back commands
```

Conventions:
- Flat folder structure; no per-feature directories until justified.
- Single React entry; one Rust entry. Splits only when a file outgrows
  its concerns.
- **Every behavior change adds an entry to `CHANGELOG.md` under
  `[Unreleased]`.**

## Known limitations

- Quick-edit relies on the OS handing focus back to the previous app in
  ~90 ms after the popup hides. Most apps cope; some Electron apps with
  custom focus handling may not.
- No autostart, single-instance lock, or auto-updater yet.
- App icon and installer branding are placeholders.
- History `Revert` operates against the (hidden) bundled ProseMirror
  doc, so it succeeds only when the rewrite text is actually present
  there. Popup-originated rewrites in external apps are recorded for
  reference; reverting them in their host app relies on that app's
  native undo.

## License

TBD.
