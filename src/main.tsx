import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { diffWordsWithSpace, type Change } from "diff";
import type { Node as PMNode } from "@tiptap/pm/model";
import { marked } from "marked";
import DOMPurify from "dompurify";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings as SettingsIcon,
  Info as InfoIcon,
  Sun,
  Moon,
  Monitor,
  X,
  Trash2,
  Sparkles,
  RotateCcw,
  Loader2,
  CheckCircle2,
  XCircle,
  PlugZap,
  ChevronDown,
  Send,
  BookOpen,
  Sparkle,
} from "lucide-react";
import { useTheme, type ThemeChoice } from "./theme";
import "./index.css";

// ---------- Action catalog ----------

type ActionId =
  | "improve"
  | "grammar"
  | "shorten"
  | "expand"
  | "tone:professional"
  | "tone:casual"
  | "tone:friendly"
  | "tone:confident"
  | "custom";

const PRIMARY_ACTIONS: { id: ActionId; label: string }[] = [
  { id: "improve", label: "Improve" },
  { id: "grammar", label: "Fix grammar" },
  { id: "shorten", label: "Shorten" },
  { id: "expand", label: "Expand" },
];

const TONE_ACTIONS: { id: ActionId; label: string }[] = [
  { id: "tone:professional", label: "Professional" },
  { id: "tone:casual", label: "Casual" },
  { id: "tone:friendly", label: "Friendly" },
  { id: "tone:confident", label: "Confident" },
];

// ---------- LLM client ----------

interface RewriteOptions {
  customPrompt?: string;
  signal?: AbortSignal;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMClient {
  rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string>;
  chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<string>;
}

const BASE_SYSTEM_PROMPT =
  "You are an inline writing assistant. Rewrite the user's text per the instruction. " +
  "Reply with ONLY the rewritten text — no preamble, no quotes, no explanation, no surrounding code fences. " +
  "You MAY use Markdown when the rewrite is naturally structured: bullet or numbered lists for enumerations, " +
  "blank-line-separated paragraphs for multi-paragraph prose, **bold** / *italic* for emphasis the user asked for or " +
  "that the source clearly carried, headings for section titles, and `inline code` for code-like fragments. " +
  "Do NOT add structure that isn't warranted: a single sentence stays a single sentence with no formatting.";

const EDU_MARK = "===R3W-EDU===";
const AFFIRM_MARK = "===R3W-AFFIRM===";

interface ParsedReply {
  main: string;
  edu: string;
  affirm: string;
}

function parseFeedback(text: string): ParsedReply {
  if (!text) return { main: "", edu: "", affirm: "" };
  const eduIdx = text.indexOf(EDU_MARK);
  const affIdx = text.indexOf(AFFIRM_MARK);
  if (eduIdx < 0 && affIdx < 0) return { main: text, edu: "", affirm: "" };
  const cuts = [eduIdx, affIdx].filter((i) => i >= 0).sort((a, b) => a - b);
  const main = text.slice(0, cuts[0]).trimEnd();
  let edu = "";
  let affirm = "";
  if (eduIdx >= 0) {
    const next = cuts.find((i) => i > eduIdx);
    edu = text.slice(eduIdx + EDU_MARK.length, next ?? text.length).trim();
  }
  if (affIdx >= 0) {
    const next = cuts.find((i) => i > affIdx);
    affirm = text.slice(affIdx + AFFIRM_MARK.length, next ?? text.length).trim();
  }
  return { main, edu, affirm };
}

function buildSystemPrompt(s: { educational: boolean; affirm: boolean }): string {
  if (!s.educational && !s.affirm) return BASE_SYSTEM_PROMPT;
  let p = BASE_SYSTEM_PROMPT + "\n\nAdditional output channels (after the rewrite, in this order):";
  if (s.educational) {
    p +=
      `\n- On a NEW LINE write the literal token "${EDU_MARK}" followed by 1–2 short, concrete sentences explaining the most important changes you made and why they improve the writing. Be specific to this rewrite, not generic.`;
  }
  if (s.affirm) {
    p +=
      `\n- ${s.educational ? "Then " : ""}On a NEW LINE write the literal token "${AFFIRM_MARK}" followed by ONE short sentence of specific, genuine encouragement about what the user did well in the original — what to keep doing.`;
  }
  p += "\nNever include these tokens or sections unless these instructions explicitly tell you to.";
  return p;
}

function actionInstruction(action: ActionId, customPrompt?: string): string {
  switch (action) {
    case "improve":
      return "Improve clarity, flow, and word choice while preserving meaning and approximate length.";
    case "grammar":
      return "Fix grammar, spelling, and punctuation. Preserve meaning, tone, and length.";
    case "shorten":
      return "Shorten by roughly 30–40% while preserving meaning and key details.";
    case "expand":
      return "Expand with relevant detail and supporting examples while preserving the original tone.";
    case "custom":
      return customPrompt?.trim() || "Rewrite the text.";
    default:
      if (action.startsWith("tone:")) {
        return `Rewrite in a ${action.slice("tone:".length)} tone while preserving meaning.`;
      }
      return "Rewrite the text.";
  }
}

// ---------- Markdown helpers ----------

marked.setOptions({ breaks: true, gfm: true });

function markdownToHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function markdownToPlain(markdown: string): string {
  if (!markdown) return "";
  const html = marked.parse(markdown, { async: false }) as string;
  // Render to a detached DOM node, then collapse to text. Block elements get
  // double-newline separation so list items and paragraphs read naturally
  // when pasted into a plain-text target.
  const root = document.createElement("div");
  root.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  const blockTags = new Set([
    "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "TR",
  ]);
  const out: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      out.push("\n");
      return;
    }
    if (tag === "LI") {
      out.push("\n");
      el.childNodes.forEach(walk);
      return;
    }
    el.childNodes.forEach(walk);
    if (blockTags.has(tag)) out.push("\n\n");
  }
  root.childNodes.forEach(walk);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

