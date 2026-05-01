import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

export type ThemeChoice = "system" | "light" | "dark";
export type ThemeResolved = "light" | "dark";

const STORAGE_KEY = "r3write.theme.v1";
const THEME_EVENT = "theme:change";

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

function systemPrefers(): ThemeResolved {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(choice: ThemeChoice): ThemeResolved {
  return choice === "system" ? systemPrefers() : choice;
}

function applyTheme(resolved: ThemeResolved) {
  const html = document.documentElement;
  const apply = () => {
    html.dataset.theme = resolved;
  };
  // Prefer view-transition for a free crossfade where supported (WebView2 122+).
  const startVT = (document as any).startViewTransition?.bind(document);
  if (typeof startVT === "function") {
    startVT(apply);
  } else {
    apply();
  }
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());
  const [resolved, setResolved] = useState<ThemeResolved>(() => resolve(readChoice()));

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Watch system theme changes when in "system" mode.
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [choice]);

  // Pick up theme changes broadcast from another window (e.g. main window
  // toggles theme; this hook may be running there OR in the popup).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ choice: ThemeChoice }>(THEME_EVENT, (e) => {
      const next = e.payload?.choice ?? readChoice();
      setChoiceState(next);
      setResolved(resolve(next));
    }).then((u) => {
      unlisten = u;
    });
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== STORAGE_KEY && ev.key !== null) return;
      const next = readChoice();
      setChoiceState(next);
      setResolved(resolve(next));
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    setResolved(resolve(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    void emit(THEME_EVENT, { choice: next }).catch(() => {});
  }, []);

  return { choice, resolved, setTheme } as const;
}

// Read-only theme synchroniser for windows that don't expose a theme picker
// (e.g. the quick-edit popup). Applies the current theme on mount and stays
// in sync via Tauri's broadcast event + localStorage's `storage` event +
// `matchMedia` for system-mode OS-level theme flips.
export function useThemeFollower() {
  useEffect(() => {
    const apply = () => applyTheme(resolve(readChoice()));
    apply();

    let unlisten: (() => void) | undefined;
    void listen<{ choice: ThemeChoice }>(THEME_EVENT, () => apply()).then((u) => {
      unlisten = u;
    });

    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== STORAGE_KEY && ev.key !== null) return;
      apply();
    };
    window.addEventListener("storage", onStorage);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => {
      if (readChoice() === "system") apply();
    };
    mq.addEventListener("change", onMq);

    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
      mq.removeEventListener("change", onMq);
    };
  }, []);
}
