import React, { useCallback, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
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
//
// Milestone 2 ships a deterministic mock so the editor UX can be validated
// without Ollama. Milestone 3 will swap MockLLM for an Ollama-backed client
// behind the same interface.

interface RewriteOptions {
  customPrompt?: string;
  signal?: AbortSignal;
}

interface LLMClient {
  rewrite(input: string, action: ActionId, opts?: RewriteOptions): AsyncIterable<string>;
}

function mockTransform(input: string, action: ActionId, customPrompt?: string): string {
  switch (action) {
    case "improve":
      return input
        .split(/(?<=[.!?])\s+/)
        .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
        .join(" ");
    case "grammar":
      return input.replace(/\s+/g, " ").trim();
    case "shorten": {
      const words = input.split(/\s+/);
      const keep = Math.max(3, Math.floor(words.length * 0.6));
      return words.slice(0, keep).join(" ");
    }
    case "expand":
      return `${input} In other words, this point can be unpacked further with concrete examples and supporting context.`;
    case "custom":
      return `[${customPrompt || "rewrite"}] ${input}`;
    default:
      if (action.startsWith("tone:")) {
        const tone = action.slice("tone:".length);
        return `[${tone}] ${input}`;
      }
      return input;
  }
}

const MockLLM: LLMClient = {
  async *rewrite(input, action, opts) {
    const output = mockTransform(input, action, opts?.customPrompt);
    const chunkSize = 6;
    for (let i = 0; i < output.length; i += chunkSize) {
      if (opts?.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 25));
      yield output.slice(i, i + chunkSize);
    }
  },
};

// ---------- App ----------

type Phase = "idle" | "streaming" | "ready" | "error";

function App() {
  const editor = useEditor({
    extensions: [StarterKit],
    content:
      "<h1>R3write</h1><p>Select any text and a small toolbar will appear with AI rewrite options. Try selecting this sentence and clicking <strong>Improve</strong>.</p><p>Streaming is mocked for now: every action produces a deterministic rewrite so we can validate accept, reject, and regenerate before wiring up Ollama.</p>",
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [streamed, setStreamed] = useState("");
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

      try {
        let acc = "";
        for await (const chunk of MockLLM.rewrite(input, action, {
          signal: ctrl.signal,
          customPrompt: customPromptOverride,
        })) {
          if (ctrl.signal.aborted) return;
          acc += chunk;
          setStreamed(acc);
        }
        if (!ctrl.signal.aborted) setPhase("ready");
      } catch {
        if (!ctrl.signal.aborted) setPhase("error");
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
        <span className="text-xs text-zinc-400">mock LLM · milestone 2</span>
      </header>
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
      <div className="max-h-40 overflow-y-auto rounded bg-zinc-50 p-2 text-sm text-zinc-800">
        {p.streamed || <span className="text-zinc-400">Thinking…</span>}
        {p.phase === "streaming" && <span className="ml-0.5 animate-pulse text-indigo-500">▍</span>}
      </div>
      <div className="flex justify-end gap-1">
        {p.phase === "streaming" && (
          <BubbleButton onClick={p.onCancel}>Cancel</BubbleButton>
        )}
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
