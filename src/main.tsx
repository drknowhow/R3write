import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { diffWordsWithSpace, type Change } from "diff";
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
  RotateCcw,
  Loader2,
  CheckCircle2,
  XCircle,
  PlugZap,
  ChevronDown,
  Send,
  BookOpen,
  Sparkle,
  Coffee,
  Heart,
  ExternalLink,
  Minus,
  Square,
} from "lucide-react";
import { useTheme, useThemeFollower, type ThemeChoice } from "./theme";
import { useLicense, LS_CHECKOUT_URL, type LicenseState, type UseLicense } from "./license";
import {
  APPLIED_EVENT,
  ARBITRATE_EVENT,
  REVERTED_EVENT,
  clearLog,
  getLog,
  installerOptIn,
  sendLlmSuggestion,
  setConfig as setAutocorrectConfig,
  setLicenseActive,
  type AppliedEvent,
  type ArbitrateEvent,
  type CorrectionEntry,
  type RevertedEvent,
} from "./autocorrect";
import "./index.css";
import appIconUrl from "./icon.png";

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
  | "prompt:compress"
  | "prompt:distill"
  | "prompt:structure"
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

// Rewrite the selection as a prompt for an LLM / agent. Goal: cut tokens
// without losing instructions, constraints, examples, or named entities.
const PROMPT_ACTIONS: { id: ActionId; label: string }[] = [
  { id: "prompt:compress", label: "Compress tokens" },
  { id: "prompt:distill", label: "Distill intent" },
  { id: "prompt:structure", label: "Structure for agents" },
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

function buildSystemPrompt(s: {
  educational: boolean;
  affirm: boolean;
  styleGuide?: string;
  protectedTerms?: string;
}): string {
  let p = BASE_SYSTEM_PROMPT;
  const sg = (s.styleGuide || "").trim();
  if (sg) {
    p += `\n\nStyle guide (apply to all rewrites unless the user's instruction explicitly overrides it):\n${sg}`;
  }
  const terms = parseProtectedTerms(s.protectedTerms || "");
  if (terms.length > 0) {
    p +=
      "\n\nProtected terms — preserve these tokens VERBATIM (case + spelling): " +
      terms.map((t) => `\`${t}\``).join(", ") +
      ". Do not translate, pluralize, hyphenate, or otherwise alter them.";
  }
  if (!s.educational && !s.affirm) return p;
  p += "\n\nAdditional output channels (after the rewrite, in this order):";
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

// Split a comma- or newline-separated list of protected terms. Whitespace is
// trimmed and empties are dropped. Casing is preserved — the model is told to
// keep it verbatim.
function parseProtectedTerms(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 64);
}

// Rough token estimate — 4 chars per token is a standard approximation that
// works well enough for cost/length warnings without pulling in tiktoken.
function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
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
    case "prompt:compress":
      return (
        "Rewrite the text as an LLM/agent prompt with the smallest possible token count. " +
        "Preserve every instruction, constraint, requirement, example, named entity, identifier, and quoted string verbatim. " +
        "Cut filler, hedges, politeness, redundant phrasings, and meta-commentary; merge restatements; prefer imperatives and short clauses. " +
        "Do not add new requirements, examples, or formatting that wasn't in the original."
      );
    case "prompt:distill":
      return (
        "Distill the text to the core intent of an LLM/agent prompt. " +
        "Keep only what is strictly required to produce the desired output: the goal, hard constraints, output format, and any literal values that must appear verbatim. " +
        "Drop background, motivation, soft preferences, and anything decorative. Output only the rewritten prompt."
      );
    case "prompt:structure":
      return (
        "Restructure the text as an LLM/agent prompt using these sections, in this order, omitting any section that has no content: " +
        "`Role` (one line), `Goal` (one sentence), `Inputs`, `Constraints`, `Output format`, `Examples`. " +
        "Use short imperatives and bullet points. Preserve every original requirement and any literal values verbatim. Do not invent new requirements."
      );
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

interface HotkeyBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  code: string; // DOM KeyboardEvent.code, e.g. "KeyG"
}

const DEFAULT_HOTKEY: HotkeyBinding = {
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
  code: "KeyG",
};

function sameHotkey(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.code === b.code
  );
}

function formatHotkey(h: HotkeyBinding): string {
  const parts: string[] = [];
  if (h.ctrl) parts.push("Ctrl");
  if (h.alt) parts.push("Alt");
  if (h.shift) parts.push("Shift");
  if (h.meta) parts.push("Win");
  parts.push(prettyKeyCode(h.code));
  return parts.join(" + ");
}

function keyMatchesBinding(e: KeyboardEvent, b: HotkeyBinding): boolean {
  // Treat numpad Enter as the same physical key for binding purposes.
  const eCode = e.code === "NumpadEnter" ? "Enter" : e.code;
  const bCode = b.code === "NumpadEnter" ? "Enter" : b.code;
  return (
    eCode === bCode &&
    e.ctrlKey === b.ctrl &&
    e.altKey === b.alt &&
    e.shiftKey === b.shift &&
    e.metaKey === b.meta
  );
}

type BubbleShortcutId =
  | "improve"
  | "grammar"
  | "shorten"
  | "expand"
  | "custom"
  | "accept"
  | "regenerate";

type BubbleShortcuts = Record<BubbleShortcutId, HotkeyBinding>;

const DEFAULT_BUBBLE_SHORTCUTS: BubbleShortcuts = {
  improve: { ctrl: false, alt: false, shift: false, meta: false, code: "Digit1" },
  grammar: { ctrl: false, alt: false, shift: false, meta: false, code: "Digit2" },
  shorten: { ctrl: false, alt: false, shift: false, meta: false, code: "Digit3" },
  expand: { ctrl: false, alt: false, shift: false, meta: false, code: "Digit4" },
  custom: { ctrl: false, alt: false, shift: false, meta: false, code: "KeyC" },
  accept: { ctrl: false, alt: false, shift: false, meta: false, code: "Enter" },
  regenerate: { ctrl: false, alt: false, shift: false, meta: false, code: "KeyR" },
};

function prettyKeyCode(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  switch (code) {
    case "Space": return "Space";
    case "Tab": return "Tab";
    case "Enter": return "Enter";
    case "Backspace": return "Backspace";
    case "ArrowUp": return "↑";
    case "ArrowDown": return "↓";
    case "ArrowLeft": return "←";
    case "ArrowRight": return "→";
    case "Comma": return ",";
    case "Period": return ".";
    case "Slash": return "/";
    case "Backquote": return "`";
    case "Minus": return "-";
    case "Equal": return "=";
    case "Semicolon": return ";";
    case "Quote": return "'";
    case "BracketLeft": return "[";
    case "BracketRight": return "]";
    case "Backslash": return "\\";
    default: return code;
  }
}

// Catalog of supported model providers. "ollama-cloud" / "ollama-local" are
// the original two; the rest were added as part of the multi-provider rollout.
// Legacy "cloud" / "local" values in localStorage are migrated below.
type Provider =
  | "ollama-cloud"
  | "ollama-local"
  | "gemini"
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter";

// "free"      — runs on the user's hardware, no key required.
// "free-tier" — cloud provider with a free quota; BYO key.
// "byok"      — cloud provider, paid-only; BYO key.
type ProviderTier = "free" | "free-tier" | "byok";

const PROVIDER_LABELS: Record<Provider, string> = {
  "ollama-cloud": "Ollama Cloud",
  "ollama-local": "Local Ollama",
  "gemini":       "Google Gemini",
  "openai":       "OpenAI",
  "anthropic":    "Anthropic",
  "groq":         "Groq",
  "openrouter":   "OpenRouter",
};

const PROVIDER_DEFAULTS: Record<
  Provider,
  { baseUrl: string; model: string; needsKey: boolean; tier: ProviderTier; keyHint?: string }
> = {
  "ollama-cloud": { baseUrl: "https://ollama.com", model: "gemma4:31b-cloud", needsKey: true, tier: "free-tier", keyHint: "ollama-…" },
  "ollama-local": { baseUrl: "http://localhost:11434", model: "llama3.2", needsKey: false, tier: "free" },
  "gemini":       { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", needsKey: true, tier: "free-tier", keyHint: "AIza…" },
  "openai":       { baseUrl: "https://api.openai.com", model: "gpt-4.1-mini", needsKey: true, tier: "byok", keyHint: "sk-…" },
  "anthropic":    { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6", needsKey: true, tier: "byok", keyHint: "sk-ant-…" },
  "groq":         { baseUrl: "https://api.groq.com", model: "llama-3.3-70b-versatile", needsKey: true, tier: "free-tier", keyHint: "gsk_…" },
  "openrouter":   { baseUrl: "https://openrouter.ai", model: "anthropic/claude-sonnet-4", needsKey: true, tier: "free-tier", keyHint: "sk-or-…" },
};

// Display order for the Settings → Provider dropdown. Free / free-tier on top
// so users land on a zero-cost path; default (ollama-cloud) is first within
// that group so it stays the obvious choice for new installs.
const PROVIDER_ORDER: Provider[] = [
  "ollama-cloud",
  "ollama-local",
  "gemini",
  "groq",
  "openrouter",
  "openai",
  "anthropic",
];

function providerTierLabel(p: Provider): string {
  const t = PROVIDER_DEFAULTS[p].tier;
  if (t === "free") return "Free";
  if (t === "free-tier") return "Free tier · BYO key";
  return "BYO key";
}

interface SavedTemplate {
  id: string;
  name: string;
  prompt: string;
}

type ViewMode = "rendered" | "diff";
type PopupAnchor = "mouse" | "selection" | "center";

interface OllamaSettings {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  educational: boolean;
  affirm: boolean;
  hotkey: HotkeyBinding;
  bubbleShortcuts: BubbleShortcuts;
  // v2 additions — all optional via DEFAULT_SETTINGS so older payloads merge
  // cleanly. See loadSettings for migration of legacy provider values.
  viewMode: ViewMode;
  lastAction: ActionId | null;
  customPromptHistory: string[];
  savedTemplates: SavedTemplate[];
  styleGuide: string;
  protectedTerms: string;
  pasteFormat: "plain" | "markdown";
  clickOutsideDismiss: boolean;
  autostart: boolean;
  hasOnboarded: boolean;
  originalExpanded: boolean;
  popupAnchor: PopupAnchor;
  // Autocorrect. Mirrored into Rust via `autocorrect_set_config` — Rust owns the
  // typing buffer and dictionary, these are just the user's knobs. Note there is
  // no separate protected-terms field: autocorrect reuses `protectedTerms` above,
  // so a term you protect from the rewriter is protected from autocorrect too.
  autocorrectEnabled: boolean;
  autocorrectMinWordLength: number;
  autocorrectShowBubble: boolean;
  /** Ask the model about words the dictionary cannot judge. Separately opt-in
   *  from `autocorrectEnabled`, because this is what sends text off the machine. */
  autocorrectLlmAssist: boolean;
  autocorrectAllowlist: string;
  autocorrectLogRetention: number;
  /** Whether the installer's opt-in has been applied to `autocorrectEnabled`
   *  yet. Stops the installer choice from re-asserting itself every launch and
   *  overriding what the user has since chosen in Settings. */
  autocorrectSeeded: boolean;
}

const DEFAULT_SETTINGS: OllamaSettings = {
  provider: "ollama-cloud",
  baseUrl: "https://ollama.com",
  model: "gemma4:31b-cloud",
  apiKey: "",
  educational: false,
  affirm: false,
  hotkey: DEFAULT_HOTKEY,
  bubbleShortcuts: DEFAULT_BUBBLE_SHORTCUTS,
  viewMode: "rendered",
  lastAction: null,
  customPromptHistory: [],
  savedTemplates: [],
  styleGuide: "",
  protectedTerms: "",
  pasteFormat: "plain",
  clickOutsideDismiss: true,
  autostart: false,
  hasOnboarded: false,
  originalExpanded: false,
  popupAnchor: "mouse",
  // Off by default. The hook is never installed until the user opts in AND the
  // license is active — see `autocorrect::apply` in Rust.
  autocorrectEnabled: false,
  // 3, not 4: "teh" is the commonest typo in English and is three letters. The
  // frequency-dominance rule in Rust is what keeps short words safe.
  autocorrectMinWordLength: 3,
  autocorrectShowBubble: true,
  // Off even when autocorrect is on. Nothing leaves the machine until the user
  // turns this on specifically.
  autocorrectLlmAssist: false,
  // Fail-closed. Browsers and Electron apps must NOT be added until the UIA
  // password probe lands — `ES_PASSWORD` cannot see into their text fields, so
  // allowlisting them means typing into password boxes blind.
  autocorrectAllowlist: "notepad.exe",
  autocorrectLogRetention: 200,
  autocorrectSeeded: false,
};

const SETTINGS_KEY = "r3write.settings.v1";

function loadSettings(): OllamaSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<OllamaSettings> & { provider?: string };
    // Migrate legacy provider names from v1 ("cloud"/"local") into the new
    // multi-provider taxonomy. Anything else passes through.
    let provider = parsed.provider as Provider | undefined;
    if ((parsed.provider as string) === "cloud") provider = "ollama-cloud";
    else if ((parsed.provider as string) === "local") provider = "ollama-local";
    const merged: OllamaSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      provider: provider ?? DEFAULT_SETTINGS.provider,
    };
    // Deep-merge bubbleShortcuts so storing an older partial set doesn't drop
    // any of the keys the runtime expects.
    merged.bubbleShortcuts = {
      ...DEFAULT_BUBBLE_SHORTCUTS,
      ...(parsed.bubbleShortcuts || {}),
    };
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: OllamaSettings) {
  // apiKey is persisted via Windows Credential Manager (see saveApiKey),
  // never written to localStorage.
  const sanitized = { ...s, apiKey: "" };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
}

