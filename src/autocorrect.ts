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

export const APPLIED_EVENT = "autocorrect:applied";
export const REVERTED_EVENT = "autocorrect:reverted";

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

/** Whether the user ticked the box in the installer. A first-run default only. */
export const installerOptIn = () => invoke<boolean>("autocorrect_installer_opt_in");
