# Changelog

All notable changes to R3write will be recorded here. Newest first.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- Milestone 4: global shortcut + frameless quick-edit popup window + clipboard capture/restore for use in any Windows app.
