import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: false,
    // Web-mode development: `npm run dev` + `cargo run --bin crabhub-server`
    // lets the browser UI hit the local API with HMR.
    proxy: {
      "/api": "http://127.0.0.1:4224",
    },
  },
  // Strip `console.*` and `debugger` calls from production bundles so
  // diagnostic logging never ships to end users (it also keeps the bundle
  // smaller). Development builds keep them for in-app debugging.
  esbuild: {
    drop: mode === "production" ? ["console", "debugger"] : [],
  },
  build: {
    target: "esnext",
    minify: "esbuild",
  },
}));
