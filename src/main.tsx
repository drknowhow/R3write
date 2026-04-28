import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
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
  const clientRef = useRef<OllamaClient>(new OllamaClient(settings));
  useEffect(() => {
    clientRef.current = new OllamaClient(settings);
    saveSettings(settings);
  }, [settings]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [streamed, setStreamed] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionId | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string>("");
  const [showTone, setShowTone] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const selectionRef = useRef<{ from: number; to: number } | null>(null);

  const resetBubble = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    selectionRef.current = null;
    setPhase("idle");
    setStreamed("");
    setErrorMsg(null);
    setPendingAction(null);
    setPendingPrompt("");
    setShowTone(false);
    setShowCustom(false);
    setCustomDraft("");
  }, []);

  const runAction = useCallback(
    async (action: ActionId, customPromptOverride?: string) => {
      if (!editor) return;
      const { from, to, empty } = editor.state.selection;
      if (empty && !selectionRef.current) return;
      const range = selectionRef.current ?? { from, to };
      selectionRef.current = range;
      const input = editor.state.doc.textBetween(range.from, range.to, " ");

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
    [editor],
  );

  const accept = useCallback(() => {
    if (!editor || !selectionRef.current) return;
    const { from, to } = selectionRef.current;
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .insertContent(streamed)
      .run();
    resetBubble();
  }, [editor, streamed, resetBubble]);

  const regenerate = useCallback(() => {
    if (pendingAction) void runAction(pendingAction, pendingPrompt);
  }, [pendingAction, pendingPrompt, runAction]);

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
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
        <EditorContent editor={editor} className="tiptap" />
        <BubbleMenu
          editor={editor}
          tippyOptions={{
            placement: "top",
            maxWidth: 520,
            interactive: true,
            appendTo: () => document.body,
          }}
          shouldShow={({ editor: e }) => {
            if (phase !== "idle") return true;
            const { from, to } = e.state.selection;
            return from !== to;
          }}
        >
          <BubbleContent
            phase={phase}
            streamed={streamed}
            errorMsg={errorMsg}
            showTone={showTone}
            showCustom={showCustom}
            customDraft={customDraft}
            onToggleTone={() => {
              setShowTone((v) => !v);
              setShowCustom(false);
            }}
            onToggleCustom={() => {
              setShowCustom((v) => !v);
              setShowTone(false);
            }}
            onChangeCustom={setCustomDraft}
            onAction={(id) => {
              const { from, to } = editor.state.selection;
              selectionRef.current = { from, to };
              if (id === "custom") {
                if (!customDraft.trim()) return;
                void runAction("custom", customDraft.trim());
              } else {
                void runAction(id);
              }
            }}
            onCancel={resetBubble}
            onAccept={accept}
            onRegenerate={regenerate}
          />
        </BubbleMenu>
      </main>
    </div>
  );
}

// ---------- Bubble UI ----------

interface BubbleProps {
  phase: Phase;
  streamed: string;
  errorMsg: string | null;
  showTone: boolean;
  showCustom: boolean;
  customDraft: string;
  onToggleTone: () => void;
  onToggleCustom: () => void;
  onChangeCustom: (v: string) => void;
  onAction: (id: ActionId) => void;
  onCancel: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
}

function BubbleContent(p: BubbleProps) {
  if (p.phase === "idle") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg">
        <div className="flex flex-wrap gap-1">
          {PRIMARY_ACTIONS.map((a) => (
            <BubbleButton key={a.id} onClick={() => p.onAction(a.id)}>
              {a.label}
            </BubbleButton>
          ))}
          <BubbleButton onClick={p.onToggleTone} active={p.showTone}>
            Tone ▾
          </BubbleButton>
          <BubbleButton onClick={p.onToggleCustom} active={p.showCustom}>
            Custom…
          </BubbleButton>
        </div>
        {p.showTone && (
          <div className="flex flex-wrap gap-1 border-t border-zinc-100 pt-2">
            {TONE_ACTIONS.map((a) => (
              <BubbleButton key={a.id} onClick={() => p.onAction(a.id)}>
                {a.label}
              </BubbleButton>
            ))}
          </div>
        )}
        {p.showCustom && (
          <div className="flex gap-1 border-t border-zinc-100 pt-2">
            <input
              autoFocus
              value={p.customDraft}
              onChange={(e) => p.onChangeCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") p.onAction("custom");
              }}
              placeholder="Describe the rewrite…"
              className="flex-1 rounded border border-zinc-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
            />
            <BubbleButton onClick={() => p.onAction("custom")}>Run</BubbleButton>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-[420px] flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg">
      {p.phase === "error" ? (
        <div className="rounded bg-red-50 p-2 text-xs text-red-700">
          {p.errorMsg || "Rewrite failed."}
        </div>
      ) : (
        <div className="max-h-40 overflow-y-auto rounded bg-zinc-50 p-2 text-sm text-zinc-800">
          {p.streamed || <span className="text-zinc-400">Thinking…</span>}
          {p.phase === "streaming" && (
            <span className="ml-0.5 animate-pulse text-indigo-500">▍</span>
          )}
        </div>
      )}
      <div className="flex justify-end gap-1">
        {p.phase === "streaming" && <BubbleButton onClick={p.onCancel}>Cancel</BubbleButton>}
        {p.phase === "ready" && (
          <>
            <BubbleButton onClick={p.onCancel}>Reject</BubbleButton>
            <BubbleButton onClick={p.onRegenerate}>Regenerate</BubbleButton>
            <BubbleButton onClick={p.onAccept} primary>
              Accept
            </BubbleButton>
          </>
        )}
        {p.phase === "error" && (
          <>
            <BubbleButton onClick={p.onCancel}>Dismiss</BubbleButton>
            <BubbleButton onClick={p.onRegenerate} primary>
              Retry
            </BubbleButton>
          </>
        )}
      </div>
    </div>
  );
}

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

// Re-export type for downstream files (none yet, but useful when we split).
export type { LLMClient, ActionId, Editor };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