const RenderedMarkdown = React.memo(function RenderedMarkdown({
  markdown,
}: {
  markdown: string;
}) {
  const html = useMemo(() => markdownToHtml(markdown), [markdown]);
  return (
    <div
      className="prose-r3w break-words text-fg"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

function phraseFor(elapsedSec: number): string {
  return elapsedSec < 2
    ? "Thinking"
    : elapsedSec < 5
      ? "Generating"
      : elapsedSec < 15
        ? "Working on it"
        : "Still working — large input?";
}

const ThinkingIndicator = React.memo(function ThinkingIndicator({
  startedAt,
  model,
}: {
  startedAt: number | null;
  model?: string;
}) {
  const phraseTextRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (startedAt == null) return;
    let rafId = 0;
    let lastPhrase = "";
    const tick = () => {
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      if (elapsedRef.current) elapsedRef.current.textContent = elapsed.toFixed(1) + "s";
      const next = phraseFor(elapsed);
      if (next !== lastPhrase && phraseTextRef.current) {
        phraseTextRef.current.textContent = next;
        lastPhrase = next;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [startedAt]);

  return (
    <div className="flex items-center gap-2 text-fg-muted">
      <span
        aria-hidden
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-strong border-t-accent"
      />
      <span className="text-fg">
        <span ref={phraseTextRef}>Thinking</span>
        <span aria-hidden className="thinking-dots ml-0.5">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </span>
      {model && <span className="hidden text-fg-subtle sm:inline">· {model}</span>}
      <span ref={elapsedRef} className="ml-auto tabular-nums text-fg-subtle">
        0.0s
      </span>
    </div>
  );
});

interface OllamaSettings {
  provider: "cloud" | "local";
  baseUrl: string;
  model: string;
  apiKey: string;
  educational: boolean;
  affirm: boolean;
}

const DEFAULT_SETTINGS: OllamaSettings = {
  provider: "cloud",
  baseUrl: "https://ollama.com",
  model: "gemma4:31b-cloud",
  apiKey: "",
  educational: false,
  affirm: false,
};

const SETTINGS_KEY = "r3write.settings.v1";

function loadSettings(): OllamaSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: OllamaSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function defaultsForProvider(provider: OllamaSettings["provider"]): Pick<OllamaSettings, "baseUrl" | "model"> {
  return provider === "cloud"
    ? { baseUrl: "https://ollama.com", model: "gemma4:31b-cloud" }
    : { baseUrl: "http://localhost:11434", model: "llama3.2" };
}

class OllamaClient implements LLMClient {
  constructor(private settings: OllamaSettings) {}

  async *chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.provider === "cloud" && this.settings.apiKey) {
      headers["Authorization"] = `Bearer ${this.settings.apiKey}`;
    }
    const body = JSON.stringify({
      model: this.settings.model,
      stream: true,
      messages,
    });

    const res = await tauriFetch(`${this.settings.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers,
      body,
      signal: opts?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      if (opts?.signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            error?: string;
          };
          if (obj.error) throw new Error(obj.error);
          const piece = obj.message?.content;
          if (piece) yield piece;
          if (obj.done) return;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }

  async *rewrite(
    input: string,
    action: ActionId,
    opts?: RewriteOptions,
  ): AsyncIterable<string> {
    const instruction = actionInstruction(action, opts?.customPrompt);
    yield* this.chat(
      [
        { role: "system", content: buildSystemPrompt(this.settings) },
        { role: "user", content: `${instruction}\n\nText:\n${input}` },
      ],
      { signal: opts?.signal },
    );
  }
}

// ---------- App ----------

type Phase = "idle" | "streaming" | "ready" | "error";

function App() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
  });

  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  useEffect(() => {
    saveHistory(history);
  }, [history]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<HistoryEntry>("history:add", (event) => {
      setHistory((h) => [event.payload, ...h].slice(0, 20));
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);
  const [revertError, setRevertError] = useState<string | null>(null);

  const revert = useCallback(
    (entry: HistoryEntry) => {
      if (!editor) return;
      setRevertError(null);
      const range = findTextRangeInDoc(editor.state.doc, entry.rewrite);
      if (!range) {
        setRevertError(
          `Couldn't locate the rewrite in the document — it may have been edited or removed.`,
        );
        return;
      }
      editor
        .chain()
        .focus()
        .setTextSelection(range)
        .insertContent(entry.original)
        .run();
      setHistory((h) => h.filter((x) => x.id !== entry.id));
    },
    [editor],
  );

  if (!editor) return null;

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={500}>
      <div className="flex h-full flex-col bg-bg text-fg">
        <header className="flex h-12 items-center justify-between border-b border-border bg-bg-elev/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-bg-elev/60">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-6 w-6 place-items-center rounded-md bg-accent text-accent-fg"
            >
              <Sparkles size={14} strokeWidth={2.5} />
            </span>
            <h1 className="text-sm font-semibold tracking-tight text-fg">R3write</h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill provider={settings.provider} model={settings.model} />
            <ThemeToggle />
            <IconButton
              label="Info"
              onClick={() => setShowInfo(true)}
              icon={<InfoIcon size={16} />}
            />
            <IconButton
              label="Settings"
              onClick={() => setShowSettings(true)}
              icon={<SettingsIcon size={16} />}
            />
          </div>
        </header>

        <InfoDialog open={showInfo} onOpenChange={setShowInfo} model={settings.model} />
        <SettingsDialog
          open={showSettings}
          onOpenChange={setShowSettings}
          settings={settings}
          onSave={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
        />

        <HistoryListPanel
          entries={history}
          revertError={revertError}
          onRevert={revert}
          onClear={() => {
            setHistory([]);
            setRevertError(null);
          }}
        />

        <div className="hidden">
          <EditorContent editor={editor} />
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function InfoDialog({
  open,
  onOpenChange,
  model,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {open && (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="fixed inset-0 z-40 bg-black/40"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount>
                <motion.div
                  className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-elev p-6 text-fg shadow-md focus:outline-none"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg"
                    >
                      <Sparkles size={16} strokeWidth={2.5} />
                    </span>
                    <Dialog.Title className="text-base font-semibold text-fg">
                      About R3write
                    </Dialog.Title>
                  </div>
                  <Dialog.Description className="sr-only">
                    Usage instructions and current configuration for R3write.
                  </Dialog.Description>

                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <X size={14} />
                    </button>
                  </Dialog.Close>

                  <div className="mt-4 space-y-3 text-sm leading-relaxed text-fg">
                    <p>
                      Select any text in any app, then press{" "}
                      <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">
                        Ctrl + Alt + G
                      </kbd>{" "}
                      to open the rewrite popup.
                    </p>
                    <p className="text-fg-muted">
                      Pick an action — Improve, Fix grammar, Shorten, Expand, or a tone preset — and the
                      rewrite streams in. Accept it to paste back into the source app, or dismiss to keep
                      your original.
                    </p>
                    <p className="text-fg-muted">
                      The model talks to{" "}
                      <span className="text-fg">{model}</span>. Open Settings to switch providers or paste
                      an Ollama Cloud API key.
                    </p>
                  </div>

                  <div className="mt-5 flex justify-end">
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        Got it
                      </button>
                    </Dialog.Close>
                  </div>
                </motion.div>
              </Dialog.Content>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IconButton({
  label,
  onClick,
  icon,
  badge,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="relative grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {icon}
          {badge !== undefined && (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
              {badge}
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function StatusPill({ provider, model }: { provider: OllamaSettings["provider"]; model: string }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-full border border-border bg-bg-elev px-2.5 py-1 text-xs text-fg-muted sm:flex">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="text-fg">{model}</span>
      <span className="text-fg-subtle">·</span>
      <span>{provider === "cloud" ? "cloud" : "local"}</span>
    </span>
  );
}

function ThemeToggle() {
  const { choice, resolved, setTheme } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Toggle theme"
              className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon size={16} />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
          >
            Theme
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="end"
          className="z-50 min-w-[140px] rounded-md border border-border bg-bg-elev p-1 text-sm shadow-md"
        >
          {(
            [
              { v: "system", label: "System", icon: <Monitor size={14} /> },
              { v: "light", label: "Light", icon: <Sun size={14} /> },
              { v: "dark", label: "Dark", icon: <Moon size={14} /> },
            ] as { v: ThemeChoice; label: string; icon: React.ReactNode }[]
          ).map((item) => (
            <DropdownMenu.Item
              key={item.v}
              onSelect={() => setTheme(item.v)}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-bg-subtle"
            >
              <span className="text-fg-muted">{item.icon}</span>
              <span>{item.label}</span>
              {choice === item.v && (
                <span aria-hidden className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------- Bubble UI ----------

// ---------- Settings ----------

function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: OllamaSettings;
  onSave: (s: OllamaSettings) => void;
}) {
  const [draft, setDraft] = useState<OllamaSettings>(settings);
  type TestStatus =
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; ms: number }
    | { kind: "err"; message: string };
  const [test, setTest] = useState<TestStatus>({ kind: "idle" });
  const testAbortRef = useRef<AbortController | null>(null);
  const testCancelledRef = useRef(false);

  // Reset draft and test status when dialog re-opens with potentially newer settings.
  useEffect(() => {
    if (open) {
      setDraft(settings);
      setTest({ kind: "idle" });
    } else {
      testAbortRef.current?.abort();
      testAbortRef.current = null;
    }
  }, [open, settings]);

  // Any field change invalidates a previous result so it doesn't mislead.
  const update = (patch: Partial<OllamaSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTest((t) => (t.kind === "ok" || t.kind === "err" ? { kind: "idle" } : t));
  };

  const cancelTest = () => {
    testCancelledRef.current = true;
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTest({ kind: "idle" });
  };

  const runTest = async () => {
    testAbortRef.current?.abort();
    testCancelledRef.current = false;
    const ctrl = new AbortController();
    testAbortRef.current = ctrl;
    setTest({ kind: "testing" });
    const startedAt = performance.now();
    const timeoutId = window.setTimeout(() => ctrl.abort(), 15000);

    let receivedAny = false;
    let firstTokenAt = 0;
    try {
      const client = new OllamaClient(draft);
      for await (const piece of client.chat(
        [{ role: "user", content: "ping" }],
        { signal: ctrl.signal },
      )) {
        if (piece) {
          receivedAny = true;
          firstTokenAt = performance.now();
          ctrl.abort(); // first token is enough; stop streaming
          break;
        }
      }
      if (receivedAny) {
        setTest({ kind: "ok", ms: Math.round(firstTokenAt - startedAt) });
      } else {
        setTest({ kind: "err", message: "No tokens received" });
      }
    } catch (e: unknown) {
      if (receivedAny) {
        // Our own post-success abort threw — still a pass.
        setTest({ kind: "ok", ms: Math.round(firstTokenAt - startedAt) });
      } else if (testCancelledRef.current) {
        // User clicked Cancel — already reset to idle, don't show error.
      } else {
        const aborted = e instanceof DOMException && e.name === "AbortError";
        const msg =
          e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
        const isTimeout = aborted && performance.now() - startedAt >= 14900;
        setTest({
          kind: "err",
          message: isTimeout ? "Timed out after 15s" : msg.slice(0, 200),
        });
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (testAbortRef.current === ctrl) testAbortRef.current = null;
    }
  };

  const inputCls =
    "w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {open && (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="fixed inset-0 z-40 bg-black/40"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount>
                <motion.div
                  className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-elev p-6 text-fg shadow-md focus:outline-none"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                >
                  <Dialog.Title className="text-base font-semibold text-fg">Settings</Dialog.Title>
                  <Dialog.Description className="mt-0.5 mb-4 text-xs text-fg-muted">
                    Configure your model provider.
                  </Dialog.Description>

                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <X size={14} />
                    </button>
                  </Dialog.Close>

                  <Field label="Provider">
                    <select
                      value={draft.provider}
                      onChange={(e) => {
                        const provider = e.target.value as OllamaSettings["provider"];
                        update({ provider, ...defaultsForProvider(provider) });
                      }}
                      className={inputCls}
                    >
                      <option value="cloud">Ollama Cloud</option>
                      <option value="local">Local Ollama</option>
                    </select>
                  </Field>

                  <Field label="Base URL">
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => update({ baseUrl: e.target.value })}
                      className={inputCls}
                    />
                  </Field>

                  <Field label="Model">
                    <input
                      value={draft.model}
                      onChange={(e) => update({ model: e.target.value })}
                      placeholder="gemma4:31b-cloud"
                      className={inputCls}
                    />
                  </Field>

                  {draft.provider === "cloud" && (
                    <Field label="API key">
                      <input
                        type="password"
                        value={draft.apiKey}
                        onChange={(e) => update({ apiKey: e.target.value })}
                        placeholder="ollama-…"
                        className={inputCls}
                      />
                      <p className="mt-1 text-[11px] text-fg-subtle">
                        Stored in localStorage for now; will move to Windows Credential Manager in a later milestone.
                      </p>
                    </Field>
                  )}

                  <Field label="Feedback">
                    <div className="flex flex-col gap-1.5">
                      <ToggleRow
                        label="Educational"
                        hint="Adds a short note explaining the key changes."
                        checked={draft.educational}
                        onChange={(v) => update({ educational: v })}
                      />
                      <ToggleRow
                        label="Affirmation"
                        hint="Adds a brief encouraging note about your original."
                        checked={draft.affirm}
                        onChange={(v) => update({ affirm: v })}
                      />
                    </div>
                  </Field>

                  <div className="mt-5 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={test.kind === "testing" ? cancelTest : runTest}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      {test.kind === "testing" ? (
                        <>
                          <Loader2 size={14} className="animate-spin text-fg-muted" />
                          Stop test
                        </>
                      ) : (
                        <>
                          <PlugZap size={14} className="text-fg-muted" />
                          Test connection
                        </>
                      )}
                    </button>
                    <div className="flex items-center gap-2">
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          Cancel
                        </button>
                      </Dialog.Close>
                      <button
                        type="button"
                        onClick={() => onSave(draft)}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        Save
                      </button>
                    </div>
                  </div>

                  {test.kind === "ok" && (
                    <div
                      role="status"
                      className="mt-3 flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs text-fg"
                    >
                      <CheckCircle2 size={14} className="text-r3w-add-fg" />
                      <span>
                        Connected · first token in{" "}
                        <span className="tabular-nums">{test.ms}</span> ms
                      </span>
                    </div>
                  )}
                  {test.kind === "err" && (
                    <div
                      role="alert"
                      className="mt-3 flex items-start gap-2 rounded-md border border-border bg-danger-bg px-3 py-2 text-xs text-danger"
                    >
                      <XCircle size={14} className="mt-0.5 flex-none" />
                      <span className="break-words">{test.message}</span>
                    </div>
                  )}
                </motion.div>
              </Dialog.Content>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-3 rounded-md border border-border bg-bg p-2.5 text-left transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="flex-1">
        <span className="block text-sm text-fg">{label}</span>
        <span className="mt-0.5 block text-[11px] text-fg-muted">{hint}</span>
      </span>
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "bg-accent" : "bg-border-strong"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-bg-elev shadow-sm transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

// ---------- Quick-edit popup ----------
//
// Rendered in the frameless `quick-edit` window opened by the Rust shortcut
// handler (Ctrl+Alt+G). Receives the captured selection via the
// "captured-text" event, runs an action through the same OllamaClient, and
// asks Rust to paste the rewrite back into the originating app.

interface Turn {
  id: string;
  user: string;
  assistant: string;
  userLabel: string;
}

function Chip({
  children,
  onClick,
  active,
  primary,
  disabled,
  shortcut,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  const base =
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const tone = disabled
    ? "bg-bg-subtle text-fg-subtle cursor-not-allowed"
    : primary
      ? "bg-accent text-accent-fg hover:bg-accent-hover"
      : active
        ? "bg-bg-subtle text-fg ring-1 ring-border-strong"
        : "bg-bg-subtle text-fg-muted hover:bg-bg-elev hover:text-fg";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tone}`}>
      <span>{children}</span>
      {shortcut && (
        <kbd className="ml-1 rounded border border-border bg-bg px-1 font-mono text-[10px] text-fg-subtle">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

type ViewMode = "rendered" | "diff";

const TurnItem = React.memo(
  function TurnItem({
    turn,
    isFirst,
    isLast,
    isStreaming,
    firstTokenMs,
    streamStartedAt,
    streamingNodeRef,
    model,
    viewMode,
    originalText,
  }: {
    turn: Turn;
    isFirst: boolean;
    isLast: boolean;
    isStreaming: boolean;
    firstTokenMs: number | null;
    streamStartedAt: number | null;
    streamingNodeRef: React.RefObject<HTMLDivElement>;
    model: string;
    viewMode: ViewMode;
    originalText: string;
  }) {
    const containerCls = isFirst ? "" : "mt-3 border-t border-border pt-3";
    const mainText = useMemo(
      () => parseFeedback(turn.assistant).main || turn.assistant,
      [turn.assistant],
    );
    const showDiff = isLast && !isStreaming && viewMode === "diff" && !!mainText;
    return (
      <div className={containerCls}>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
          ▶ {turn.userLabel}
        </div>
        <div className="mt-1 break-words text-fg">
          {isStreaming ? (
            firstTokenMs === null ? (
              <ThinkingIndicator startedAt={streamStartedAt} model={model} />
            ) : (
              <>
                <div
                  ref={streamingNodeRef}
                  className="whitespace-pre-wrap font-mono text-[13px] text-fg"
                />
                <span className="ml-0.5 animate-pulse text-accent">▍</span>
              </>
            )
          ) : showDiff ? (
            <DiffView original={originalText} rewrite={mainText} />
          ) : mainText ? (
            <RenderedMarkdown markdown={mainText} />
          ) : (
            <span className="text-fg-subtle">(no response)</span>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.turn.id === next.turn.id &&
    prev.turn.assistant === next.turn.assistant &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming &&
    prev.firstTokenMs === next.firstTokenMs &&
    prev.streamStartedAt === next.streamStartedAt &&
    prev.model === next.model &&
    prev.viewMode === next.viewMode &&
    prev.originalText === next.originalText,
);

function QuickEdit() {
  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  const clientRef = useRef<OllamaClient>(new OllamaClient(settings));
  useEffect(() => {
    clientRef.current = new OllamaClient(settings);
  }, [settings]);

  const [input, setInput] = useState<string>("");
  const [thread, setThread] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [firstAction, setFirstAction] = useState<ActionId | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const streamingNodeRef = useRef<HTMLDivElement>(null!);
  const streamingBufferRef = useRef("");

  useEffect(() => {
    if (threadScrollRef.current) {
      threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
    }
  }, [thread]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("captured-text", (event) => {
      abortRef.current?.abort();
      streamingBufferRef.current = "";
      setSettings(loadSettings());
      setInput(event.payload);
      setThread([]);
      setPhase("idle");
      setErrorMsg(null);
      setFirstAction(null);
      setShowCustom(false);
      setCustomDraft("");
      setFollowUp("");
      setViewMode("rendered");
      setStreamStartedAt(null);
      setFirstTokenMs(null);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    void invoke("dismiss_popup");
  }, []);

  // Stop the in-flight stream WITHOUT dismissing the popup. Commits whatever
  // tokens already arrived to thread state so the user can read / accept /
  // regenerate the partial result.
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const partial = streamingBufferRef.current;
    setThread((tt) => {
      if (tt.length === 0) return tt;
      const copy = [...tt];
      copy[copy.length - 1] = { ...copy[copy.length - 1], assistant: partial };
      return copy;
    });
    setPhase("ready");
    setStreamStartedAt(null);
  }, []);

  // Token-by-token DOM writes via rAF instead of setState — keeps React commits
  // to ~3 per response (start, first-token, final) regardless of token count,
  // and avoids re-parsing Markdown on every chunk.
  const streamInto = useCallback(async (next: Turn[]) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = Date.now();
    setPhase("streaming");
    setStreamStartedAt(startedAt);
    setFirstTokenMs(null);
    setErrorMsg(null);
    streamingBufferRef.current = "";
    setThread(next);

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(settings) },
    ];
    for (const t of next) {
      messages.push({ role: "user", content: t.user });
      if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
    }

    let rafScheduled = false;
    const flushToDOM = () => {
      rafScheduled = false;
      const node = streamingNodeRef.current;
      if (node) node.textContent = streamingBufferRef.current;
      if (threadScrollRef.current) {
        threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
      }
    };

    try {
      let firstSeen = false;
      for await (const chunk of clientRef.current.chat(messages, { signal: ctrl.signal })) {
        if (ctrl.signal.aborted) return;
        if (!firstSeen && chunk) {
          firstSeen = true;
          setFirstTokenMs(Date.now() - startedAt);
        }
        streamingBufferRef.current += chunk;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushToDOM);
        }
      }
      if (!ctrl.signal.aborted) {
        const finalAssistant = streamingBufferRef.current;
        setThread((tt) => {
          if (tt.length === 0) return tt;
          const copy = [...tt];
          copy[copy.length - 1] = { ...copy[copy.length - 1], assistant: finalAssistant };
          return copy;
        });
        setPhase("ready");
        setStreamStartedAt(null);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
      setStreamStartedAt(null);
    }
  }, [settings]);

  const runAction = useCallback(
    (action: ActionId, customPromptOverride?: string) => {
      if (!input.trim()) return;
      const instruction = actionInstruction(action, customPromptOverride);
      const userLabel =
        action === "custom" ? customPromptOverride || "Custom" : actionLabel(action);
      setFirstAction(action);
      setShowCustom(false);
      setCustomDraft("");
      void streamInto([
        { id: cryptoId(), user: `${instruction}\n\nText:\n${input}`, assistant: "", userLabel },
      ]);
    },
    [input, streamInto],
  );

  const sendFollowUp = useCallback(
    (user: string, userLabel: string) => {
      if (thread.length === 0 || phase === "streaming") return;
      void streamInto([...thread, { id: cryptoId(), user, assistant: "", userLabel }]);
    },
    [thread, phase, streamInto],
  );

  const submitFollowUp = useCallback(() => {
    const text = followUp.trim();
    if (!text) return;
    setFollowUp("");
    sendFollowUp(text, text);
  }, [followUp, sendFollowUp]);

  const regenerate = useCallback(() => {
    if (thread.length === 0) return;
    const last = thread[thread.length - 1];
    void streamInto([...thread.slice(0, -1), { ...last, id: cryptoId(), assistant: "" }]);
  }, [thread, streamInto]);

  const accept = useCallback(async () => {
    const last = thread[thread.length - 1];
    if (!last?.assistant.trim() || !firstAction) return;
    const main = parseFeedback(last.assistant).main || last.assistant;
    const pasteText = markdownToPlain(main) || main;
    const entry: HistoryEntry = {
      id: cryptoId(),
      timestamp: Date.now(),
      action: firstAction,
      original: input,
      rewrite: pasteText,
    };
    try {
      await emitTo("main", "history:add", entry);
    } catch (e) {
      console.error("[r3write] history emitTo(main) failed:", e);
    }
    try {
      await emit("history:add", entry);
    } catch (e) {
      console.error("[r3write] history emit(broadcast) failed:", e);
    }
    void invoke("accept_rewrite", { text: pasteText });
  }, [thread, input, firstAction]);

  // Keyboard:
  //   Esc        → dismiss (any phase)
  //   1..4 / c   → primary actions / open custom (idle, no thread)
  //   Enter      → accept (ready phase)
  // Disabled inside inputs/textareas so typing isn't intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (thread.length === 0) {
        const idleMap: Record<string, ActionId | "custom-open"> = {
          "1": "improve",
          "2": "grammar",
          "3": "shorten",
          "4": "expand",
          c: "custom-open",
          C: "custom-open",
        };
        const a = idleMap[e.key];
        if (!a) return;
        e.preventDefault();
        if (a === "custom-open") setShowCustom(true);
        else runAction(a);
        return;
      }
      if (phase === "ready") {
        if (e.key === "Enter") {
          e.preventDefault();
          void accept();
          return;
        }
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          regenerate();
          return;
        }
      }
      if (phase === "error" && (e.key === "r" || e.key === "R" || e.key === "Enter")) {
        e.preventDefault();
        regenerate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, thread.length, phase, runAction, accept, regenerate]);

  const lastAssistant = thread[thread.length - 1]?.assistant ?? "";
  const parsedLast = useMemo(() => parseFeedback(lastAssistant), [lastAssistant]);

  // +N -M words shown only after streaming completes (one-shot diff vs parsed.main).
  const wordDelta = useMemo(() => {
    if (phase !== "ready" || !parsedLast.main || !input) return null;
    const rewritePlain = markdownToPlain(parsedLast.main) || parsedLast.main;
    const parts = diffWordsWithSpace(input, rewritePlain);
    let added = 0;
    let removed = 0;
    for (const p of parts) {
      const words = p.value.trim() ? p.value.trim().split(/\s+/).length : 0;
      if (p.added) added += words;
      else if (p.removed) removed += words;
    }
    return { added, removed };
  }, [phase, parsedLast.main, input]);

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={500}>
      <div className="relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-bg-elev text-fg shadow-[var(--shadow-md)]">
        <div
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if (
              (e.target as HTMLElement).closest("button, input, textarea, a, [data-no-drag]")
            )
              return;
            void getCurrentWebviewWindow().startDragging();
          }}
          className="flex h-9 cursor-move select-none items-center justify-between border-b border-border bg-bg-elev/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-bg-elev/60"
        >
          <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-5 w-5 place-items-center rounded-md bg-accent text-accent-fg"
            >
              <Sparkles size={11} strokeWidth={2.5} />
            </span>
            <span className="text-[11px] font-medium text-fg">R3write</span>
            <span className="text-[11px] text-fg-subtle">·</span>
            <span className="text-[11px] text-fg-muted">{settings.model}</span>
          </div>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onClick={dismiss}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Close"
                className="grid h-6 w-6 place-items-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X size={13} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={6}
                className="rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
              >
                Close (Esc)
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>

        <div
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            void getCurrentWebviewWindow().startResizeDragging("SouthEast");
          }}
          title="Drag to resize"
          aria-hidden
          className="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-se-resize"
          style={{
            background:
              "linear-gradient(135deg, transparent 0 50%, var(--fg-subtle) 50% 60%, transparent 60% 70%, var(--fg-subtle) 70% 80%, transparent 80%)",
          }}
        />

        <div className="flex flex-1 flex-col gap-2 overflow-hidden p-3">
          <div className="space-y-0.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
              Original
            </div>
            <div className="max-h-16 overflow-y-auto rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-fg-muted">
              {input || (
                <span className="italic text-fg-subtle">
                  Select text in any app, then press Ctrl + Alt + G.
                </span>
              )}
            </div>
          </div>

          {thread.length === 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {PRIMARY_ACTIONS.map((a, idx) => (
                  <Chip key={a.id} onClick={() => runAction(a.id)} shortcut={String(idx + 1)}>
                    {a.label}
                  </Chip>
                ))}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-xs font-medium text-fg-muted transition hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      Tone
                      <ChevronDown size={11} className="text-fg-subtle" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={4}
                      className="z-50 min-w-[160px] rounded-md border border-border bg-bg-elev p-1 text-sm shadow-md"
                    >
                      {TONE_ACTIONS.map((a) => (
                        <DropdownMenu.Item
                          key={a.id}
                          onSelect={() => runAction(a.id)}
                          className="cursor-pointer rounded px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-bg-subtle"
                        >
                          {a.label}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <Chip onClick={() => setShowCustom((v) => !v)} active={showCustom} shortcut="C">
                  Custom…
                </Chip>
              </div>
              {showCustom && (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customDraft.trim()) {
                        runAction("custom", customDraft.trim());
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setShowCustom(false);
                      }
                    }}
                    placeholder="Describe the rewrite…"
                    className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/40"
                  />
                  <Chip
                    onClick={() => customDraft.trim() && runAction("custom", customDraft.trim())}
                    primary
                    disabled={!customDraft.trim()}
                  >
                    Run
                  </Chip>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div
                    ref={threadScrollRef}
                    className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-bg p-2 text-sm"
                  >
                    {thread.map((turn, i) => {
                      const isLast = i === thread.length - 1;
                      return (
                        <TurnItem
                          key={turn.id}
                          turn={turn}
                          isFirst={i === 0}
                          isLast={isLast}
                          isStreaming={isLast && phase === "streaming"}
                          firstTokenMs={isLast && phase === "streaming" ? firstTokenMs : null}
                          streamStartedAt={streamStartedAt}
                          streamingNodeRef={streamingNodeRef}
                          model={settings.model}
                          viewMode={viewMode}
                          originalText={input}
                        />
                      );
                    })}
                  </div>

                  {phase === "ready" && (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
                      <span className="truncate">
                        {wordDelta && (
                          <>
                            <span className="text-r3w-add-fg">+{wordDelta.added}</span>{" "}
                            <span className="text-r3w-del-fg">−{wordDelta.removed}</span> words
                          </>
                        )}
                        {wordDelta && firstTokenMs !== null && " · "}
                        {firstTokenMs !== null && (
                          <span className="tabular-nums">first token {firstTokenMs} ms</span>
                        )}
                      </span>
                      <div
                        role="tablist"
                        aria-label="View mode"
                        className="flex gap-0.5 rounded-md bg-bg-subtle p-0.5"
                      >
                        {(["rendered", "diff"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            role="tab"
                            aria-selected={viewMode === m}
                            onClick={() => setViewMode(m)}
                            className={
                              viewMode === m
                                ? "rounded px-2 py-0.5 text-[11px] font-medium text-fg bg-bg-elev shadow-[var(--shadow-sm)]"
                                : "rounded px-2 py-0.5 text-[11px] font-medium text-fg-muted hover:text-fg"
                            }
                          >
                            {m === "rendered" ? "Rendered" : "Diff"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {phase === "ready" && (parsedLast.edu || parsedLast.affirm) && (
                  <motion.aside
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="flex w-[240px] shrink-0 flex-col gap-2 overflow-y-auto"
                    aria-label="Feedback channels"
                  >
                    {parsedLast.edu && (
                      <div className="rounded-md border border-border bg-bg-subtle p-2.5">
                        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                          <BookOpen size={12} className="text-accent" />
                          Why this works
                        </div>
                        <RenderedMarkdown markdown={parsedLast.edu} />
                      </div>
                    )}
                    {parsedLast.affirm && (
                      <div className="rounded-md border border-border bg-bg-subtle p-2.5">
                        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                          <Sparkle size={12} className="text-accent" />
                          Note
                        </div>
                        <RenderedMarkdown markdown={parsedLast.affirm} />
                      </div>
                    )}
                  </motion.aside>
                )}
              </div>

              {phase === "error" && (
                <div role="alert" className="rounded-md bg-danger-bg px-2 py-1.5 text-xs text-danger">
                  {errorMsg || "Rewrite failed."}
                </div>
              )}

              {phase !== "streaming" && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap gap-1">
                    {TONE_ACTIONS.map((a) => (
                      <Chip
                        key={a.id}
                        onClick={() =>
                          sendFollowUp(actionInstruction(a.id), `Tone: ${a.id.slice(5)}`)
                        }
                      >
                        {a.label}
                      </Chip>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <input
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitFollowUp();
                      }}
                      placeholder="Follow up… (e.g. more concise, more formal)"
                      className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/40"
                    />
                    <button
                      type="button"
                      onClick={submitFollowUp}
                      disabled={!followUp.trim()}
                      aria-label="Send follow-up"
                      className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <Send size={13} />
                    </button>
                  </div>
                </div>
              )}

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={phase}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="flex items-center justify-end gap-1"
                >
                  {phase === "streaming" && (
                    <>
                      <Chip onClick={dismiss}>Cancel</Chip>
                      <Chip onClick={stop} primary>
                        Stop
                      </Chip>
                    </>
                  )}
                  {phase === "ready" && (
                    <>
                      <Chip onClick={dismiss} shortcut="Esc">
                        Reject
                      </Chip>
                      <Chip onClick={regenerate} shortcut="R">
                        Regenerate
                      </Chip>
                      <Chip
                        onClick={accept}
                        primary
                        disabled={!lastAssistant.trim()}
                        shortcut="↵"
                      >
                        Accept &amp; paste
                      </Chip>
                    </>
                  )}
                  {phase === "error" && (
                    <>
                      <Chip onClick={dismiss} shortcut="Esc">
                        Dismiss
                      </Chip>
                      <Chip onClick={regenerate} primary shortcut="R">
                        Retry
                      </Chip>
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </>
          )}
        </div>
      </div>
    </Tooltip.Provider>
  );
}

// ---------- Diff view ----------

function DiffView({ original, rewrite }: { original: string; rewrite: string }) {
  // Strip Markdown from the rewrite first so the inline word diff doesn't
  // light up `**`, `*`, `#`, list bullets etc. as additions against a plain
  // original. The original is captured via clipboard text, so it's plain.
  const rewritePlain = useMemo(() => markdownToPlain(rewrite) || rewrite, [rewrite]);
  const parts: Change[] = useMemo(
    () => diffWordsWithSpace(original, rewritePlain),
    [original, rewritePlain],
  );
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed text-fg">
      {parts.map((p, i) => {
        if (p.added) {
          return (
            <span key={i} className="rounded bg-r3w-add px-0.5 text-r3w-add-fg">
              {p.value}
            </span>
          );
        }
        if (p.removed) {
          return (
            <span key={i} className="rounded bg-r3w-del px-0.5 text-r3w-del-fg line-through">
              {p.value}
            </span>
          );
        }
        return <span key={i}>{p.value}</span>;
      })}
    </div>
  );
}

// ---------- History ----------

const HISTORY_KEY = "r3write.history.v1";

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {}
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  action: ActionId;
  original: string;
  rewrite: string;
}

function actionLabel(id: ActionId): string {
  switch (id) {
    case "improve":
      return "Improve";
    case "grammar":
      return "Fix grammar";
    case "shorten":
      return "Shorten";
    case "expand":
      return "Expand";
    case "custom":
      return "Custom";
    default:
      if (id.startsWith("tone:")) return `Tone: ${id.slice("tone:".length)}`;
      return id;
  }
}

function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Walks the ProseMirror doc and finds `needle` in the concatenated text.
// Returns the PM range, or null if missing or non-unique.
function findTextRangeInDoc(doc: PMNode, needle: string): { from: number; to: number } | null {
  if (!needle) return null;
  const positions: number[] = [];
  let text = "";
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) positions.push(pos + i);
      text += node.text;
    }
    return true;
  });
  const idx = text.indexOf(needle);
  if (idx === -1) return null;
  if (text.indexOf(needle, idx + 1) !== -1) return null;
  const from = positions[idx];
  const to = positions[idx + needle.length - 1] + 1;
  return { from, to };
}

const HistoryRow = React.memo(
  function HistoryRow({
    entry,
    now,
    onRevert,
  }: {
    entry: HistoryEntry;
    now: number;
    onRevert: (e: HistoryEntry) => void;
  }) {
    const exact = useMemo(() => new Date(entry.timestamp).toLocaleString(), [entry.timestamp]);
    return (
      <li className="rounded-lg border border-border bg-bg-subtle p-3 text-sm transition hover:border-border-strong">
        <div className="mb-2 flex items-center justify-between gap-2">
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className="cursor-default text-xs font-medium text-fg-muted">
                {actionLabel(entry.action)} · {timeAgo(entry.timestamp, now)}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={4}
                className="rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
              >
                {exact}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <button
            type="button"
            onClick={() => onRevert(entry)}
            className="inline-flex items-center gap-1 rounded-md bg-bg-elev px-2 py-1 text-xs font-medium text-fg-muted transition hover:bg-bg hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <RotateCcw size={12} />
            Revert
          </button>
        </div>
        <DiffView original={entry.original} rewrite={entry.rewrite} />
      </li>
    );
  },
  (prev, next) =>
    prev.entry.id === next.entry.id &&
    prev.onRevert === next.onRevert &&
    Math.floor(prev.now / 30000) === Math.floor(next.now / 30000),
);

function HistoryListPanel({
  entries,
  revertError,
  onRevert,
  onClear,
}: {
  entries: HistoryEntry[];
  revertError: string | null;
  onRevert: (e: HistoryEntry) => void;
  onClear: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="flex flex-1 flex-col overflow-hidden bg-bg-elev text-fg">
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">History</h2>
        {entries.length > 0 && (
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onClick={onClear}
                aria-label="Clear all"
                className="grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Trash2 size={14} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={6}
                className="rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
              >
                Clear all
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        )}
      </div>
      {revertError && (
        <div
          role="alert"
          className="border-b border-border bg-danger-bg px-4 py-2 text-xs text-danger"
        >
          {revertError}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {entries.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="text-sm text-fg-muted">No rewrites yet.</p>
              <p className="mt-1 text-xs text-fg-subtle">
                Press Ctrl + Alt + G on selected text to start.
              </p>
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {entries.map((e) => (
              <HistoryRow key={e.id} entry={e} now={now} onRevert={onRevert} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------- Window routing ----------

function getWindowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
const label = getWindowLabel();
root.render(
  <React.StrictMode>{label === "quick-edit" ? <QuickEdit /> : <App />}</React.StrictMode>,
);