// Read-modify-write helper for cross-window settings nudges (e.g. the popup
// persisting viewMode or lastAction without trampling fields it never touched).
function patchSettings(patch: Partial<OllamaSettings>): OllamaSettings {
  const current = loadSettings();
  const next = { ...current, ...patch };
  saveSettings(next);
  return next;
}

// Each provider gets its own keyring entry so switching providers doesn't
// drop the user's other keys. Backwards-compat: the legacy entry name was
// `ollama-api-key`; it now belongs to ollama-cloud.
function apiKeyEntryName(provider: Provider): string {
  if (provider === "ollama-cloud") return "ollama-api-key";
  return `r3write-api-key-${provider}`;
}

export const API_KEY_NAME = apiKeyEntryName("ollama-cloud");

async function loadApiKey(provider: Provider = "ollama-cloud"): Promise<string> {
  try {
    const v = await invoke<string | null>("secret_get", { name: apiKeyEntryName(provider) });
    return v ?? "";
  } catch (e) {
    console.error("[r3write] secret_get failed:", e);
    return "";
  }
}

async function saveApiKey(provider: Provider, key: string): Promise<void> {
  try {
    if (key) {
      await invoke("secret_set", { name: apiKeyEntryName(provider), value: key });
    } else {
      await invoke("secret_delete", { name: apiKeyEntryName(provider) });
    }
  } catch (e) {
    console.error("[r3write] secret persistence failed:", e);
  }
}

async function clearApiKeyFor(provider: Provider): Promise<void> {
  try {
    await invoke("secret_delete", { name: apiKeyEntryName(provider) });
  } catch (e) {
    console.error("[r3write] secret_delete failed:", e);
  }
}

// In production builds the Tauri webview's URL is `http://tauri.localhost`,
// and tauri-plugin-http auto-injects that as the `Origin` header on every
// request unless we explicitly set one. Ollama's CORS check rejects unknown
// origins with a flat 403 — including the local server on `localhost:11434`.
// Match Origin to the target URL's own origin so Ollama always sees a
// same-origin request and accepts it.
function originFor(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function defaultsForProvider(provider: Provider): Pick<OllamaSettings, "baseUrl" | "model"> {
  const d = PROVIDER_DEFAULTS[provider];
  return { baseUrl: d.baseUrl, model: d.model };
}

// True when the provider speaks the Ollama /api/chat dialect. All Ollama-style
// servers stream NDJSON of `{ message: { content }, done }`. OpenAI-compatible
// providers stream SSE (`data: { choices: [...] }`). Anthropic streams a
// different SSE shape with `content_block_delta` events.
function isOllamaStyle(p: Provider): boolean {
  return p === "ollama-cloud" || p === "ollama-local";
}

function isOpenAIStyle(p: Provider): boolean {
  return p === "openai" || p === "groq" || p === "openrouter";
}

function isGemini(p: Provider): boolean {
  return p === "gemini";
}

// ---------- Streaming clients ----------
//
// One client per dialect family; the factory at the bottom picks based on
// settings.provider. All clients yield raw text deltas; the caller buffers,
// concatenates, and renders.

// Stream Server-Sent Events as `data: {…}` lines. Yields each parsed object.
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) return;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // Tolerate keep-alive comments and partial frames; the next chunk
        // will deliver a complete one.
      }
    }
  }
}

class OllamaClient implements LLMClient {
  constructor(private settings: OllamaSettings) {}

