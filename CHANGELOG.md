# Changelog

All notable changes to R3write will be recorded here. Newest first.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- Milestone 3: replace `MockLLM` with an Ollama-backed client (local + cloud) behind the same `LLMClient` interface. Settings UI (provider, base URL, model, API key) lands with it.
- Milestone 4: global shortcut + frameless quick-edit popup window + clipboard capture/restore for use in any Windows app.
