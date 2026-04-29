# R3write

Local-first inline AI rewrite for Windows. Select text anywhere, press
`Ctrl+Alt+G`, pick an action, paste the result back. Built on Ollama
(cloud or local), so the model and your data stay where you choose.

> Status: pre-1.0. Milestones 1–4 landed; tray / autostart / auto-update
> are still ahead. See [`CHANGELOG.md`](./CHANGELOG.md) for the full log.

## What it does

- **System-wide quick edit (primary flow)** — select text in any
  Windows app, press `Ctrl+Alt+G`. A small frameless popup appears at
  the cursor with Improve / Fix grammar / Shorten / Expand / Tone /
  Custom-prompt actions. Streaming preview, Accept / Reject /
  Regenerate. Accept pastes the rewrite into the originating app; the
  original clipboard is preserved.
  - The popup is draggable from its header.
  - History of accepted rewrites is kept across sessions in
    `localStorage` and viewable from the main window.
- **Tray icon** — R3write lives in the system tray. Closing the main
  window hides it to the tray (the app keeps running so the global
  shortcut still fires). Right-click the tray for **Show R3write /
  Quick edit / Quit**; left-click reopens the main window.
- **Bundled scratch editor** — the main window has a Tiptap editor as a
  notes / scratch pad. The in-editor selection bubble was removed in
  favor of the system-wide flow (which works inside the editor too).

Default model is `gemma4:31b-cloud` via Ollama Cloud. Switch to a local
Ollama instance from Settings.

## Stack

- **Tauri 2** (Rust) — Windows-targeted desktop shell, NSIS installer.
- **React 18 + TypeScript + Vite + Tailwind v4** — frontend.
- **Tiptap** — rich-text editor + selection-driven BubbleMenu.
- **Ollama** — `/api/chat` streaming, routed through
  `tauri-plugin-http` so CORS does not apply.
- **enigo** — keyboard simulation for the `Ctrl+C` / `Ctrl+V` capture
  and paste-back.

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

1. Click **Settings** in the top-right.
2. Pick **Ollama Cloud** (default) or **Local Ollama**.
3. Paste your API key (cloud only) and confirm the model name.
4. Save.

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

API keys live in `localStorage` for now; they will move to Windows
Credential Manager (via the `keyring` crate) before 1.0.

## Layout

```
R3write/
├── CHANGELOG.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx        # entry, App, OllamaClient, QuickEdit, history
│   └── index.css       # Tailwind import + editor styles
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/{icon.png, icon.ico}
    └── src/main.rs     # shortcut + clipboard + paste-back commands
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
- History `Revert` only works for entries that originated in the
  bundled editor. Popup-originated rewrites in external apps are
  recorded for reference but rely on the host app's own undo.

## License

TBD.
