import { defineConfig } from "vite";
import { pdfAssets } from "./scripts/pdfjs-vite.mjs";

export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [pdfAssets()],
  optimizeDeps: { exclude: ["pdfjs-dist"] },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    port: 1420,
  },
});
