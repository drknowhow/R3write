import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { diffWordsWithSpace, type Change } from "diff";
import type { Node as PMNode } from "@tiptap/pm/model";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "tippy.js/dist/tippy.css";
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

const SYSTEM_PROMPT =
  "You are an inline writing assistant. Rewrite the user's text per the instruction. " +
  "Reply with ONLY the rewritten text — no preamble, no quotes, no explanation, no surrounding code fences. " +
  "You MAY use Markdown when the rewrite is naturally structured: bullet or numbered lists for enumerations, " +
  "blank-line-separated paragraphs for multi-paragraph prose, **bold** / *italic* for emphasis the user asked for or " +
  "that the source clearly carried, headings for section titles, and `inline code` for code-like fragments. " +
  "Do NOT add structure that isn't warranted: a single sentence stays a single sentence with no formatting.";

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

function RenderedMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => markdownToHtml(markdown), [markdown]);
  return (
    <div
      className="prose-r3w break-words text-zinc-800"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ThinkingIndicator({
  startedAt,
  model,
}: {
  startedAt: number | null;
  model?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt != null ? Math.max(0, (now - startedAt) / 1000) : 0;
  const phrase =
    elapsed < 2 ? "Thinking"
    : elapsed < 5 ? "Generating"
    : elapsed < 15 ? "Working on it"
    : "Still working — large input?";
  return (
    <div className="flex items-center gap-2 text-zinc-500">
      <span
        aria-hidden
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500"
      />
      <span className="text-zinc-600">
        {phrase}
        <span aria-hidden className="thinking-dots ml-0.5">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </span>
      {model && <span className="hidden text-zinc-400 sm:inline">· {model}</span>}
      <span className="ml-auto tabular-nums text-zinc-400">{elapsed.toFixed(1)}s</span>
    </div>
  );
}

interface OllamaSettings {
  provider: "cloud" | "local";
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_SETTINGS: OllamaSettings = {
  provider: "cloud",
  baseUrl: "https://ollama.com",
  model: "gemma4:31b-cloud",
  apiKey: "",
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
        { role: "system", content: SYSTEM_PROMPT },
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
    content:
      "<h1>R3write</h1><p>Select any text and a small toolbar will appear with AI rewrite options. Try selecting this sentence and clicking <strong>Improve</strong>.</p><p>By default this app talks to Ollama Cloud with model <code>gemma4:31b-cloud</code>. Open Settings (top right) to paste your API key, or switch to a local Ollama instance.</p>",
  });

  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
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
  const [showHistory, setShowHistory] = useState(false);
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
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-700">R3write</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>
            {settings.provider === "cloud" ? "Ollama Cloud" : "Local Ollama"} · {settings.model}
          </span>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="rounded border border-zinc-200 px-2 py-1 hover:bg-zinc-50"
          >
            History ({history.length})
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="rounded border border-zinc-200 px-2 py-1 hover:bg-zinc-50"
          >
            Settings
          </button>
        </div>
      </header>
      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
        />
      )}
      {showHistory && (
        <HistoryPanel
          entries={history}
          revertError={revertError}
          onRevert={revert}
          onClear={() => {
            setHistory([]);
            setRevertError(null);
          }}
          onClose={() => {
            setShowHistory(false);
            setRevertError(null);
          }}
        />
      )}
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
        <EditorContent editor={editor} className="tiptap" />
      </main>
    </div>
  );
}

// ---------- Bubble UI ----------

// ---------- Settings ----------

