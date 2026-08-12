// Shared types + command wrappers for the autocorrect feature.
//
// Rust owns all autocorrect state — the typing buffer, the dictionary, the
// correction log and the undo. The two (now three) webviews have independent
// React state, so anything shared between them has to live on the Rust side and
// arrive here as events. These are views, not owners.

import { invoke } from "@tauri-apps/api/core";

/// Mirrors `CorrectionEntry` in src-tauri/src/autocorrect/mod.rs.
export interface CorrectionEntry {
  id: string;
  timestamp: number;
  original: string;
  correction: string;
  /** Executable name of the app the correction landed in, e.g. `notepad.exe`. */
  app: string;
  /** `"dict"` today; `"llm"` arrives with Phase 5 and never auto-injects. */
  source: "dict" | "llm";
  reverted: boolean;
}

/// Mirrors `AutocorrectConfig` in src-tauri/src/autocorrect/mod.rs.
export interface AutocorrectConfig {
  enabled: boolean;
  minWordLength: number;
  showBubble: boolean;
  /** Ask the configured model about words the dictionary cannot judge.
   *  Separately opt-in: turning it on means text leaves the machine. */
  llmAssist: boolean;
  /** Newline-separated process names. Empty means "correct nowhere". */
  allowlist: string;
  protectedTerms: string;
  logRetention: number;
}

/** Payload of the `autocorrect:applied` event. */
export interface AppliedEvent {
  /** Monotonic. Discard anything not greater than the last one seen. */
  version: number;
  entry: CorrectionEntry;
  showBubble: boolean;
}

export interface RevertedEvent {
  version: number;
  id: string;
}

/** Rust asking the frontend to arbitrate a word it cannot judge locally.
 *  The provider clients and API keys live on this side, so Rust delegates. */
export interface ArbitrateEvent {
  id: string;
  word: string;
  /** Up to ~80 characters of preceding text. Never the whole buffer. */
  context: string;
}

/** A suggestion awaiting explicit acceptance. Never applied automatically. */
export interface SuggestedEvent {
  version: number;
  id: string;
  original: string;
  suggestion: string;
  app: string;
}

export const APPLIED_EVENT = "autocorrect:applied";
export const REVERTED_EVENT = "autocorrect:reverted";
export const ARBITRATE_EVENT = "autocorrect:arbitrate";
export const SUGGESTED_EVENT = "autocorrect:suggested";

export const getConfig = () => invoke<AutocorrectConfig>("autocorrect_get_config");
export const setConfig = (config: AutocorrectConfig) =>
  invoke<void>("autocorrect_set_config", { config });

/** Tell Rust whether the license is active. The keyboard hook refuses to install
 *  until this is true — gating only the UI would leave it running behind the paywall. */
export const setLicenseActive = (active: boolean) =>
  invoke<void>("autocorrect_set_license_active", { active });

export const getLog = () => invoke<CorrectionEntry[]>("autocorrect_get_log");
export const clearLog = () => invoke<void>("autocorrect_clear_log");

/** Returns false when nothing is pending — the normal case once the user has
 *  typed on past the correction. Not an error. */
export const undoLast = () => invoke<boolean>("autocorrect_undo_last");

/** Hide the toast without reverting. The undo stays available via the hotkey. */
export const dismissBubble = () => invoke<void>("autocorrect_dismiss_bubble");

/** Answer an arbitration request. `null` means "the word was already correct",
 *  which is the common case and shows the user nothing. */
export const sendLlmSuggestion = (id: string, suggestion: string | null) =>
  invoke<void>("autocorrect_llm_suggestion", { id, suggestion });

/** Apply a pending suggestion. Only ever called from an explicit user action. */
export const acceptSuggestion = () => invoke<boolean>("autocorrect_accept_suggestion");

/** Whether the user ticked the box in the installer. A first-run default only. */
export const installerOptIn = () => invoke<boolean>("autocorrect_installer_opt_in");

/** A running application offered by the allowlist picker. */
export interface RunningApp {
  /** Executable name, e.g. `outlook.exe` — what the allowlist matches on. */
  exe: string;
  /** A window title, so the list reads as "Outlook" rather than "outlook.exe". */
  title: string;
  /** A terminal or remote shell. See `RISKY_PROCESSES` in target.rs. */
  risky: boolean;
}

export const runningApps = () => invoke<RunningApp[]>("autocorrect_running_apps");

/** Which allowlist entries are terminals. Asked of Rust rather than duplicated
 *  here, so there is one list and it lives beside the code that gates targets. */
export const riskyEntries = (allowlist: string) =>
  invoke<string[]>("autocorrect_risky_entries", { allowlist });
