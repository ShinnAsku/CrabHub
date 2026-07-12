import { defineConfig } from "@playwright/test";

/**
 * CrabHub Web E2E — runs the real `crabhub-server` binary against the built
 * frontend in `dist/`, with an isolated data dir wiped on every run.
 *
 * Prerequisites: `npm run build` (static assets). The Rust server is compiled
 * on demand by cargo (cached after the first run).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single server instance; auth lockout is global state
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4225",
    trace: "retain-on-failure",
    locale: "zh-CN",
  },
  webServer: {
    command: "node e2e/start-server.mjs",
    url: "http://127.0.0.1:4225/api/health",
    timeout: 300_000, // first run compiles the Rust server
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
