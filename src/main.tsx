import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { diffWordsWithSpace, type Change } from "diff";
import type { Node as PMNode } from "@tiptap/pm/model";
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

interface LLMClient {
  rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string>;
}

const SYSTEM_PROMPT =
  "You are an inline writing assistant. Rewrite the user's text per the instruction. " +
  "Reply with ONLY the rewritten text — no preamble, no quotes, no explanation, no markdown fencing.";

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

  async *rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string> {
    const instruction = actionInstruction(action, opts?.customPrompt);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.provider === "cloud" && this.settings.apiKey) {
      headers["Authorization"] = `Bearer ${this.settings.apiKey}`;
    }
    const body = JSON.stringify({
      model: this.settings.model,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${instruction}\n\nText:\n${input}` },
      ],
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
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  primary?: boolean;
}) {
  const base = "rounded px-2 py-1 text-xs font-medium transition";
  const tone = primary
    ? "bg-indigo-600 text-white hover:bg-indigo-700"
    : active
      ? "bg-zinc-200 text-zinc-900"
      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200";
  return (
    <button type="button" onClick={onClick} className={`${base} ${tone}`}>
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

function QuickEdit() {
  const [settings, setSettings] = useState<OllamaSettings>(() => loadSettings());
  const clientRef = useRef<OllamaClient>(new OllamaClient(settings));
  useEffect(() => {
    clientRef.current = new OllamaClient(settings);
  }, [settings]);

  const [input, setInput] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [streamed, setStreamed] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionId | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [showTone, setShowTone] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [diffMode, setDiffMode] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("captured-text", (event) => {
      setSettings(loadSettings());
      setInput(event.payload);
      setPhase("idle");
      setStreamed("");
      setErrorMsg(null);
      setPendingAction(null);
      setPendingPrompt("");
      setShowTone(false);
      setShowCustom(false);
      setCustomDraft("");
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

  const runAction = useCallback(
    async (action: ActionId, customPromptOverride?: string) => {
      if (!input.trim()) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setPendingAction(action);
      setPendingPrompt(customPromptOverride ?? "");
      setPhase("streaming");
      setStreamed("");
      setErrorMsg(null);
      try {
        let acc = "";
        for await (const chunk of clientRef.current.rewrite(input, action, {
          signal: ctrl.signal,
          customPrompt: customPromptOverride,
        })) {
          if (ctrl.signal.aborted) return;
          acc += chunk;
          setStreamed(acc);
        }
        if (!ctrl.signal.aborted) setPhase("ready");
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [input],
  );

  const accept = useCallback(async () => {
    if (pendingAction && input.trim() && streamed.trim()) {
      const entry: HistoryEntry = {
        id: cryptoId(),
        timestamp: Date.now(),
        action: pendingAction,
        original: input,
        rewrite: streamed,
      };
      try {
        await emit("history:add", entry);
      } catch {}
    }
    void invoke("accept_rewrite", { text: streamed });
  }, [streamed, pendingAction, input]);

  const regenerate = useCallback(() => {
    if (pendingAction) void runAction(pendingAction, pendingPrompt);
  }, [pendingAction, pendingPrompt, runAction]);

  return (
    <div className="flex h-full flex-col gap-2 rounded-lg border border-zinc-300 bg-white p-3 shadow-2xl">
      <div
        data-tauri-drag-region
        className="flex cursor-move items-center justify-between select-none"
      >
        <span
          data-tauri-drag-region
          className="text-[11px] font-medium uppercase tracking-wide text-zinc-500"
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
      <div className="max-h-16 overflow-y-auto rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
        {input || <span className="italic text-zinc-400">Select text in any app, then press Ctrl+Alt+G.</span>}
      </div>
      {phase === "idle" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {PRIMARY_ACTIONS.map((a) => (
              <BubbleButton key={a.id} onClick={() => runAction(a.id)}>
                {a.label}
              </BubbleButton>
            ))}
            <BubbleButton onClick={() => { setShowTone((v) => !v); setShowCustom(false); }} active={showTone}>
              Tone ▾
            </BubbleButton>
            <BubbleButton onClick={() => { setShowCustom((v) => !v); setShowTone(false); }} active={showCustom}>
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
                  if (e.key === "Enter" && customDraft.trim()) runAction("custom", customDraft.trim());
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
          {phase === "error" ? (
            <div className="rounded bg-red-50 p-2 text-xs text-red-700">
              {errorMsg || "Rewrite failed."}
            </div>
          ) : phase === "ready" ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {diffMode ? "Diff" : "Rewrite"}
                </span>
                <button
                  type="button"
                  onClick={() => setDiffMode((v) => !v)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-700"
                >
                  {diffMode ? "Show plain" : "Show diff"}
                </button>
              </div>
              <div className="max-h-40 flex-1 overflow-y-auto rounded bg-zinc-50 p-2 text-sm text-zinc-800">
                {diffMode ? <DiffView original={input} rewrite={streamed} /> : streamed}
              </div>
            </>
          ) : (
            <div className="max-h-32 flex-1 overflow-y-auto rounded bg-zinc-50 p-2 text-sm text-zinc-800">
              {streamed || <span className="text-zinc-400">Thinking…</span>}
              {phase === "streaming" && (
                <span className="ml-0.5 animate-pulse text-indigo-500">▍</span>
              )}
            </div>
          )}
          <div className="flex justify-end gap-1">
            {phase === "streaming" && <BubbleButton onClick={dismiss}>Cancel</BubbleButton>}
            {phase === "ready" && (
              <>
                <BubbleButton onClick={dismiss}>Reject</BubbleButton>
                <BubbleButton onClick={regenerate}>Regenerate</BubbleButton>
                <BubbleButton onClick={accept} primary>
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
  const parts: Change[] = diffWordsWithSpace(original, rewrite);
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