function SettingsModal({
  settings,
  onClose,
  onSave,
}: {
  settings: OllamaSettings;
  onClose: () => void;
  onSave: (s: OllamaSettings) => void;
}) {
  const [draft, setDraft] = useState<OllamaSettings>(settings);
  const update = (patch: Partial<OllamaSettings>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-lg border border-zinc-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold text-zinc-800">Settings</h2>

        <Field label="Provider">
          <select
            value={draft.provider}
            onChange={(e) => {
              const provider = e.target.value as OllamaSettings["provider"];
              update({ provider, ...defaultsForProvider(provider) });
            }}
            className="w-full rounded border border-zinc-200 px-2 py-1 text-sm"
          >
            <option value="cloud">Ollama Cloud</option>
            <option value="local">Local Ollama</option>
          </select>
        </Field>

        <Field label="Base URL">
          <input
            value={draft.baseUrl}
            onChange={(e) => update({ baseUrl: e.target.value })}
            className="w-full rounded border border-zinc-200 px-2 py-1 text-sm"
          />
        </Field>

        <Field label="Model">
          <input
            value={draft.model}
            onChange={(e) => update({ model: e.target.value })}
            placeholder="gemma4:31b-cloud"
            className="w-full rounded border border-zinc-200 px-2 py-1 text-sm"
          />
        </Field>

        {draft.provider === "cloud" && (
          <Field label="API key">
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder="ollama-…"
              className="w-full rounded border border-zinc-200 px-2 py-1 text-sm"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Stored in localStorage for now; will move to Windows Credential Manager in a later milestone.
            </p>
          </Field>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
    </label>
  );
}

function BubbleButton({
  children,
  onClick,
  active,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  const base = "rounded px-2 py-1 text-xs font-medium transition";
  const tone = disabled
    ? "bg-zinc-100 text-zinc-400 cursor-not-allowed"
    : primary
      ? "bg-indigo-600 text-white hover:bg-indigo-700"
      : active
        ? "bg-zinc-200 text-zinc-900"
        : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${tone}`}
    >
      {children}
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
  user: string;
  assistant: string;
  userLabel: string;
}

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
  const [showTone, setShowTone] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [viewMode, setViewMode] = useState<"rendered" | "plain" | "diff">("rendered");
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (threadScrollRef.current) {
      threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
    }
  }, [thread]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("captured-text", (event) => {
      abortRef.current?.abort();
      setSettings(loadSettings());
      setInput(event.payload);
      setThread([]);
      setPhase("idle");
      setErrorMsg(null);
      setFirstAction(null);
      setShowTone(false);
      setShowCustom(false);
      setCustomDraft("");
      setFollowUp("");
      setStreamStartedAt(null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const streamInto = useCallback(async (next: Turn[]) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("streaming");
    setStreamStartedAt(Date.now());
    setErrorMsg(null);
    setThread(next);

    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const t of next) {
      messages.push({ role: "user", content: t.user });
      if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
    }

    try {
      let acc = "";
      for await (const chunk of clientRef.current.chat(messages, { signal: ctrl.signal })) {
        if (ctrl.signal.aborted) return;
        acc += chunk;
        setThread((tt) => {
          const copy = [...tt];
          copy[copy.length - 1] = { ...copy[copy.length - 1], assistant: acc };
          return copy;
        });
      }
      if (!ctrl.signal.aborted) {
        setPhase("ready");
        setStreamStartedAt(null);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
      setStreamStartedAt(null);
    }
  }, []);

  const runAction = useCallback(
    (action: ActionId, customPromptOverride?: string) => {
      if (!input.trim()) return;
      const instruction = actionInstruction(action, customPromptOverride);
      const userLabel =
        action === "custom" ? customPromptOverride || "Custom" : actionLabel(action);
      setFirstAction(action);
      setShowTone(false);
      setShowCustom(false);
      setCustomDraft("");
      void streamInto([
        { user: `${instruction}\n\nText:\n${input}`, assistant: "", userLabel },
      ]);
    },
    [input, streamInto],
  );

  const sendFollowUp = useCallback(
    (user: string, userLabel: string) => {
      if (thread.length === 0 || phase === "streaming") return;
      void streamInto([...thread, { user, assistant: "", userLabel }]);
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
    void streamInto([...thread.slice(0, -1), { ...last, assistant: "" }]);
  }, [thread, streamInto]);

  const accept = useCallback(async () => {
    const last = thread[thread.length - 1];
    if (!last?.assistant.trim() || !firstAction) return;
    // Strip Markdown markers for paste-back: external apps receive clean
    // prose, not `* item` / `**bold**`. The same stripped form is recorded
    // in history so revert in the main editor matches what was pasted.
    const pasteText = markdownToPlain(last.assistant) || last.assistant;
    const entry: HistoryEntry = {
      id: cryptoId(),
      timestamp: Date.now(),
      action: firstAction,
      original: input,
      rewrite: pasteText,
    };
    // Cross-window: target the main webview explicitly. `emit` is a broadcast
    // and has been observed to silently no-op across windows in some Tauri 2
    // builds — `emitTo("main", …)` is the explicit form. We also `emit` as a
    // fallback so the event still reaches any future listeners.
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

  const lastAssistant = thread[thread.length - 1]?.assistant ?? "";

  return (
    <div className="relative flex h-full flex-col gap-2 rounded-lg border border-zinc-300 bg-white p-3 shadow-2xl">
      <div
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
          void getCurrentWebviewWindow().startDragging();
        }}
        className="flex cursor-move items-center justify-between select-none"
      >
        <span
          data-tauri-drag-region
          className="pointer-events-none text-[11px] font-medium uppercase tracking-wide text-zinc-500"
        >
          Quick edit · {settings.model}
        </span>
        <button
          type="button"
          onClick={dismiss}
          onMouseDown={(e) => e.stopPropagation()}
          className="text-xs text-zinc-400 hover:text-zinc-700"
          title="Esc"
        >
          ✕
        </button>
      </div>
      <div
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          void getCurrentWebviewWindow().startResizeDragging("SouthEast");
        }}
        title="Drag to resize"
        className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-se-resize"
        style={{
          background:
            "linear-gradient(135deg, transparent 0 50%, #a1a1aa 50% 60%, transparent 60% 70%, #a1a1aa 70% 80%, transparent 80%)",
        }}
      />
      <div className="max-h-16 overflow-y-auto rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
        {input || (
          <span className="italic text-zinc-400">
            Select text in any app, then press Ctrl+Alt+G.
          </span>
        )}
      </div>

      {thread.length === 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {PRIMARY_ACTIONS.map((a) => (
              <BubbleButton key={a.id} onClick={() => runAction(a.id)}>
                {a.label}
              </BubbleButton>
            ))}
            <BubbleButton
              onClick={() => {
                setShowTone((v) => !v);
                setShowCustom(false);
              }}
              active={showTone}
            >
              Tone ▾
            </BubbleButton>
            <BubbleButton
              onClick={() => {
                setShowCustom((v) => !v);
                setShowTone(false);
              }}
              active={showCustom}
            >
              Custom…
            </BubbleButton>
          </div>
          {showTone && (
            <div className="flex flex-wrap gap-1 border-t border-zinc-100 pt-2">
              {TONE_ACTIONS.map((a) => (
                <BubbleButton key={a.id} onClick={() => runAction(a.id)}>
                  {a.label}
                </BubbleButton>
              ))}
            </div>
          )}
          {showCustom && (
            <div className="flex gap-1 border-t border-zinc-100 pt-2">
              <input
                autoFocus
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customDraft.trim()) {
                    runAction("custom", customDraft.trim());
                  }
                }}
                placeholder="Describe the rewrite…"
                className="flex-1 rounded border border-zinc-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
              />
              <BubbleButton
                onClick={() => customDraft.trim() && runAction("custom", customDraft.trim())}
              >
                Run
              </BubbleButton>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-[10px]">
            <span className="font-medium uppercase tracking-wide text-zinc-400">
              {viewMode === "rendered"
                ? "Latest reply (rendered)"
                : viewMode === "plain"
                ? "Latest reply (markdown source)"
                : "Latest reply as diff vs original"}
            </span>
            <div className="flex gap-1 text-zinc-500">
              {(["rendered", "diff", "plain"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={
                    viewMode === m
                      ? "rounded bg-zinc-200 px-1.5 py-0.5 text-zinc-800"
                      : "rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-700"
                  }
                >
                  {m === "rendered" ? "Rendered" : m === "diff" ? "Diff" : "Source"}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={threadScrollRef}
            className="flex-1 min-h-32 overflow-y-auto rounded bg-zinc-50 p-2 text-sm"
          >
            {thread.map((turn, i) => {
              const isLast = i === thread.length - 1;
              const isStreaming = isLast && phase === "streaming";
              const isLatestWithText = isLast && !!turn.assistant;
              return (
                <div key={i} className={i > 0 ? "mt-3 border-t border-zinc-200 pt-2" : ""}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                    ▶ {turn.userLabel}
                  </div>
                  <div className="mt-1 break-words text-zinc-800">
                    {!turn.assistant ? (
                      isStreaming ? (
                        <ThinkingIndicator
                          startedAt={streamStartedAt}
                          model={settings.model}
                        />
                      ) : (
                        <span className="text-zinc-400">(no response)</span>
                      )
                    ) : isLatestWithText && viewMode === "diff" ? (
                      <DiffView original={input} rewrite={turn.assistant} />
                    ) : isLatestWithText && viewMode === "plain" ? (
                      <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-700">
                        {turn.assistant}
                      </pre>
                    ) : (
                      <RenderedMarkdown markdown={turn.assistant} />
                    )}
                    {isStreaming && turn.assistant && (
                      <span className="ml-0.5 animate-pulse text-indigo-500">▍</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {phase === "error" && (
            <div className="rounded bg-red-50 p-2 text-xs text-red-700">
              {errorMsg || "Rewrite failed."}
            </div>
          )}

          {phase !== "streaming" && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-1">
                {TONE_ACTIONS.map((a) => (
                  <BubbleButton
                    key={a.id}
                    onClick={() =>
                      sendFollowUp(actionInstruction(a.id), `Tone: ${a.id.slice(5)}`)
                    }
                  >
                    {a.label}
                  </BubbleButton>
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
                  className="flex-1 rounded border border-zinc-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
                />
                <BubbleButton onClick={submitFollowUp}>Send</BubbleButton>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-1">
            {phase === "streaming" && <BubbleButton onClick={dismiss}>Cancel</BubbleButton>}
            {phase === "ready" && (
              <>
                <BubbleButton onClick={dismiss}>Reject</BubbleButton>
                <BubbleButton onClick={regenerate}>Regenerate</BubbleButton>
                <BubbleButton onClick={accept} primary disabled={!lastAssistant.trim()}>
                  Accept &amp; paste
                </BubbleButton>
              </>
            )}
            {phase === "error" && (
              <>
                <BubbleButton onClick={dismiss}>Dismiss</BubbleButton>
                <BubbleButton onClick={regenerate} primary>
                  Retry
                </BubbleButton>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Diff view ----------

function DiffView({ original, rewrite }: { original: string; rewrite: string }) {
  // Strip Markdown from the rewrite first so the inline word diff doesn't
  // light up `**`, `*`, `#`, list bullets etc. as additions against a plain
  // original. The original is captured via clipboard text, so it's plain.
  const rewritePlain = useMemo(() => markdownToPlain(rewrite) || rewrite, [rewrite]);
  const parts: Change[] = diffWordsWithSpace(original, rewritePlain);
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed">
      {parts.map((p, i) => {
        if (p.added) {
          return (
            <span key={i} className="rounded bg-green-100 text-green-900">
              {p.value}
            </span>
          );
        }
        if (p.removed) {
          return (
            <span key={i} className="rounded bg-red-100 text-red-700 line-through">
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

function HistoryPanel({
  entries,
  revertError,
  onRevert,
  onClear,
  onClose,
}: {
  entries: HistoryEntry[];
  revertError: string | null;
  onRevert: (e: HistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[560px] flex-col rounded-lg border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-base font-semibold text-zinc-800">History</h2>
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="text-xs text-zinc-500 hover:text-zinc-800"
              >
                Clear all
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-700"
            >
              ✕
            </button>
          </div>
        </div>
        {revertError && (
          <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
            {revertError}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-400">
              No rewrites yet. Accept a rewrite from the bubble to start tracking.
            </p>
          ) : (
            <ul className="space-y-3">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-600">
                      {actionLabel(e.action)} · {timeAgo(e.timestamp, now)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRevert(e)}
                      className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200"
                    >
                      Revert
                    </button>
                  </div>
                  <DiffView original={e.original} rewrite={e.rewrite} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// Re-export type for downstream files (none yet, but useful when we split).
export type { LLMClient, ActionId, Editor };

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
