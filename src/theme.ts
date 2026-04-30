import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type ThemeResolved = "light" | "dark";

const STORAGE_KEY = "r3write.theme.v1";

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

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    setResolved(resolve(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  return { choice, resolved, setTheme } as const;
}
