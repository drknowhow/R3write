# Changelog

All notable changes to R3write will be recorded here. Newest first.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial Tauri 2 + React + TypeScript + Vite scaffold targeting Windows.
- Tailwind CSS v4 (no config file, uses `@tailwindcss/vite`).
- Tiptap editor with `StarterKit` rendered in the main window.
- Single-file React entry (`src/main.tsx`) hosting app shell and editor.
- Single-file Rust entry (`src-tauri/src/main.rs`) with default Tauri builder.
- Project conventions:
  - Flat folder layout: `src/` for frontend, `src-tauri/` for Rust, no nested feature folders yet.
  - Every behavior change must add an entry to this file under `[Unreleased]`.

### Notes / TODO
- Bundle icons are placeholders; run `npx @tauri-apps/cli icon <source.png>` before `tauri build` for production icons.
- AI integration, BubbleMenu, global shortcut, and quick-edit popup are scheduled for milestones 2–4.
