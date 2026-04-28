import React from "react";
import ReactDOM from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import "./index.css";

function App() {
  const editor = useEditor({
    extensions: [StarterKit],
    content:
      "<h1>R3write</h1><p>Select any text to bring up AI rewrite options. (BubbleMenu coming in milestone 2.)</p>",
  });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-700">R3write</h1>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
        <EditorContent editor={editor} className="tiptap" />
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
