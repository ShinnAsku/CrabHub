/**
 * E2E web-server launcher.
 *
 * Wipes the isolated data directory (fresh password hash + empty connection
 * store on every run), then execs the CrabHub web server via cargo with the
 * test environment. Playwright polls /api/health until it is up.
 */
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "e2e", ".data");
const distDir = path.join(root, "dist");

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("dist/index.html not found — run `npm run build` before `npm run test:e2e`.");
  process.exit(1);
}

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const child = spawn(
  "cargo",
  ["run", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--quiet", "--bin", "crabhub-server"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      CRABHUB_WEB_PORT: "4225",
      CRABHUB_BIND: "127.0.0.1",
      CRABHUB_WEB_PASSWORD: "e2e-password-123",
      CRABHUB_MASTER_KEY: "e2e-master-key-16chars",
      CRABHUB_DATA_DIR: dataDir,
      CRABHUB_STATIC_DIR: distDir,
    },
  }
);

child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill());
}
