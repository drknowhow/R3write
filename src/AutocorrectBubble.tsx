import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { useThemeFollower } from "./theme";
import {
  APPLIED_EVENT,
  REVERTED_EVENT,
  SUGGESTED_EVENT,
  acceptSuggestion,
  dismissBubble,
  undoLast,
  type AppliedEvent,
  type CorrectionEntry,
  type SuggestedEvent,
} from "./autocorrect";

/// What the toast is currently showing.
///
/// `applied` — we already changed the text; the action is to undo.
/// `suggested` — we changed nothing; the action is to accept.
///
/// The distinction is the whole point of the LLM path: a model answer arrives
/// seconds after the word was typed, far too late to apply silently.
type Mode = "applied" | "suggested";

/// How long the toast stays up before fading, in ms. Long enough to read and
/// reach for, short enough not to linger over someone's work.
const DWELL_MS = 4000;
/// Must match the CSS transition below, so the window is not yanked away
/// mid-fade.
const FADE_MS = 160;

/**
 * The correction toast.
 *
 * This is the "marking" half of the feature. R3write cannot draw an underline
 * inside another app's text field — it has no access to Word's or Chrome's
 * rendering — so instead of a caret-anchored overlay (which drifts on scroll and
 * simply has no caret to anchor to in Chromium/Electron/Java), the marking is a
 * corner toast plus a global undo hotkey.
 *
 * Deliberately NOT using `data-tauri-drag-region` anywhere: it hooks at the
 * WebView2 layer and swallows mousedown before React sees it, which is what made
 * the theme dropdown unclickable. The Undo button here would die the same way.
 */
export function AutocorrectBubble() {
  useThemeFollower();

  const [entry, setEntry] = useState<CorrectionEntry | null>(null);
  const [mode, setMode] = useState<Mode>("applied");
  const [shown, setShown] = useState(false);
  /** Highest event version rendered. Two other windows subscribe to the same
   *  stream; the stamp makes out-of-order delivery impossible rather than
   *  merely unlikely. */
  const versionRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const pausedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const close = useCallback(() => {
    clearTimer();
    setShown(false);
    // Let the fade finish before the OS window disappears.
    window.setTimeout(() => {
      void dismissBubble().catch(() => {});
    }, FADE_MS);
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(close, DWELL_MS);
  }, [close]);

  useEffect(() => {
    let unApplied: (() => void) | undefined;
    let unReverted: (() => void) | undefined;
    let unSuggested: (() => void) | undefined;

    void listen<AppliedEvent>(APPLIED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.version <= versionRef.current) return;
      versionRef.current = p.version;
      setEntry(p.entry);
      setMode("applied");
      setShown(true);
      if (!pausedRef.current) startTimer();
    }).then((u) => {
      unApplied = u;
    });

    void listen<SuggestedEvent>(SUGGESTED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.version <= versionRef.current) return;
      versionRef.current = p.version;
      setEntry({
        id: p.id,
        timestamp: Date.now(),
        original: p.original,
        correction: p.suggestion,
        app: p.app,
        source: "llm",
        reverted: false,
      });
      setMode("suggested");
      setShown(true);
      if (!pausedRef.current) startTimer();
    }).then((u) => {
      unSuggested = u;
    });

    // Rust hides the window on revert; clearing here keeps the next show from
    // flashing the old correction before the new payload lands.
    void listen(REVERTED_EVENT, () => {
      clearTimer();
      setShown(false);
    }).then((u) => {
      unReverted = u;
    });

    return () => {
      unApplied?.();
      unReverted?.();
      unSuggested?.();
      clearTimer();
    };
  }, [startTimer]);

  // Both actions inject text, and both rely on Rust taking this window down and
  // waiting for focus to return first — otherwise the keystrokes land here rather
  // than in the user's document.
  const onAct = useCallback(() => {
    clearTimer();
    setShown(false);
    const action = mode === "suggested" ? acceptSuggestion : undoLast;
    void action().catch(() => {});
  }, [mode]);

  // Hovering means the user is reading or reaching for Undo. Yanking the toast
  // out from under the cursor at that exact moment is the worst possible timing.
  const onEnter = () => {
    pausedRef.current = true;
    clearTimer();
  };
  const onLeave = () => {
    pausedRef.current = false;
    if (shown) startTimer();
  };

  return (
    <div
      className="flex h-screen w-screen items-center overflow-hidden bg-transparent p-1"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        role="status"
        aria-live="polite"
        style={{ transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease` }}
        className={[
          "flex w-full items-center gap-2 rounded-xl border border-border",
          "bg-bg-elev px-3 py-2 shadow-md",
          shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        ].join(" ")}
      >
        <PencilMark />

        <div className="min-w-0 flex-1 text-sm leading-tight">
          <div className="flex items-center gap-1.5 truncate">
            {/* Struck through only when the change has already happened. A
                suggestion has changed nothing yet, and showing it as struck
                through would misrepresent the document. */}
            <span
              className={`truncate text-fg-muted ${mode === "applied" ? "line-through" : ""}`}
            >
              {entry?.original}
            </span>
            <span aria-hidden className="shrink-0 text-fg-subtle">
              &rarr;
            </span>
            <span className="truncate font-medium text-fg">{entry?.correction}</span>
          </div>
          <div className="truncate text-[11px] text-fg-subtle">
            {mode === "suggested" ? "suggestion" : entry?.app || "corrected"}
          </div>
        </div>

        <button
          type="button"
          onClick={onAct}
          className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            mode === "suggested"
              ? "bg-accent text-accent-fg hover:bg-accent-hover"
              : "border border-border text-fg-muted hover:bg-bg-subtle hover:text-fg"
          }`}
        >
          {mode === "suggested" ? "Apply" : "Undo"}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/// Inline rather than a lucide import: this window is shown on a keystroke, and
/// pulling the icon chunk in for one glyph would undo the point of giving it its
/// own bundle entry.
function PencilMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="shrink-0 text-accent"
    >
      <path
        d="M9.2 1.8l3 3L5 12H2v-3l7.2-7.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