  async *chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: originFor(this.settings.baseUrl),
    };
    if (this.settings.provider === "ollama-cloud") {
      // Prefer the in-memory key so Settings → Test works with an unsaved
      // draft. Fall back to the keyring so the quick-edit popup — which is
      // a separate window and may have mounted before the key was saved —
      // picks up the current value.
      const apiKey = this.settings.apiKey || (await loadApiKey(this.settings.provider));
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
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

// OpenAI, Groq, and OpenRouter all speak the same /v1/chat/completions
// dialect, just at different base URLs. Same streaming format too.
class OpenAIStyleClient implements LLMClient {
  constructor(private settings: OllamaSettings) {}

  private endpoint(): string {
    const base = this.settings.baseUrl.replace(/\/$/, "");
    // OpenRouter doesn't include /v1 in its conventional base URL; the others do.
    if (this.settings.provider === "openrouter") return `${base}/api/v1/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  async *chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string> {
    const apiKey = this.settings.apiKey || (await loadApiKey(this.settings.provider));
    if (!apiKey) throw new Error(`${PROVIDER_LABELS[this.settings.provider]}: API key not set`);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Origin: originFor(this.settings.baseUrl),
    };
    if (this.settings.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://r3write.app";
      headers["X-Title"] = "R3write";
    }
    const res = await tauriFetch(this.endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.settings.model,
        stream: true,
        messages,
      }),
      signal: opts?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `${PROVIDER_LABELS[this.settings.provider]} HTTP ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }

    for await (const event of parseSse(res.body, opts?.signal)) {
      const obj = event as {
        choices?: { delta?: { content?: string } }[];
        error?: { message?: string };
      };
      if (obj.error) throw new Error(obj.error.message ?? "Provider error");
      const piece = obj.choices?.[0]?.delta?.content;
      if (piece) yield piece;
    }
  }

  async *rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string> {
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

// Anthropic's Messages API is similar but takes the system prompt out-of-band
// and streams content_block_delta events.
class AnthropicClient implements LLMClient {
  constructor(private settings: OllamaSettings) {}

  async *chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string> {
    const apiKey = this.settings.apiKey || (await loadApiKey(this.settings.provider));
    if (!apiKey) throw new Error("Anthropic: API key not set");
    const system = messages.find((m) => m.role === "system")?.content;
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const res = await tauriFetch(`${this.settings.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        Origin: originFor(this.settings.baseUrl),
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 4096,
        stream: true,
        system,
        messages: turns,
      }),
      signal: opts?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Anthropic HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    for await (const event of parseSse(res.body, opts?.signal)) {
      const obj = event as {
        type?: string;
        delta?: { type?: string; text?: string };
        error?: { message?: string };
      };
      if (obj.error) throw new Error(obj.error.message ?? "Anthropic error");
      if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
        if (obj.delta.text) yield obj.delta.text;
      }
    }
  }

  async *rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string> {
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

// Gemini's Generative Language API takes the system prompt out-of-band via
// `systemInstruction`, names the assistant role `model`, and wraps text in a
// `parts: [{text}]` envelope. Streams SSE on `:streamGenerateContent?alt=sse`.
class GeminiClient implements LLMClient {
  constructor(private settings: OllamaSettings) {}

  async *chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string> {
    const apiKey = this.settings.apiKey || (await loadApiKey(this.settings.provider));
    if (!apiKey) throw new Error("Gemini: API key not set");
    const system = messages.find((m) => m.role === "system")?.content;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const base = this.settings.baseUrl.replace(/\/$/, "");
    const url = `${base}/v1beta/models/${encodeURIComponent(this.settings.model)}:streamGenerateContent?alt=sse`;
    const res = await tauriFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        Origin: originFor(this.settings.baseUrl),
      },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: 4096 },
      }),
      signal: opts?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Gemini HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    for await (const event of parseSse(res.body, opts?.signal)) {
      const obj = event as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        error?: { message?: string };
      };
      if (obj.error) throw new Error(obj.error.message ?? "Gemini error");
      const parts = obj.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) yield p.text;
        }
      }
    }
  }

  async *rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string> {
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

// Deliberately not BASE_SYSTEM_PROMPT. That one is for rewriting a passage the
// user asked about; this is a single-word judgement where any extra prose in the
// reply has to be parsed back out, and a model that starts explaining itself makes
// the answer unusable.
const ARBITRATION_SYSTEM_PROMPT =
  "You are a proofreader. You are given a sentence fragment and one TARGET word from it. " +
  "Decide whether the TARGET is the correct word in that context. " +
  "Consider only word choice and grammatical form (their/there, form/from, singular/plural). " +
  "Reply with the corrected TARGET word alone, nothing else. " +
  "If the TARGET is already correct, reply with it unchanged. " +
  "Never reply with more than one word, and never explain.";

/// Ask the configured provider to judge one word in context.
///
/// Returns the replacement word, or null if the model agreed with what was typed
/// or answered in a shape we cannot trust. Bounded hard: a single word in, a single
/// word out, and anything else is discarded rather than guessed at.
async function arbitrateWord(
  settings: OllamaSettings,
  word: string,
  context: string,
  signal: AbortSignal,
): Promise<string | null> {
  const client = makeClient(settings);
  let reply = "";
  for await (const chunk of client.chat(
    [
      { role: "system", content: ARBITRATION_SYSTEM_PROMPT },
      { role: "user", content: `Fragment: ...${context}\nTARGET: ${word}` },
    ],
    { signal },
  )) {
    reply += chunk;
    // One word is all that can be valid; stop paying for tokens past that.
    if (reply.length > 64) break;
  }

  const answer = reply.trim().replace(/^["'`]+|["'`.,!?]+$/g, "");
  // Refuse anything that is not a single plausible word. A model that explains
  // itself, apologises, or returns a phrase must not reach the user's document.
  if (!answer || /\s/.test(answer) || answer.length > word.length + 8) return null;
  if (answer.toLowerCase() === word.toLowerCase()) return null;
  return answer;
}

function makeClient(settings: OllamaSettings): LLMClient {
  if (isOpenAIStyle(settings.provider)) return new OpenAIStyleClient(settings);
  if (settings.provider === "anthropic") return new AnthropicClient(settings);
  if (isGemini(settings.provider)) return new GeminiClient(settings);
  return new OllamaClient(settings);
}

// Health probe used by the StatusPill in the main window. Returns ms-to-first-
// response on success; throws on any failure. Designed to be cheap — we don't
// stream tokens, just confirm the server speaks our dialect and authenticates.
async function probeProvider(
  settings: OllamaSettings,
  signal?: AbortSignal,
): Promise<number> {
  const started = performance.now();
  if (isOllamaStyle(settings.provider)) {
    const headers: Record<string, string> = { Origin: originFor(settings.baseUrl) };
    if (settings.provider === "ollama-cloud") {
      const key = settings.apiKey || (await loadApiKey(settings.provider));
      if (key) headers["Authorization"] = `Bearer ${key}`;
    }
    const res = await tauriFetch(`${settings.baseUrl.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      headers,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Math.round(performance.now() - started);
  }
  if (isGemini(settings.provider)) {
    const apiKey = settings.apiKey || (await loadApiKey(settings.provider));
    if (!apiKey) throw new Error("API key not set");
    const res = await tauriFetch(
      `${settings.baseUrl.replace(/\/$/, "")}/v1beta/models`,
      {
        method: "GET",
        headers: { "x-goog-api-key": apiKey, Origin: originFor(settings.baseUrl) },
        signal,
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Math.round(performance.now() - started);
  }
  if (settings.provider === "anthropic") {
    // Anthropic has no free probe; issue a 1-token request and abort on the
    // first delta. Cheaper than a full rewrite and still confirms auth.
    const ctrl = new AbortController();
    const onUserAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onUserAbort, { once: true });
    try {
      const client = makeClient(settings);
      for await (const chunk of client.chat([{ role: "user", content: "hi" }], { signal: ctrl.signal })) {
        if (chunk) {
          ctrl.abort();
          return Math.round(performance.now() - started);
        }
      }
      throw new Error("empty response");
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (aborted && performance.now() - started > 0) return Math.round(performance.now() - started);
      throw e;
    } finally {
      signal?.removeEventListener("abort", onUserAbort);
    }
  }
  // OpenAI-style: GET /v1/models is supported by openai/groq/openrouter and
  // is authenticated, so it doubles as an API-key check.
  const apiKey = settings.apiKey || (await loadApiKey(settings.provider));
  if (!apiKey) throw new Error("API key not set");
  const base = settings.baseUrl.replace(/\/$/, "");
  const url = settings.provider === "openrouter" ? `${base}/api/v1/models` : `${base}/v1/models`;
  const res = await tauriFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Origin: originFor(settings.baseUrl) },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Math.round(performance.now() - started);
}

// ---------- App ----------

type Phase = "idle" | "streaming" | "ready" | "error";

function LicenseSettingsPanel({ license }: { license: UseLicense }) {
  const { state } = license;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await license.activate(key);
      if (next.status !== "active") setErr(next.errorMessage || "Activation failed");
      else setKey("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "active") {
    return (
      <div className="rounded-md border border-border bg-bg-subtle p-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-r3w-add-fg" />
          <h3 className="text-sm font-semibold text-fg">License active</h3>
        </div>
        <dl className="mt-3 grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-[12px]">
          <dt className="text-fg-subtle">Key</dt>
          <dd className="truncate font-mono text-fg" title={state.keyMasked || ""}>
            {state.keyMasked || "—"}
          </dd>
          {state.customerEmail && (
            <>
              <dt className="text-fg-subtle">Customer</dt>
              <dd className="truncate text-fg">{state.customerEmail}</dd>
            </>
          )}
          {state.productName && (
            <>
              <dt className="text-fg-subtle">Product</dt>
              <dd className="truncate text-fg">{state.productName}</dd>
            </>
          )}
          {state.activationLimit != null && (
            <>
              <dt className="text-fg-subtle">Activations</dt>
              <dd className="text-fg">
                {state.activationUsage ?? "?"} / {state.activationLimit}
              </dd>
            </>
          )}
          {state.lastValidatedAt && (
            <>
              <dt className="text-fg-subtle">Verified</dt>
              <dd className="text-fg-muted">
                {new Date(state.lastValidatedAt).toLocaleString()}
              </dd>
            </>
          )}
        </dl>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={license.loading}
            onClick={() => void license.refresh()}
            className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {license.loading ? "Checking…" : "Re-validate"}
          </button>
          <button
            type="button"
            disabled={license.loading}
            onClick={() => void license.deactivate()}
            className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-danger transition hover:bg-danger-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Deactivate this machine
          </button>
        </div>
        <p className="mt-3 text-[11px] text-fg-subtle">
          Deactivating frees this seat so you can activate on another machine.
        </p>
      </div>
    );
  }

  const showErr = err || (state.status === "invalid" ? state.errorMessage : null);
  return (
    <div className="rounded-md border border-border bg-bg-subtle p-3">
      <div className="flex items-center gap-2">
        <Sparkle size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">Activate R3write</h3>
      </div>
      <p className="mt-2 text-[12px] text-fg-muted">
        Paste the license key from your Lemon Squeezy receipt.
      </p>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy) void submit();
        }}
        placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
        spellCheck={false}
        autoComplete="off"
        className="mt-3 w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm font-mono text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
      />
      {showErr && (
        <p role="alert" className="mt-2 break-words text-xs text-danger">
          {showErr}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !key.trim()}
          onClick={() => void submit()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {busy ? "Activating…" : "Activate"}
        </button>
        <button
          type="button"
          onClick={() =>
            void openUrl(LS_CHECKOUT_URL).catch((e) =>
              console.error("[r3write] open checkout:", e),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Buy a key
          <ExternalLink size={12} className="opacity-70" />
        </button>
      </div>
    </div>
  );
}

function ActivationGate({
  state,
  loading,
  onActivate,
  variant = "main",
}: {
  state: LicenseState;
  loading: boolean;
  onActivate: (key: string) => Promise<LicenseState>;
  variant?: "main" | "popup";
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // First /validate still in flight and we have no cached state — render a
  // neutral placeholder so a real licensee doesn't see the gate flash before
  // the network probe resolves.
  if (state.status === "unknown" && loading) {
    return (
      <div className="grid h-full place-items-center bg-bg text-fg-muted">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={14} className="animate-spin" />
          Checking license…
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await onActivate(key);
      if (next.status !== "active") setErr(next.errorMessage || "Activation failed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const showErr = err || (state.status === "invalid" ? state.errorMessage : null);

  return (
    <div
      className="grid h-full place-items-center bg-bg p-6 text-fg"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (
          (e.target as HTMLElement).closest(
            "button, input, textarea, a, [data-no-drag]",
          )
        )
          return;
        void getCurrentWebviewWindow().startDragging();
      }}
    >
      <div className="w-[min(420px,92vw)] rounded-xl border border-border bg-bg-elev p-6 shadow-[var(--shadow-md)]">
        <div className="flex items-center gap-2">
          <BrandMark size="lg" />
          <h2 className="text-base font-semibold text-fg">Activate R3write</h2>
        </div>
        {variant === "popup" ? (
          <>
            <p className="mt-3 text-sm text-fg-muted">
              R3write isn't activated. Open the main window to paste your license key.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void openUrl(LS_CHECKOUT_URL).catch((e) =>
                    console.error("[r3write] open checkout:", e),
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Buy a key
                <ExternalLink size={12} className="opacity-70" />
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-fg-muted">
              Paste the license key from your Lemon Squeezy receipt to unlock R3write.
            </p>
            <input
              autoFocus
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void submit();
              }}
              placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
              spellCheck={false}
              autoComplete="off"
              className="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm font-mono text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            {showErr && (
              <p role="alert" className="mt-2 break-words text-xs text-danger">
                {showErr}
              </p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !key.trim()}
                onClick={() => void submit()}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {busy ? "Activating…" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void openUrl(LS_CHECKOUT_URL).catch((e) =>
                    console.error("[r3write] open checkout:", e),
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Buy a key
                <ExternalLink size={12} className="opacity-70" />
              </button>
            </div>
            <p className="mt-4 text-[11px] text-fg-subtle">
              Already paid? The key is in your Lemon Squeezy receipt email.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function App() {
  const license = useLicense();
  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !loadSettings().hasOnboarded);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("history");

  // ---- Autocorrect <-> Rust ----------------------------------------------
  //
  // Rust owns the typing buffer, dictionary, correction log and undo state; the
  // webviews only render. Two consequences handled here:
  //
  //  1. Settings changes must be PUSHED to Rust. Nothing reads them from
  //     localStorage on the Rust side, and the popup and bubble windows have
  //     their own React state that never sees this component's.
  //  2. License status must be pushed too. The keyboard hook refuses to install
  //     until Rust is told the license is active — gating only the UI would
  //     leave a keylogger running behind the paywall.

  // First run only: adopt whatever the user ticked in the installer, then mark
  // it seeded so the installer choice never overrides a later decision here.
  useEffect(() => {
    if (settings.autocorrectSeeded) return;
    let cancelled = false;
    void installerOptIn()
      .then((optIn) => {
        if (cancelled) return;
        setSettings((s) =>
          s.autocorrectSeeded ? s : { ...s, autocorrectEnabled: optIn, autocorrectSeeded: true },
        );
      })
      .catch(() => {
        // No registry value (sideloaded or portable copy) — leave it off and
        // stop asking.
        if (!cancelled) setSettings((s) => ({ ...s, autocorrectSeeded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [settings.autocorrectSeeded]);

  useEffect(() => {
    void setLicenseActive(license.state.status === "active").catch(() => {});
  }, [license.state.status]);

  // Rust detects which words need context but cannot call a provider itself: the
  // seven clients, their base URLs and the keyring-backed API keys all live here.
  // So it emits a request and this window answers. The main window is always
  // mounted (closing it hides to tray), so it is a reliable place for this.
  //
  // Only one window may answer, or the same word would be billed several times.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const inFlight = new AbortController();

    void listen<ArbitrateEvent>(ARBITRATE_EVENT, (e) => {
      const p = e.payload;
      if (!p) return;
      void (async () => {
        try {
          const answer = await arbitrateWord(
            settingsRef.current,
            p.word,
            p.context,
            inFlight.signal,
          );
          await sendLlmSuggestion(p.id, answer);
        } catch (err) {
          console.error("[r3write] arbitration failed:", err);
          // Always answer, even on failure — Rust holds a pending slot for this
          // id and would otherwise keep it until the next word is committed.
          await sendLlmSuggestion(p.id, null).catch(() => {});
        }
      })();
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      unlisten?.();
      inFlight.abort();
    };
  }, []);

  useEffect(() => {
    void setAutocorrectConfig({
      enabled: settings.autocorrectEnabled,
      minWordLength: settings.autocorrectMinWordLength,
      showBubble: settings.autocorrectShowBubble,
      llmAssist: settings.autocorrectLlmAssist,
      allowlist: settings.autocorrectAllowlist,
      // Shared with the rewriter's glossary — a term you protect there is
      // protected from autocorrect too.
      protectedTerms: settings.protectedTerms,
      logRetention: settings.autocorrectLogRetention,
    }).catch((e) => console.error("[r3write] autocorrect config push failed:", e));
  }, [
    settings.autocorrectEnabled,
    settings.autocorrectMinWordLength,
    settings.autocorrectShowBubble,
    settings.autocorrectLlmAssist,
    settings.autocorrectAllowlist,
    settings.protectedTerms,
    settings.autocorrectLogRetention,
  ]);

  // Hydrate apiKey from Windows Credential Manager keyed by the active
  // provider. Each provider has its own keyring entry so switching providers
  // doesn't blow away the others' keys.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fromKeyring = await loadApiKey(settings.provider);
      if (cancelled) return;
      if (fromKeyring) {
        setSettings((s) => (s.apiKey === fromKeyring ? s : { ...s, apiKey: fromKeyring }));
      }
      setSettingsHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    saveSettings(settings);
    void saveApiKey(settings.provider, settings.apiKey);
  }, [settings, settingsHydrated]);

  // Apply persisted hotkey on app start. Rust's setup() registers the default
  // (Ctrl+Alt+G), so the shortcut is live during boot; this swaps to the user's
  // saved choice once React mounts. Runs once.
  useEffect(() => {
    const persisted = loadSettings().hotkey;
    if (sameHotkey(persisted, DEFAULT_HOTKEY)) return;
    void invoke("set_hotkey", {
      ctrl: persisted.ctrl,
      alt: persisted.alt,
      shift: persisted.shift,
      meta: persisted.meta,
      code: persisted.code,
    }).catch((e) => console.error("[r3write] persisted hotkey rebind failed:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  useEffect(() => {
    saveHistory(history);
  }, [history]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<HistoryEntry>("history:add", (event) => {
      setHistory((h) => {
        // Dedupe by id — the popup may broadcast more than once for one accept.
        if (h.some((x) => x.id === event.payload.id)) return h;
        return [event.payload, ...h].slice(0, 20);
      });
    }).then((u) => {
      if (cancelled) {
        // Effect was cleaned up before listen() resolved (e.g. StrictMode
        // double-mount in dev). Unregister immediately so we don't leak a
        // duplicate listener.
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Copy the original text back to the clipboard so the user can paste it
  // over the rewrite in the source app, then drop the entry from history.
  // Replaces an earlier flow that tried to mutate a hidden in-app editor —
  // the editor was never visible and the doc-find always failed.
  const revert = useCallback((entry: HistoryEntry) => {
    setRevertError(null);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(entry.original);
      } catch {
        // Tauri's clipboard plugin is the reliable path on Windows.
        try {
          await invoke("set_clipboard", { text: entry.original });
        } catch (e) {
          setRevertError(
            "Couldn't copy the original to your clipboard — check Settings or paste manually.",
          );
          return;
        }
      }
      setHistory((h) => h.filter((x) => x.id !== entry.id));
    };
    void copy();
  }, []);

  if (license.state.status !== "active") {
    return (
      <Tooltip.Provider delayDuration={250} skipDelayDuration={500}>
        <ActivationGate
          state={license.state}
          loading={license.loading}
          onActivate={license.activate}
        />
      </Tooltip.Provider>
    );
  }

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={500}>
      <div className="flex h-full flex-col bg-bg text-fg">
        <header
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if (
              (e.target as HTMLElement).closest(
                "button, input, textarea, a, select, [data-no-drag], [role=switch], [role=tab], [role=menu], [role=menuitem]",
              )
            )
              return;
            void getCurrentWebviewWindow().startDragging();
          }}
          onDoubleClick={(e) => {
            if (
              (e.target as HTMLElement).closest(
                "button, input, textarea, a, select, [data-no-drag]",
              )
            )
              return;
            void getCurrentWebviewWindow().toggleMaximize();
          }}
          className="flex h-12 cursor-default select-none items-center justify-between border-b border-border bg-bg-elev/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-bg-elev/60"
        >
          <div className="flex items-center gap-2">
            <BrandMark size="md" />
            <h1 className="text-sm font-semibold tracking-tight text-fg">R3write</h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill settings={settings} onClick={() => setShowSettings(true)} />
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
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => void getCurrentWebviewWindow().minimize()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Minimize"
              className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              onClick={() => void getCurrentWebviewWindow().toggleMaximize()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Maximize"
              className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Square size={12} />
            </button>
            <button
              type="button"
              onClick={() => void getCurrentWebviewWindow().close()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-red-500/15 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <InfoDialog
          open={showInfo}
          onOpenChange={setShowInfo}
          model={settings.model}
          provider={settings.provider}
          hotkey={settings.hotkey}
        />
        <OnboardingDialog
          open={showOnboarding}
          hotkey={settings.hotkey}
          onOpenSettings={() => {
            setShowOnboarding(false);
            patchSettings({ hasOnboarded: true });
            setSettings((s) => ({ ...s, hasOnboarded: true }));
            setShowSettings(true);
          }}
          onClose={() => {
            setShowOnboarding(false);
            patchSettings({ hasOnboarded: true });
            setSettings((s) => ({ ...s, hasOnboarded: true }));
          }}
        />
        <SettingsDialog
          open={showSettings}
          onOpenChange={setShowSettings}
          license={license}
          settings={settings}
          onSave={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
          onClearApiKey={async () => {
            // Wipe the credential immediately so a Cancel after this point
            // doesn't leave the previous key behind in Windows Credential
            // Manager. The save effect would also do this on next save, but
            // we don't want to depend on that.
            await clearApiKeyFor(settings.provider);
            setSettings((s) => ({ ...s, apiKey: "" }));
          }}
        />

        {panelTab === "history" ? (
          <HistoryListPanel
            entries={history}
            revertError={revertError}
            onRevert={revert}
            onClear={() => {
              // Wipe storage synchronously — don't rely on the saveHistory
              // useEffect timing, in case the window is closed before React
              // flushes the next render.
              clearHistoryStorage();
              setHistory([]);
              setRevertError(null);
            }}
            hotkey={settings.hotkey}
            onTabChange={setPanelTab}
          />
        ) : (
          <AutocorrectLogPanel
            enabled={settings.autocorrectEnabled}
            onTabChange={setPanelTab}
          />
        )}

        <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-bg-elev px-3 text-[11px] text-fg-muted">
          <span>Like R3write? Tip the dev.</span>
          <SupportLinks size="sm" />
        </footer>
      </div>
    </Tooltip.Provider>
  );
}

function InfoDialog({
  open,
  onOpenChange,
  model,
  provider,
  hotkey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: string;
  provider: OllamaSettings["provider"];
  hotkey: HotkeyBinding;
}) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!open || version) return;
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [open, version]);
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
                    <BrandMark size="lg" />
                    <Dialog.Title className="text-base font-semibold text-fg">
                      About R3write
                    </Dialog.Title>
                    {version && (
                      <span className="ml-auto rounded-md border border-border bg-bg-subtle px-2 py-0.5 font-mono text-[11px] tabular-nums text-fg-muted">
                        v{version}
                      </span>
                    )}
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
                        {formatHotkey(hotkey)}
                      </kbd>{" "}
                      to open the rewrite popup.
                    </p>
                    <p className="text-fg-muted">
                      Pick an action — Improve, Fix grammar, Shorten, Expand, or a tone preset — and the
                      rewrite streams in. Accept it to paste back into the source app, or dismiss to keep
                      your original.
                    </p>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded-md border border-border bg-bg-subtle px-2.5 py-1.5">
                      <div className="text-fg-subtle">Provider</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-fg">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
                        {PROVIDER_LABELS[provider] ?? provider}
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-bg-subtle px-2.5 py-1.5">
                      <div className="text-fg-subtle">Model</div>
                      <div className="mt-0.5 truncate font-mono text-fg" title={model}>
                        {model}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-fg-subtle">
                    Change provider, model, hotkey, or feedback channels in Settings.
                  </p>

                  <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                    <span className="text-[11px] text-fg-subtle">Support R3write</span>
                    <SupportLinks size="xs" />
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

function OnboardingDialog({
  open,
  hotkey,
  onOpenSettings,
  onClose,
}: {
  open: boolean;
  hotkey: HotkeyBinding;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
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
                  className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-elev p-6 text-fg shadow-md focus:outline-none"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
                >
                  <div className="flex items-center gap-2">
                    <BrandMark size="lg" />
                    <Dialog.Title className="text-base font-semibold text-fg">
                      Welcome to R3write
                    </Dialog.Title>
                  </div>
                  <Dialog.Description className="sr-only">
                    First-run setup: how the hotkey works and where to configure a model provider.
                  </Dialog.Description>
                  <ol className="mt-4 space-y-2 text-sm leading-relaxed text-fg-muted">
                    <li>
                      <span className="font-semibold text-fg">1.</span> Select text in any app — Word, Slack, your editor, anywhere.
                    </li>
                    <li>
                      <span className="font-semibold text-fg">2.</span> Press{" "}
                      <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">
                        {formatHotkey(hotkey)}
                      </kbd>{" "}
                      to open the quick-edit popup.
                    </li>
                    <li>
                      <span className="font-semibold text-fg">3.</span> Pick an action — Improve, Fix grammar, Shorten, Expand, a tone, or a custom prompt.
                    </li>
                    <li>
                      <span className="font-semibold text-fg">4.</span> Accept &amp; paste, or dismiss to keep the original.
                    </li>
                    <li className="mt-1 text-fg-subtle">
                      Tip: press the same hotkey with Shift to repeat the last action without the picker.
                    </li>
                  </ol>
                  <div className="mt-4 rounded-md border border-border bg-bg-subtle p-3 text-[12px] text-fg-muted">
                    <p>
                      R3write needs a model provider to do the rewriting. You can use a local Ollama install (free, no key) or a cloud provider (Ollama Cloud, OpenAI, Anthropic, Groq, OpenRouter).
                    </p>
                  </div>
                  <div className="mt-5 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      Maybe later
                    </button>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      Open Settings
                    </button>
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

const BMC_URL = "https://buymeacoffee.com/drknowhow";
const SPONSORS_URL = "https://github.com/sponsors/drknowhow";

function BrandMark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls =
    size === "sm" ? "h-5 w-5" : size === "lg" ? "h-7 w-7" : "h-6 w-6";
  return (
    <img
      src={appIconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className={`${cls} select-none rounded-md`}
    />
  );
}

function SupportLinks({ size = "sm" }: { size?: "sm" | "xs" }) {
  const btnCls =
    size === "sm" ? "h-7 w-7" : "h-6 w-6";
  const iconSize = size === "sm" ? 14 : 12;
  const tipCls =
    "rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md";
  return (
    <div className="flex items-center gap-1">
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={() => {
              void openUrl(BMC_URL).catch((e) => console.error("[r3write] BMC:", e));
            }}
            aria-label="Buy me a coffee"
            className={`grid ${btnCls} place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-[#FFDD00] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Coffee size={iconSize} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className={tipCls}>
            Buy me a coffee
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={() => {
              void openUrl(SPONSORS_URL).catch((e) =>
                console.error("[r3write] Sponsors:", e),
              );
            }}
            aria-label="Sponsor on GitHub"
            className={`grid ${btnCls} place-items-center rounded-md text-fg-muted transition hover:bg-bg-subtle hover:text-[#ea4aaa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Heart size={iconSize} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className={tipCls}>
            Sponsor on GitHub
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

type Health =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "ok"; ms: number }
  | { kind: "err"; message: string };

function StatusPill({
  settings,
  onClick,
}: {
  settings: OllamaSettings;
  onClick?: () => void;
}) {
  const [health, setHealth] = useState<Health>({ kind: "unknown" });
  const probeKey = `${settings.provider}|${settings.baseUrl}|${settings.model}|${settings.apiKey ? "k" : ""}`;
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const ctrlRef: { current: AbortController | null } = { current: null };

    const tick = async () => {
      if (cancelled) return;
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setHealth((h) => (h.kind === "ok" || h.kind === "err" ? { kind: "checking" } : h.kind === "unknown" ? { kind: "checking" } : h));
      try {
        const ms = await probeProvider(settings, ctrl.signal);
        if (!cancelled) setHealth({ kind: "ok", ms });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setHealth({ kind: "err", message: msg });
      }
    };

    // First probe after a short delay so settings churn during editing doesn't
    // hammer the provider. Then refresh every 60s.
    timer = window.setTimeout(() => {
      void tick();
      timer = window.setInterval(tick, 60_000);
    }, 400) as unknown as number;

    return () => {
      cancelled = true;
      ctrlRef.current?.abort();
      if (timer != null) {
        window.clearTimeout(timer);
        window.clearInterval(timer);
      }
    };
  }, [probeKey, settings]);

  const dot =
    health.kind === "ok"
      ? "bg-r3w-add-fg"
      : health.kind === "err"
        ? "bg-danger"
        : health.kind === "checking"
          ? "bg-amber-400"
          : "bg-fg-subtle";
  const tip =
    health.kind === "ok"
      ? `Connected · ${health.ms} ms`
      : health.kind === "err"
        ? `Unreachable: ${health.message}`
        : health.kind === "checking"
          ? "Checking provider…"
          : "Status unknown";
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={`Provider status: ${tip}`}
          className="hidden items-center gap-1.5 rounded-full border border-border bg-bg-elev px-2.5 py-1 text-xs text-fg-muted transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:flex"
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          <span className="text-fg">{settings.model}</span>
          <span className="text-fg-subtle">·</span>
          <span>{PROVIDER_LABELS[settings.provider] ?? settings.provider}</span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="max-w-[280px] rounded-md border border-border bg-bg-elev px-2 py-1 text-xs text-fg shadow-md"
        >
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
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
  onClearApiKey,
  license,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: OllamaSettings;
  onSave: (s: OllamaSettings) => void;
  onClearApiKey: () => Promise<void>;
  license: UseLicense;
}) {
  const [draft, setDraft] = useState<OllamaSettings>(settings);
  // Lock the API key field once we have a saved key — user clicks Edit to
  // replace, or Clear (with confirm) to remove from Windows Credential
  // Manager. Test-connection success also locks so the user gets a clear
  // visual that the value is in good shape.
  const [apiKeyLocked, setApiKeyLocked] = useState<boolean>(() => !!settings.apiKey);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  type TestStatus =
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; ms: number }
    | { kind: "err"; message: string };
  const [test, setTest] = useState<TestStatus>({ kind: "idle" });
  const testAbortRef = useRef<AbortController | null>(null);
  const testCancelledRef = useRef(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  type SettingsTab = "model" | "hotkey" | "feedback" | "templates" | "glossary" | "autocorrect" | "advanced" | "license" | "support";
  const [tab, setTab] = useState<SettingsTab>("model");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplatePrompt, setNewTemplatePrompt] = useState("");
  const [autostartChecked, setAutostartChecked] = useState<boolean | null>(null);
  type LocalStatus =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; models: string[] }
    | { kind: "err"; message: string };
  const [localStatus, setLocalStatus] = useState<LocalStatus>({ kind: "idle" });
  const localFetchRef = useRef<AbortController | null>(null);

  // Reset draft and test status when dialog re-opens with potentially newer settings.
  useEffect(() => {
    if (open) {
      setDraft(settings);
      setTest({ kind: "idle" });
      setHotkeyError(null);
      setTab("model");
      setLocalStatus({ kind: "idle" });
    } else {
      testAbortRef.current?.abort();
      testAbortRef.current = null;
      localFetchRef.current?.abort();
      localFetchRef.current = null;
    }
  }, [open, settings]);

  // Read the OS-level autostart flag on open. Reflects whatever the registry
  // says, not the (possibly out-of-date) localStorage value. Defer the probe
  // by one frame so the dialog's open animation paints first — `reg query`
  // takes 50-150ms on Windows and would otherwise show up as a UI stall.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      void invoke<boolean>("autostart_get")
        .then((v) => {
          if (!cancelled) setAutostartChecked(v);
        })
        .catch(() => {
          if (!cancelled) setAutostartChecked(null);
        });
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [open]);

  // When Local Ollama is selected (or the URL changes), poke /api/tags to see if
  // it's running and what models are pulled. Cloud is skipped — its tags endpoint
  // is gated and not useful in this context.
  useEffect(() => {
    if (!open) return;
    if (draft.provider !== "ollama-local") {
      setLocalStatus({ kind: "idle" });
      return;
    }
    const handle = window.setTimeout(() => {
      const ctrl = new AbortController();
      localFetchRef.current?.abort();
      localFetchRef.current = ctrl;
      setLocalStatus({ kind: "loading" });
      const url = `${draft.baseUrl.replace(/\/$/, "")}/api/tags`;
      const timeoutId = window.setTimeout(() => ctrl.abort(), 5000);
      void (async () => {
        try {
          const res = await tauriFetch(url, {
            method: "GET",
            headers: { Origin: originFor(draft.baseUrl) },
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { models?: { name?: string }[] };
          const names = (data.models || [])
            .map((m) => m.name || "")
            .filter((n) => n.length > 0);
          if (!ctrl.signal.aborted) setLocalStatus({ kind: "ok", models: names });
        } catch (e) {
          if (ctrl.signal.aborted) return;
          const aborted = e instanceof DOMException && e.name === "AbortError";
          const msg = aborted
            ? "Timed out"
            : e instanceof Error
              ? e.message
              : String(e);
          setLocalStatus({ kind: "err", message: msg });
        } finally {
          window.clearTimeout(timeoutId);
          if (localFetchRef.current === ctrl) localFetchRef.current = null;
        }
      })();
    }, 300);
    return () => {
      window.clearTimeout(handle);
      localFetchRef.current?.abort();
    };
  }, [open, draft.provider, draft.baseUrl]);

  // Any field change invalidates a previous result so it doesn't mislead.
  const update = (patch: Partial<OllamaSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTest((t) => (t.kind === "ok" || t.kind === "err" ? { kind: "idle" } : t));
  };

  // Auto-lock the API key field as soon as Test connection succeeds with a
  // non-empty key — gives the user explicit visual confirmation that the
  // value is in good shape and prevents accidental edits.
  useEffect(() => {
    if (test.kind === "ok" && draft.apiKey && !apiKeyLocked) {
      setApiKeyLocked(true);
    }
  }, [test.kind, draft.apiKey, apiKeyLocked]);

  // Reset the pending Clear-confirmation after 4s if the user doesn't follow
  // through. Same pattern as the History panel's clear-all.
  useEffect(() => {
    if (!confirmClearKey) return;
    const t = window.setTimeout(() => setConfirmClearKey(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClearKey]);

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
      const client = makeClient(draft);
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
                  className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[clamp(460px,94vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-elev p-6 text-fg shadow-md focus:outline-none"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                >
                  <Dialog.Title className="text-base font-semibold text-fg">Settings</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Configure model provider, global hotkey, and feedback channels.
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

                  <div className="mt-3 grid min-h-0 flex-1 grid-cols-[124px_minmax(0,1fr)] gap-4">
                    <nav
                      role="tablist"
                      aria-label="Settings sections"
                      className="flex flex-col gap-0.5 self-start rounded-md bg-bg-subtle p-1"
                    >
                      {(
                        [
                          { id: "model", label: "Model" },
                          { id: "hotkey", label: "Hotkey" },
                          { id: "feedback", label: "Feedback" },
                          { id: "templates", label: "Templates" },
                          { id: "glossary", label: "Glossary" },
                          { id: "autocorrect", label: "Autocorrect" },
                          { id: "advanced", label: "Advanced" },
                          { id: "license", label: "License" },
                          { id: "support", label: "Support" },
                        ] as { id: SettingsTab; label: string }[]
                      ).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          aria-selected={tab === t.id}
                          onClick={() => setTab(t.id)}
                          className={
                            tab === t.id
                              ? "rounded px-2 py-1.5 text-left text-xs font-medium text-fg bg-bg-elev shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              : "rounded px-2 py-1.5 text-left text-xs font-medium text-fg-muted transition hover:bg-bg-elev/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          }
                        >
                          {t.label}
                        </button>
                      ))}
                    </nav>

                    <div className="min-w-0 overflow-y-auto pr-1">

                  {tab === "model" && (
                    <div role="tabpanel">
                  <Field label="Provider">
                    <select
                      value={draft.provider}
                      onChange={(e) => {
                        const provider = e.target.value as Provider;
                        // Provider switch clears the in-memory API key — it'll
                        // be re-hydrated from the keyring for the new provider.
                        update({ provider, apiKey: "", ...defaultsForProvider(provider) });
                        setApiKeyLocked(false);
                        void loadApiKey(provider).then((k) => {
                          if (k) {
                            update({ apiKey: k });
                            setApiKeyLocked(true);
                          }
                        });
                      }}
                      className={inputCls}
                    >
                      {PROVIDER_ORDER.map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_LABELS[p]} — {providerTierLabel(p)}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-fg-subtle">
                      <span className="font-medium text-fg-muted">Free</span> runs on your machine (Ollama). <span className="font-medium text-fg-muted">Free tier · BYO key</span> means you bring your own API key and the provider has a free quota. <span className="font-medium text-fg-muted">BYO key</span> means usage is paid to that provider directly.
                    </p>
                  </Field>

                  <Field label="Base URL">
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => update({ baseUrl: e.target.value })}
                      className={inputCls}
                    />
                  </Field>

                  <Field label="Model">
                    <div className="flex items-center gap-2">
                      <input
                        value={draft.model}
                        onChange={(e) => update({ model: e.target.value })}
                        placeholder="gemma4:31b-cloud"
                        className={inputCls}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          update({ model: defaultsForProvider(draft.provider).model })
                        }
                        className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        Reset
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-fg-subtle">
                      Default for {PROVIDER_LABELS[draft.provider]}:{" "}
                      <span className="font-mono text-fg-muted">
                        {defaultsForProvider(draft.provider).model}
                      </span>
                    </p>
                    {draft.provider === "ollama-local" && (
                      <div className="mt-2 rounded-md border border-border bg-bg-subtle p-2 text-[11px]">
                        {localStatus.kind === "loading" && (
                          <div className="flex items-center gap-1.5 text-fg-muted">
                            <Loader2 size={11} className="animate-spin" />
                            Checking <span className="font-mono">{draft.baseUrl}</span>…
                          </div>
                        )}
                        {localStatus.kind === "ok" && (
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5 text-r3w-add-fg">
                              <CheckCircle2 size={11} />
                              <span className="text-fg">
                                Local Ollama responding · {localStatus.models.length} model
                                {localStatus.models.length === 1 ? "" : "s"}
                              </span>
                            </div>
                            {localStatus.models.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {localStatus.models.map((m) => (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => update({ model: m })}
                                    className={
                                      draft.model === m
                                        ? "rounded-md border border-accent bg-accent/15 px-2 py-0.5 text-fg ring-1 ring-accent/40 font-mono"
                                        : "rounded-md border border-border bg-bg px-2 py-0.5 text-fg-muted transition hover:bg-bg-elev hover:text-fg font-mono"
                                    }
                                  >
                                    {m}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="text-fg-subtle">
                                No models pulled. Run <span className="font-mono">ollama pull &lt;name&gt;</span> in a terminal.
                              </p>
                            )}
                          </div>
                        )}
                        {localStatus.kind === "err" && (
                          <div className="flex items-start gap-1.5 text-danger">
                            <XCircle size={11} className="mt-0.5 flex-none" />
                            <span className="break-words">
                              Cannot reach Ollama at <span className="font-mono">{draft.baseUrl}</span>: {localStatus.message}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </Field>

                  {PROVIDER_DEFAULTS[draft.provider].needsKey && (
                    <Field label="API key">
                      {apiKeyLocked ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value="••••••••••••"
                            readOnly
                            aria-label="Stored API key (locked)"
                            className={`${inputCls} cursor-not-allowed bg-bg-subtle text-fg-muted`}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmClearKey(false);
                              setApiKeyLocked(false);
                              update({ apiKey: "" });
                            }}
                            className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            Edit
                          </button>
                          {confirmClearKey ? (
                            <button
                              type="button"
                              autoFocus
                              disabled={clearingKey}
                              onClick={async () => {
                                setClearingKey(true);
                                try {
                                  await onClearApiKey();
                                  update({ apiKey: "" });
                                  setApiKeyLocked(false);
                                  setTest({ kind: "idle" });
                                } finally {
                                  setClearingKey(false);
                                  setConfirmClearKey(false);
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md bg-danger-bg px-2 py-1.5 text-xs font-semibold text-danger ring-1 ring-danger/40 transition hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60 disabled:opacity-60"
                            >
                              <Trash2 size={12} />
                              {clearingKey ? "Clearing…" : "Confirm · remove"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmClearKey(true)}
                              aria-label="Clear API key"
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            >
                              <Trash2 size={12} />
                              Clear
                            </button>
                          )}
                        </div>
                      ) : (
                        <input
                          type="password"
                          value={draft.apiKey}
                          onChange={(e) => update({ apiKey: e.target.value })}
                          placeholder={PROVIDER_DEFAULTS[draft.provider].keyHint ?? "key"}
                          className={inputCls}
                          autoFocus
                        />
                      )}
                      <p className="mt-1 text-[11px] text-fg-subtle">
                        {apiKeyLocked
                          ? "Saved in Windows Credential Manager. Edit to replace, Clear to remove."
                          : "Stored securely in Windows Credential Manager once saved."}
                      </p>
                    </Field>
                  )}
                    </div>
                  )}

                  {tab === "hotkey" && (
                    <div role="tabpanel">
                  <Field label="Hotkey">
                    <HotkeyCapture
                      value={draft.hotkey}
                      onChange={(v) => {
                        update({ hotkey: v });
                        setHotkeyError(null);
                      }}
                      onReset={() => {
                        update({ hotkey: DEFAULT_HOTKEY });
                        setHotkeyError(null);
                      }}
                    />
                    <p className="mt-1 text-[11px] text-fg-subtle">
                      Used app-wide to open the quick-edit popup. At least one modifier required.
                    </p>
                    {hotkeyError && (
                      <div
                        role="alert"
                        className="mt-1.5 rounded-md bg-danger-bg px-2 py-1.5 text-[11px] text-danger"
                      >
                        {hotkeyError}
                      </div>
                    )}
                  </Field>

                  <div className="mb-2 mt-4 flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                      Popup shortcuts
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <p className="-mt-1 mb-2 text-[11px] text-fg-subtle">
                    Active inside the quick-edit bubble. Modifiers optional; Esc still closes.
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {(
                      [
                        { id: "improve", label: "Improve" },
                        { id: "grammar", label: "Fix grammar" },
                        { id: "shorten", label: "Shorten" },
                        { id: "expand", label: "Expand" },
                        { id: "custom", label: "Custom prompt" },
                        { id: "accept", label: "Accept" },
                        { id: "regenerate", label: "Regenerate" },
                      ] as { id: BubbleShortcutId; label: string }[]
                    ).map((row) => (
                      <div key={row.id} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-xs text-fg-muted">
                          {row.label}
                        </span>
                        <div className="flex-1">
                          <HotkeyCapture
                            requireModifier={false}
                            value={draft.bubbleShortcuts[row.id]}
                            onChange={(v) =>
                              update({
                                bubbleShortcuts: { ...draft.bubbleShortcuts, [row.id]: v },
                              })
                            }
                            onReset={() =>
                              update({
                                bubbleShortcuts: {
                                  ...draft.bubbleShortcuts,
                                  [row.id]: DEFAULT_BUBBLE_SHORTCUTS[row.id],
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        update({
                          hotkey: DEFAULT_HOTKEY,
                          bubbleShortcuts: DEFAULT_BUBBLE_SHORTCUTS,
                        });
                        setHotkeyError(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <RotateCcw size={12} />
                      Reset all hotkeys
                    </button>
                  </div>

                    </div>
                  )}

                  {tab === "feedback" && (
                    <div role="tabpanel">
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
                    </div>
                  )}

                  {tab === "templates" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <p className="text-[11px] text-fg-muted">
                        Saved prompts appear in the quick-edit popup as a Templates dropdown. Useful for prompts you run often — voice/tone presets, brand-specific instructions, etc.
                      </p>
                      <div className="rounded-md border border-border bg-bg-subtle p-3">
                        <div className="flex flex-col gap-2">
                          <input
                            value={newTemplateName}
                            onChange={(e) => setNewTemplateName(e.target.value)}
                            placeholder="Name (e.g. Marketing voice)"
                            className={inputCls}
                          />
                          <textarea
                            value={newTemplatePrompt}
                            onChange={(e) => setNewTemplatePrompt(e.target.value)}
                            placeholder="Prompt text — describe how to rewrite the selection…"
                            rows={3}
                            className={`${inputCls} resize-y`}
                          />
                          <button
                            type="button"
                            disabled={!newTemplateName.trim() || !newTemplatePrompt.trim()}
                            onClick={() => {
                              const t: SavedTemplate = {
                                id: cryptoId(),
                                name: newTemplateName.trim(),
                                prompt: newTemplatePrompt.trim(),
                              };
                              update({ savedTemplates: [...draft.savedTemplates, t] });
                              setNewTemplateName("");
                              setNewTemplatePrompt("");
                            }}
                            className="self-end rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                          >
                            Add template
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        {draft.savedTemplates.length === 0 ? (
                          <p className="text-[11px] text-fg-subtle italic">No templates yet.</p>
                        ) : (
                          draft.savedTemplates.map((t) => (
                            <div
                              key={t.id}
                              className="rounded-md border border-border bg-bg-subtle p-2 text-xs"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium text-fg">{t.name}</div>
                                  <div className="mt-0.5 break-words text-fg-muted">{t.prompt}</div>
                                </div>
                                <button
                                  type="button"
                                  aria-label={`Delete ${t.name}`}
                                  onClick={() =>
                                    update({
                                      savedTemplates: draft.savedTemplates.filter((x) => x.id !== t.id),
                                    })
                                  }
                                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {tab === "glossary" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <Field label="Style guide">
                        <textarea
                          value={draft.styleGuide}
                          onChange={(e) => update({ styleGuide: e.target.value })}
                          rows={5}
                          placeholder={`e.g.\nAlways use "we", never "I".\nAvoid em dashes.\nKeep paragraphs under 3 sentences.`}
                          className={`${inputCls} resize-y font-mono text-[12px]`}
                        />
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          Appended to the system prompt on every rewrite. Keep it under ~200 words for best results.
                        </p>
                      </Field>
                      <Field label="Protected terms">
                        <textarea
                          value={draft.protectedTerms}
                          onChange={(e) => update({ protectedTerms: e.target.value })}
                          rows={3}
                          placeholder="One per line or comma-separated, e.g.\nR3write, drknowhow, Tauri"
                          className={`${inputCls} resize-y`}
                        />
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          Names, identifiers, or brand terms the model must keep verbatim — same case, same spelling, no pluralization.
                        </p>
                      </Field>
                    </div>
                  )}

                  {tab === "autocorrect" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <div className="rounded-md border border-border bg-bg-subtle p-3 text-[12px] leading-relaxed text-fg-muted">
                        <p>
                          Autocorrect watches what you type in the applications you list below and
                          silently fixes spelling mistakes. Corrections are made{" "}
                          <span className="font-medium text-fg">entirely on this machine</span> using
                          a built-in dictionary — nothing you type is sent anywhere.
                        </p>
                        <p className="mt-2">
                          Turning it on means R3write monitors keyboard input system-wide. It stays
                          off until you switch it on here.
                        </p>
                      </div>

                      <ToggleRow
                        label="Enable system-wide autocorrect"
                        hint="Fixes a misspelled word once you finish it with a space, punctuation, or Enter."
                        checked={draft.autocorrectEnabled}
                        onChange={(v) => update({ autocorrectEnabled: v })}
                      />

                      <ToggleRow
                        label="Show a bubble when text is corrected"
                        hint="A small toast in the corner showing what changed, with an Undo button. Fades after 4 seconds."
                        checked={draft.autocorrectShowBubble}
                        onChange={(v) => update({ autocorrectShowBubble: v })}
                      />

                      <div className="rounded-md border border-border bg-bg p-3">
                        <ToggleRow
                          label="Ask the model about confusable words"
                          hint="their/there, form/from, and plurals like companys. These are spelled correctly, so the offline dictionary cannot judge them."
                          checked={draft.autocorrectLlmAssist}
                          onChange={(v) => update({ autocorrectLlmAssist: v })}
                        />
                        <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                          <span className="font-medium text-fg">
                            This sends text to {PROVIDER_LABELS[draft.provider]}.
                          </span>{" "}
                          When one of these words is typed, R3write sends that word and up to
                          80 characters of what precedes it to your configured provider. Nothing
                          else is sent, and at most one word every two seconds.
                        </p>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
                          Results are only ever <span className="font-medium text-fg">suggested</span> —
                          the model can never change your text on its own. A reply takes up to a
                          couple of seconds, by which point you have typed on, so accepting is
                          always your explicit choice.
                        </p>
                      </div>

                      <Field label="Applications to correct in">
                        <textarea
                          value={draft.autocorrectAllowlist}
                          onChange={(e) => update({ autocorrectAllowlist: e.target.value })}
                          rows={4}
                          spellCheck={false}
                          placeholder={"One executable name per line, e.g.\nnotepad.exe\nwordpad.exe"}
                          className={`${inputCls} resize-y font-mono text-[12px]`}
                        />
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          An allowlist, not a blocklist — R3write corrects{" "}
                          <span className="font-medium">only</span> in the apps named here, and an
                          empty list corrects nowhere.
                        </p>
                      </Field>

                      <div className="rounded-md border border-border bg-bg p-3 text-[11px] leading-relaxed text-fg-muted">
                        <p className="font-medium text-fg">Not supported, by design</p>
                        <p className="mt-1">
                          Terminals, password fields, elevated windows, remote-desktop sessions, and
                          IME / CJK input are refused outright. These are not bugs.
                        </p>
                        <p className="mt-1.5">
                          Browsers and Electron apps (Chrome, Slack, VS Code) can be added, but
                          aren&rsquo;t included by default. Password fields inside them are detected
                          via Windows UI Automation rather than the native window style, and if that
                          detection can&rsquo;t answer, R3write declines to type rather than guess.
                          What is <span className="font-medium">not</span> yet proven is replacement
                          itself: autocomplete dropdowns in these apps can swallow keystrokes or
                          replace more text than expected. Add them once you&rsquo;ve tried it.
                        </p>
                      </div>

                      <Field label="Shortest word to correct">
                        <input
                          type="number"
                          min={3}
                          max={12}
                          value={draft.autocorrectMinWordLength}
                          onChange={(e) =>
                            update({
                              autocorrectMinWordLength: Math.max(
                                3,
                                Math.min(12, Number(e.target.value) || 3),
                              ),
                            })
                          }
                          className={inputCls}
                        />
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          Raise this if short words get corrected in ways you don&rsquo;t want. A
                          correction only fires when one candidate is far more common than any
                          other, so genuinely ambiguous typos are left alone at any setting.
                        </p>
                      </Field>

                      <Field label="Corrections to keep in the log">
                        <input
                          type="number"
                          min={0}
                          max={2000}
                          value={draft.autocorrectLogRetention}
                          onChange={(e) =>
                            update({
                              autocorrectLogRetention: Math.max(
                                0,
                                Math.min(2000, Number(e.target.value) || 0),
                              ),
                            })
                          }
                          className={inputCls}
                        />
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          Only the before/after words and the app name are stored.{" "}
                          <span className="font-medium">Your keystrokes are never written to disk.</span>
                        </p>
                      </Field>

                      <div className="rounded-md border border-border bg-bg p-3 text-[11px] leading-relaxed text-fg-muted">
                        <p>
                          Press{" "}
                          <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-fg">
                            Ctrl+Alt+Z
                          </kbd>{" "}
                          to undo the last correction. It works until you finish the next word, after
                          which the bubble disappears — past that point R3write can no longer tell
                          where the correction was, and undoing would damage whatever you typed since.
                        </p>
                        <p className="mt-1.5">
                          Words listed under <span className="font-medium text-fg">Glossary → Protected terms</span>{" "}
                          are never corrected.
                        </p>
                      </div>
                    </div>
                  )}

                  {tab === "advanced" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <ToggleRow
                        label="Click outside to dismiss popup"
                        hint="Close the quick-edit window when you click into another app. Esc always works."
                        checked={draft.clickOutsideDismiss}
                        onChange={(v) => update({ clickOutsideDismiss: v })}
                      />
                      <ToggleRow
                        label="Start R3write at login"
                        hint="Registers R3write in Windows' per-user autostart list. The tray stays available immediately on sign-in."
                        checked={autostartChecked ?? draft.autostart}
                        onChange={(v) => {
                          setAutostartChecked(v);
                          update({ autostart: v });
                          void invoke("autostart_set", { enable: v }).catch((e) => {
                            console.error("[r3write] autostart_set failed:", e);
                          });
                        }}
                      />
                      <div className="mt-1 rounded-md border border-border bg-bg-subtle p-3 text-[12px] text-fg-muted">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                          Export history
                        </div>
                        <p className="mb-2">
                          Download the saved rewrite history. Each entry includes the original, the rewrite, the action, and a timestamp.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => exportHistory("json")}
                            className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            Export JSON
                          </button>
                          <button
                            type="button"
                            onClick={() => exportHistory("markdown")}
                            className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            Export Markdown
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {tab === "license" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <LicenseSettingsPanel license={license} />
                    </div>
                  )}

                  {tab === "support" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      <div className="rounded-md border border-border bg-bg-subtle p-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg"
                          >
                            <Sparkle size={14} strokeWidth={2.5} />
                          </span>
                          <h3 className="text-sm font-semibold text-fg">Support R3write</h3>
                        </div>
                        <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
                          R3write is built and maintained as a free desktop tool. If it saves
                          you time, a small tip — one-time or recurring — helps fund the next
                          release.
                        </p>
                        <div className="mt-3 flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void openUrl(BMC_URL).catch((e) =>
                                console.error("[r3write] open BMC failed:", e),
                              );
                            }}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#FFDD00] px-3 py-2 text-sm font-semibold text-black transition hover:bg-[#FFD400] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <Coffee size={16} strokeWidth={2.5} />
                            Buy me a coffee
                            <ExternalLink size={12} className="opacity-70" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void openUrl(SPONSORS_URL).catch((e) =>
                                console.error("[r3write] open Sponsors failed:", e),
                              );
                            }}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#ea4aaa] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#d63d99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <Heart size={14} strokeWidth={2.5} />
                            Sponsor on GitHub
                            <ExternalLink size={12} className="opacity-70" />
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          void openUrl("https://github.com/drknowhow/R3write").catch((e) =>
                            console.error("[r3write] open GitHub failed:", e),
                          );
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        View on GitHub
                        <ExternalLink size={12} className="text-fg-subtle" />
                      </button>

                      <p className="text-[11px] text-fg-subtle">
                        Links open in your default browser.
                      </p>
                    </div>
                  )}
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-end gap-3">
                    {tab === "model" && (
                      <button
                        type="button"
                        onClick={test.kind === "testing" ? cancelTest : runTest}
                        className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                    )}
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
                        onClick={async () => {
                          setHotkeyError(null);
                          if (!sameHotkey(draft.hotkey, settings.hotkey)) {
                            try {
                              await invoke("set_hotkey", {
                                ctrl: draft.hotkey.ctrl,
                                alt: draft.hotkey.alt,
                                shift: draft.hotkey.shift,
                                meta: draft.hotkey.meta,
                                code: draft.hotkey.code,
                              });
                            } catch (e) {
                              setHotkeyError(
                                typeof e === "string" ? e : "Failed to bind hotkey.",
                              );
                              return;
                            }
                          }
                          onSave(draft);
                        }}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        Save
                      </button>
                    </div>
                  </div>

                  {tab === "model" && test.kind === "ok" && (
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
                  {tab === "model" && test.kind === "err" && (
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

function KbdDisplay({ binding }: { binding: HotkeyBinding }) {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Win");
  parts.push(prettyKeyCode(binding.code));
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          <kbd className="rounded border border-border bg-bg-elev px-1.5 py-0.5 font-mono text-[11px] text-fg shadow-[var(--shadow-sm)]">
            {p}
          </kbd>
          {i < parts.length - 1 && <span className="text-fg-subtle">+</span>}
        </React.Fragment>
      ))}
    </span>
  );
}

function HotkeyCapture({
  value,
  onChange,
  onReset,
  requireModifier = true,
}: {
  value: HotkeyBinding;
  onChange: (v: HotkeyBinding) => void;
  onReset: () => void;
  requireModifier?: boolean;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      // Wait for a non-modifier keydown.
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      // Global hotkeys must include a modifier; in-popup shortcuts may not.
      if (
        requireModifier &&
        !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)
      )
        return;
      onChange({
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
        code: e.code,
      });
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onChange, requireModifier]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setCapturing((v) => !v)}
        aria-label="Capture hotkey"
        className={
          capturing
            ? "flex-1 rounded-md border border-accent bg-bg px-2 py-1.5 text-left text-sm ring-2 ring-accent/40 transition"
            : "flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-left text-sm text-fg transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        }
      >
        {capturing ? (
          <span className="text-fg-muted">Press a combo… (Esc to cancel)</span>
        ) : (
          <KbdDisplay binding={value} />
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          setCapturing(false);
          onReset();
        }}
        className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Reset
      </button>
    </div>
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

export function QuickEdit() {
  useThemeFollower();
  const license = useLicense();
  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  // Only the request-shaping fields matter for the client; theming/hotkey
  // changes shouldn't tear it down mid-stream. The client itself is stateless
  // outside the bound settings, so a ref keeps the streaming loop reading the
  // latest snapshot without restarting on unrelated settings churn.
  const clientKey = `${settings.provider}|${settings.baseUrl}|${settings.model}|${settings.apiKey ? "k" : ""}`;
  const clientRef = useRef<LLMClient>(makeClient(settings));
  useEffect(() => {
    clientRef.current = makeClient(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientKey, settings.educational, settings.affirm, settings.styleGuide, settings.protectedTerms]);

  const [input, setInput] = useState<string>("");
  const [thread, setThread] = useState<Turn[]>([]);
  // "capturing" — popup just appeared; clipboard capture is in flight.
  // "idle" — capture done, no rewrite started yet (action picker visible).
  // Other phases match the streaming pipeline below.
  const [phase, setPhase] = useState<Phase | "capturing">("capturing");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [firstAction, setFirstAction] = useState<ActionId | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadSettings().viewMode);
  const [pasteFormat, setPasteFormat] = useState<"plain" | "markdown">(() => loadSettings().pasteFormat);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [originalExpanded, setOriginalExpanded] = useState<boolean>(() => loadSettings().originalExpanded);
  const [pendingRepeat, setPendingRepeat] = useState<ActionId | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const streamingNodeRef = useRef<HTMLDivElement>(null!);
  const streamingBufferRef = useRef("");

  useEffect(() => {
    if (threadScrollRef.current) {
      threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
    }
  }, [thread]);

  // Three event flows from Rust:
  //   capture-start          — popup just appeared, clipboard capture in flight
  //   captured-text          — main hotkey: render the action picker
  //   captured-text-repeat   — repeat hotkey: auto-run last action with no UI
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    const resetForCapture = () => {
      abortRef.current?.abort();
      streamingBufferRef.current = "";
      const fresh = loadSettings();
      setSettings(fresh);
      setInput("");
      setThread([]);
      setPhase("capturing");
      setErrorMsg(null);
      setFirstAction(null);
      setShowCustom(false);
      setCustomDraft("");
      setFollowUp("");
      setViewMode(fresh.viewMode);
      setPasteFormat(fresh.pasteFormat);
      setOriginalExpanded(fresh.originalExpanded);
      setStreamStartedAt(null);
      setFirstTokenMs(null);
    };
    void listen<boolean>("capture-start", () => {
      resetForCapture();
    }).then((u) => unlisteners.push(u));
    void listen<string>("captured-text", (event) => {
      setInput(event.payload);
      setPhase("idle");
    }).then((u) => unlisteners.push(u));
    void listen<string>("captured-text-repeat", (event) => {
      setInput(event.payload);
      const last = loadSettings().lastAction;
      if (last && event.payload.trim()) {
        setPendingRepeat(last);
        setPhase("idle");
      } else {
        setPhase("idle");
      }
    }).then((u) => unlisteners.push(u));
    return () => {
      for (const u of unlisteners) u();
    };
  }, []);

  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    void invoke("dismiss_popup");
  }, []);

  // Click-outside dismiss: bind to window blur when the user has opted in.
  // Tauri's `startDragging` and `startResizeDragging` both hand the webview
  // off to a native window-drag operation, which fires blur on the webview
  // even though the user is still interacting with our window. Track those
  // transitions and also defer the dismiss so focus has time to return.
  const draggingRef = useRef(false);
  useEffect(() => {
    const beginDrag = () => {
      draggingRef.current = true;
    };
    const endDrag = () => {
      // Clear on the next tick — mouseup fires before focus returns.
      window.setTimeout(() => {
        draggingRef.current = false;
      }, 250);
    };
    window.addEventListener("mousedown", beginDrag, true);
    window.addEventListener("mouseup", endDrag, true);
    return () => {
      window.removeEventListener("mousedown", beginDrag, true);
      window.removeEventListener("mouseup", endDrag, true);
    };
  }, []);
  useEffect(() => {
    if (!settings.clickOutsideDismiss) return;
    const onBlur = () => {
      if (phase === "streaming" || phase === "capturing") return;
      if (draggingRef.current) return;
      // A native window-drag produces a brief blur/focus cycle. Defer the
      // dismiss long enough that focus can return; only close if it didn't.
      window.setTimeout(() => {
        if (document.hasFocus()) return;
        if (draggingRef.current) return;
        dismiss();
      }, 220);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [settings.clickOutsideDismiss, phase, dismiss]);

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

    // Context budget: send system + the FIRST turn (the actual user selection +
    // initial action) + the most recent assistant + the new user turn. Older
    // intermediate follow-ups get dropped so regenerate / multi-step refinements
    // don't compound token cost. The model still sees the original source.
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(settings) },
    ];
    if (next.length === 0) {
      // Nothing to send — guard against an accidental empty call.
      return;
    }
    messages.push({ role: "user", content: next[0].user });
    if (next[0].assistant && next.length > 1) {
      messages.push({ role: "assistant", content: next[0].assistant });
    }
    if (next.length > 2) {
      const prev = next[next.length - 2];
      if (prev.assistant) {
        messages.push({ role: "assistant", content: prev.assistant });
      }
    }
    if (next.length > 1) {
      const last = next[next.length - 1];
      messages.push({ role: "user", content: last.user });
      if (last.assistant) {
        // Streaming target turn — assistant slot is empty when calling, but if
        // we ever pass an in-progress turn back through, surface it.
        messages.push({ role: "assistant", content: last.assistant });
      }
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
      // Persist the last action (and the custom prompt, if used) so the
      // repeat hotkey and the popup's prompt-history dropdown can recall it.
      const patch: Partial<OllamaSettings> = { lastAction: action };
      if (action === "custom" && customPromptOverride && customPromptOverride.trim()) {
        const current = loadSettings().customPromptHistory;
        const next = [customPromptOverride.trim(), ...current.filter((p) => p !== customPromptOverride.trim())].slice(0, 12);
        patch.customPromptHistory = next;
      }
      patchSettings(patch);
      void streamInto([
        { id: cryptoId(), user: `${instruction}\n\nText:\n${input}`, assistant: "", userLabel },
      ]);
    },
    [input, streamInto],
  );

  // Auto-run when the repeat hotkey fires AFTER the captured text has loaded.
  // We defer until `input` is populated to avoid the "no selection → run"
  // race with the async capture flow.
  useEffect(() => {
    if (!pendingRepeat) return;
    if (!input.trim()) return;
    const action = pendingRepeat;
    setPendingRepeat(null);
    // If the last action was a custom prompt, replay the most recent one.
    const custom =
      action === "custom" ? loadSettings().customPromptHistory[0] : undefined;
    runAction(action, custom);
  }, [pendingRepeat, input, runAction]);

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
    // Paste-format toggle: "plain" strips markdown, "markdown" leaves it as-is
    // so destinations like Slack, Discord, or VS Code render structure intact.
    const pasteText =
      pasteFormat === "markdown" ? main : markdownToPlain(main) || main;
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
    void invoke("accept_rewrite", { text: pasteText });
  }, [thread, input, firstAction, pasteFormat]);

  // Keyboard:
  // Keyboard map driven by settings.bubbleShortcuts (with Esc always dismissing).
  // Disabled inside inputs/textareas so typing isn't intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      const sh = settings.bubbleShortcuts;
      if (thread.length === 0) {
        const actions: { binding: HotkeyBinding; run: () => void }[] = [
          { binding: sh.improve, run: () => runAction("improve") },
          { binding: sh.grammar, run: () => runAction("grammar") },
          { binding: sh.shorten, run: () => runAction("shorten") },
          { binding: sh.expand, run: () => runAction("expand") },
          { binding: sh.custom, run: () => setShowCustom(true) },
        ];
        for (const a of actions) {
          if (keyMatchesBinding(e, a.binding)) {
            e.preventDefault();
            a.run();
            return;
          }
        }
        return;
      }
      if (phase === "ready") {
        if (keyMatchesBinding(e, sh.accept)) {
          e.preventDefault();
          void accept();
          return;
        }
        if (keyMatchesBinding(e, sh.regenerate)) {
          e.preventDefault();
          regenerate();
          return;
        }
      }
      if (phase === "error") {
        if (keyMatchesBinding(e, sh.regenerate) || keyMatchesBinding(e, sh.accept)) {
          e.preventDefault();
          regenerate();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, thread.length, phase, runAction, accept, regenerate, settings.bubbleShortcuts]);

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

  if (license.state.status !== "active") {
    return (
      <Tooltip.Provider delayDuration={250} skipDelayDuration={500}>
        <ActivationGate
          state={license.state}
          loading={license.loading}
          onActivate={license.activate}
          variant="popup"
        />
      </Tooltip.Provider>
    );
  }

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
            <BrandMark size="sm" />
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
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
                Original
              </div>
              <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
                {input && (
                  <span className="tabular-nums">
                    {input.split(/\s+/).filter(Boolean).length}w · ≈{estimateTokens(input)} tok
                  </span>
                )}
                {input && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = !originalExpanded;
                      setOriginalExpanded(next);
                      patchSettings({ originalExpanded: next });
                    }}
                    className="rounded px-1 py-0.5 hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {originalExpanded ? "Collapse" : "Expand"}
                  </button>
                )}
              </div>
            </div>
            <div
              className={`overflow-y-auto rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-fg-muted ${
                originalExpanded ? "max-h-40" : "max-h-16"
              }`}
            >
              {phase === "capturing" && !input ? (
                <span className="flex items-center gap-1.5 italic text-fg-subtle">
                  <Loader2 size={11} className="animate-spin" />
                  Capturing selection…
                </span>
              ) : input ? (
                <span className="whitespace-pre-wrap break-words">{input}</span>
              ) : (
                <span className="italic text-fg-subtle">
                  Select text in any app, then press {formatHotkey(settings.hotkey)}.
                </span>
              )}
            </div>
          </div>

          {thread.length === 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {PRIMARY_ACTIONS.map((a) => (
                  <Chip
                    key={a.id}
                    onClick={() => runAction(a.id)}
                    shortcut={formatHotkey(
                      settings.bubbleShortcuts[a.id as BubbleShortcutId],
                    )}
                  >
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
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-xs font-medium text-fg-muted transition hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      title="Rewrite as a token-efficient LLM/agent prompt"
                    >
                      Prompt
                      <ChevronDown size={11} className="text-fg-subtle" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={4}
                      className="z-50 min-w-[180px] rounded-md border border-border bg-bg-elev p-1 text-sm shadow-md"
                    >
                      {PROMPT_ACTIONS.map((a) => (
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
                {settings.savedTemplates.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-xs font-medium text-fg-muted transition hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        title="Run a saved custom prompt"
                      >
                        Templates
                        <ChevronDown size={11} className="text-fg-subtle" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        sideOffset={4}
                        className="z-50 min-w-[200px] max-w-[320px] rounded-md border border-border bg-bg-elev p-1 text-sm shadow-md"
                      >
                        {settings.savedTemplates.map((t) => (
                          <DropdownMenu.Item
                            key={t.id}
                            onSelect={() => runAction("custom", t.prompt)}
                            className="cursor-pointer rounded px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-bg-subtle"
                          >
                            <div className="truncate font-medium">{t.name}</div>
                            <div className="truncate text-[10px] text-fg-subtle">{t.prompt}</div>
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                <Chip
                  onClick={() => setShowCustom((v) => !v)}
                  active={showCustom}
                  shortcut={formatHotkey(settings.bubbleShortcuts.custom)}
                >
                  Custom…
                </Chip>
              </div>
              {showCustom && (
                <div className="flex flex-col gap-1">
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
                  {settings.customPromptHistory.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-fg-subtle">Recent:</span>
                      {settings.customPromptHistory.slice(0, 6).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => runAction("custom", p)}
                          title={p}
                          className="max-w-[160px] truncate rounded-md border border-border bg-bg px-2 py-0.5 text-[10px] text-fg-muted transition hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
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
                            onClick={() => {
                              setViewMode(m);
                              patchSettings({ viewMode: m });
                            }}
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
                        if (e.key !== "Enter") return;
                        if (followUp.trim()) {
                          submitFollowUp();
                          return;
                        }
                        // Empty follow-up + ready: behave like the global Accept
                        // shortcut so Enter is never a dead key.
                        if (phase === "ready" && lastAssistant.trim()) {
                          e.preventDefault();
                          void accept();
                        }
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
                      <Chip
                        onClick={regenerate}
                        shortcut={formatHotkey(settings.bubbleShortcuts.regenerate)}
                      >
                        Regenerate
                      </Chip>
                      <Chip
                        onClick={accept}
                        primary
                        disabled={!lastAssistant.trim()}
                        shortcut={formatHotkey(settings.bubbleShortcuts.accept)}
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
                      <Chip
                        onClick={regenerate}
                        primary
                        shortcut={formatHotkey(settings.bubbleShortcuts.regenerate)}
                      >
                        Retry
                      </Chip>
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </>
          )}
        </div>
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-elev/80 pl-3 pr-5 text-[10px] text-fg-subtle">
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">Paste as</span>
            <div role="radiogroup" aria-label="Paste format" className="flex gap-0.5 rounded-md bg-bg-subtle p-0.5">
              {(["plain", "markdown"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  role="radio"
                  aria-checked={pasteFormat === fmt}
                  onClick={() => {
                    setPasteFormat(fmt);
                    patchSettings({ pasteFormat: fmt });
                  }}
                  className={
                    pasteFormat === fmt
                      ? "rounded px-1.5 py-0.5 text-[10px] font-medium text-fg bg-bg-elev"
                      : "rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle hover:text-fg"
                  }
                >
                  {fmt === "plain" ? "Plain" : "MD"}
                </button>
              ))}
            </div>
          </div>
          <SupportLinks size="xs" />
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
    if (entries.length === 0) {
      // Permanent removal: delete the key outright instead of writing "[]".
      // After this the next loadHistory() returns [] from the missing-key
      // branch — there is no soft-deleted state anywhere to recover.
      localStorage.removeItem(HISTORY_KEY);
    } else {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    }
  } catch {}
}

function clearHistoryStorage() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
}

// Download the saved history as JSON or Markdown. The browser context is
// already a Tauri webview, so a regular <a download> kicks off the OS save
// dialog through the standard webview pathway — no special permission needed.
function exportHistory(format: "json" | "markdown") {
  const entries = loadHistory();
  let payload: string;
  let mime: string;
  let ext: string;
  if (format === "json") {
    payload = JSON.stringify(entries, null, 2);
    mime = "application/json";
    ext = "json";
  } else {
    const lines: string[] = [
      "# R3write history export",
      "",
      `_Exported ${new Date().toISOString()}_`,
      "",
    ];
    for (const e of entries) {
      lines.push(`## ${actionLabel(e.action)} · ${new Date(e.timestamp).toLocaleString()}`);
      lines.push("");
      lines.push("**Original**");
      lines.push("");
      lines.push("```");
      lines.push(e.original);
      lines.push("```");
      lines.push("");
      lines.push("**Rewrite**");
      lines.push("");
      lines.push(e.rewrite);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    payload = lines.join("\n");
    mime = "text/markdown";
    ext = "md";
  }
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `r3write-history-${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      if (id.startsWith("prompt:")) {
        const sub = id.slice("prompt:".length);
        const pretty = sub.charAt(0).toUpperCase() + sub.slice(1);
        return `Prompt: ${pretty}`;
      }
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

// Which list the main window is showing. Rewrites and autocorrections are
// different enough to keep apart — one is something you asked for, the other is
// something that happened to you — but they compete for the same small window,
// so they share a header rather than stacking two.
type PanelTab = "history" | "autocorrect";

function PanelTabs({
  value,
  onChange,
}: {
  value: PanelTab;
  onChange: (t: PanelTab) => void;
}) {
  const tabs: { id: PanelTab; label: string }[] = [
    { id: "history", label: "History" },
    { id: "autocorrect", label: "Autocorrect" },
  ];
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            value === t.id
              ? "bg-bg-subtle text-fg"
              : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function HistoryListPanel({
  entries,
  revertError,
  onRevert,
  onClear,
  hotkey,
  onTabChange,
}: {
  entries: HistoryEntry[];
  revertError: string | null;
  onRevert: (e: HistoryEntry) => void;
  onClear: () => void;
  hotkey: HotkeyBinding;
  onTabChange: (t: PanelTab) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);
  // Reset the pending-confirm if entries hit zero underneath (e.g. confirm
  // expires after a clear actually ran, or another path emptied the list).
  useEffect(() => {
    if (entries.length === 0) setConfirmClear(false);
  }, [entries.length]);

  return (
    <section className="flex flex-1 flex-col overflow-hidden bg-bg-elev text-fg">
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <PanelTabs value="history" onChange={onTabChange} />
        {entries.length > 0 &&
          (confirmClear ? (
            <button
              type="button"
              onClick={() => {
                setConfirmClear(false);
                onClear();
              }}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-danger-bg px-2 py-1 text-[11px] font-semibold text-danger ring-1 ring-danger/40 transition hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
            >
              <Trash2 size={12} />
              Confirm · permanent
            </button>
          ) : (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
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
                  Clear all (permanent)
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ))}
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
                Press {formatHotkey(hotkey)} on selected text to start.
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

// Entry render is owned by ./entry-main.tsx and ./entry-quick-edit.tsx; this
// module just exports the App and QuickEdit components. Splitting entries lets
// Vite produce two bundles: the popup no longer drags in the main window's
// SettingsDialog / history UI, and the main window no longer drags in the
// streaming-popup machinery.

// ---------- Autocorrect log ----------
//
// Rust owns this list — corrections originate there, and the log is persisted to
// the app data dir rather than localStorage precisely because `r3write.history.v1`
// is reachable only from this webview. We fetch once and then follow events.

function AutocorrectLogPanel({
  enabled,
  onTabChange,
}: {
  enabled: boolean;
  onTabChange: (t: PanelTab) => void;
}) {
  const [entries, setEntries] = useState<CorrectionEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** Highest event version applied. The bubble window subscribes to the same
   *  stream; the stamp makes out-of-order delivery impossible rather than
   *  merely unlikely. */
  const versionRef = useRef(0);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // Merge by id rather than replace. The initial fetch and the live listener are
    // two unordered async sources over the same log, so a correction landing while
    // `getLog()` is in flight otherwise appears twice — once appended by the event,
    // once again in the snapshot — with duplicate React keys.
    //
    // The version stamp cannot help here: `versionRef` restarts at 0 on every mount
    // and the fetched snapshot carries no version to compare against.
    const mergeById = (prev: CorrectionEntry[], incoming: CorrectionEntry[]) => {
      const seen = new Set(prev.map((e) => e.id));
      const fresh = incoming.filter((e) => !seen.has(e.id));
      return fresh.length === 0 ? prev : [...prev, ...fresh];
    };

    void getLog()
      .then((fetched) => setEntries((prev) => mergeById(prev, fetched)))
      .catch(() => {});

    let unApplied: (() => void) | undefined;
    let unReverted: (() => void) | undefined;

    void listen<AppliedEvent>(APPLIED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.version <= versionRef.current) return;
      versionRef.current = p.version;
      setEntries((prev) => mergeById(prev, [p.entry]));
    }).then((u) => {
      unApplied = u;
    });

    void listen<RevertedEvent>(REVERTED_EVENT, (e) => {
      const p = e.payload;
      if (!p) return;
      setEntries((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, reverted: true } : x)),
      );
    }).then((u) => {
      unReverted = u;
    });

    return () => {
      unApplied?.();
      unReverted?.();
    };
  }, []);

  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);
  useEffect(() => {
    if (entries.length === 0) setConfirmClear(false);
  }, [entries.length]);

  // Copy rather than re-inject. In-place revert is only meaningful while the
  // correction is still the last thing typed — which is what the bubble's Undo
  // and Ctrl+Alt+Z are for. By the time you are reading this list, the caret has
  // long since moved, and re-injecting would damage whatever is under it now.
  const copyOriginal = useCallback(async (e: CorrectionEntry) => {
    try {
      await invoke("set_clipboard", { text: e.original });
      setCopied(e.id);
      window.setTimeout(() => setCopied((c) => (c === e.id ? null : c)), 1600);
    } catch {}
  }, []);

  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <section className="flex flex-1 flex-col overflow-hidden bg-bg-elev text-fg">
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <PanelTabs value="autocorrect" onChange={onTabChange} />
        {entries.length > 0 &&
          (confirmClear ? (
            <button
              type="button"
              onClick={() => {
                setConfirmClear(false);
                void clearLog().then(() => setEntries([])).catch(() => {});
              }}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-danger-bg px-2 py-1 text-[11px] font-semibold text-danger ring-1 ring-danger/40 transition hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
            >
              <Trash2 size={12} />
              Confirm · permanent
            </button>
          ) : (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
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
                  Clear all (permanent)
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!enabled && (
          <div className="mb-3 rounded-md border border-border bg-bg-subtle p-3 text-[12px] text-fg-muted">
            Autocorrect is off. Turn it on in{" "}
            <span className="font-medium text-fg">Settings → Autocorrect</span>.
          </div>
        )}

        {newestFirst.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Sparkle size={20} className="mb-2 text-fg-subtle" />
            <p className="text-sm text-fg-muted">No corrections yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
              Spelling fixes made while you type will be listed here, newest first.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {newestFirst.map((e) => (
              <li
                key={e.id}
                className="rounded-lg border border-border bg-bg-subtle p-3 text-sm transition hover:border-border-strong"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-fg-muted">
                    {e.app || "unknown app"} · {timeAgo(e.timestamp, now)}
                  </span>
                  {e.reverted && (
                    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                      reverted
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="truncate text-fg-muted line-through">{e.original}</span>
                  <span aria-hidden className="shrink-0 text-fg-subtle">
                    &rarr;
                  </span>
                  <span className="truncate font-medium text-fg">{e.correction}</span>
                </div>

                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void copyOriginal(e)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:bg-bg hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <RotateCcw size={11} />
                    {copied === e.id ? "Copied" : "Copy original"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
