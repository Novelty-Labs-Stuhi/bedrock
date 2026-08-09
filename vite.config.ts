import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// no backend: the vault lives in localStorage, or in a real folder via the
// File System Access API (`showDirectoryPicker`).
// `base: "./"` keeps built asset URLs relative so the Electron shell can serve
// dist/ from the root of its custom app:// scheme.
export default defineConfig({
  base: "./",
  // Honour an assigned PORT so a second dev server can run alongside the first.
  server: { port: Number(process.env.PORT) || 5173 },
  // cytoscape alone is ~550 kB and ships in one chunk; splitting a local desktop
  // app buys nothing, so don't warn about it on every launch.
  build: {
    chunkSizeWarningLimit: 700,
    // Two pages, not one: a Claude session running in a terminal gets a window of its
    // own, and that window shares nothing with the vault's — no graph, no editor, no
    // vault at all. Keeping it a separate entry is what keeps it that light.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        terminal: fileURLToPath(new URL("terminal.html", import.meta.url)),
      },
    },
  },
});
