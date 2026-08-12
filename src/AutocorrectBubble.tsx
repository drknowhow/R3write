import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { useThemeFollower } from "./theme";
import {
  APPLIED_EVENT,
  REVERTED_EVENT,
  dismissBubble,
  undoLast,
  type AppliedEvent,
  type CorrectionEntry,
} from "./autocorrect";

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

    void listen<AppliedEvent>(APPLIED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.version <= versionRef.current) return;
      versionRef.current = p.version;
      setEntry(p.entry);
      setShown(true);
      if (!pausedRef.current) startTimer();
    }).then((u) => {
      unApplied = u;
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
      clearTimer();
    };
  }, [startTimer]);

  const onUndo = useCallback(() => {
    clearTimer();
    setShown(false);
    // Rust takes the window down and waits for focus to return before injecting
    // — without that, these backspaces would land in this window rather than the
    // user's document.
    void undoLast().catch(() => {});
  }, []);

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
            <span className="truncate text-fg-muted line-through">{entry?.original}</span>
            <span aria-hidden className="shrink-0 text-fg-subtle">
              &rarr;
            </span>
            <span className="truncate font-medium text-fg">{entry?.correction}</span>
          </div>
          <div className="truncate text-[11px] text-fg-subtle">
            {entry?.app || "corrected"}
          </div>
        </div>

        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Undo
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
