import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: "apps/desktop",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "apps/desktop/index.html"),
        floating: resolve(__dirname, "apps/desktop/floating.html"),
      },
    },
  },
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
});
