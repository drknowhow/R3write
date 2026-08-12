import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
      // Multi-page build: each window loads its own HTML + bundle. Vite
      // tree-shakes from each entry, so the popup ships without the main
      // window's SettingsDialog/HistoryList tree, and vice versa. Shared
      // code (LLM clients, settings, theme, primitives) lands in the
      // common chunks below.
      input: {
        main: resolve(__dirname, "index.html"),
        "quick-edit": resolve(__dirname, "quick-edit.html"),
        "autocorrect-bubble": resolve(__dirname, "autocorrect-bubble.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
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
