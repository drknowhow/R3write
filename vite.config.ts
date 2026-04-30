import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri uses a fixed dev port and disables HMR overlay for desktop UX.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@tiptap") || id.includes("prosemirror-")) return "tiptap";
            if (id.includes("/marked/") || id.includes("/dompurify/") || id.includes("/diff/"))
              return "markdown";
            if (id.includes("@radix-ui")) return "radix";
            if (id.includes("framer-motion") || id.includes("motion-")) return "motion";
            if (id.includes("lucide-react")) return "icons";
          }
        },
      },
    },
  },
});
