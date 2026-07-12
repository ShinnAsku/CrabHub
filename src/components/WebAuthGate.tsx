import { useEffect, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";

/**
 * Web-mode auth gate (DBX-style).
 *
 * Probes GET /api/auth/check on mount:
 *  - Tauri desktop / mock mode  → renders children immediately (no auth).
 *  - authenticated              → renders children.
 *  - setupRequired              → first-run "set password" form.
 *  - required, not logged in    → login form.
 *
 * Tokens live in sessionStorage; api layer sends them as Bearer headers.
 */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type AuthState = "checking" | "login" | "setup" | "ready";

function saveToken(token: string) {
  try { sessionStorage.setItem("crabhub-web-token", token); } catch { /* ignore */ }
}

function getToken(): string | null {
  try { return sessionStorage.getItem("crabhub-web-token"); } catch { return null; }
}

export default function WebAuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(isTauri ? "ready" : "checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isTauri) return;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch("/api/auth/check", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = await res.json();
        if (s.authenticated) setState("ready");
        else if (s.setupRequired) setState("setup");
        else setState("login");
      } catch {
        // API unreachable (e.g. pure static preview) — let the app render;
        // individual calls will surface their own errors.
        setState("ready");
      }
    })();
  }, []);

  const submit = async (mode: "login" | "setup") => {
    setError(null);
    if (mode === "setup") {
      if (password.length < 8) { setError(t("webauth.tooShort")); return; }
      if (password !== confirm) { setError(t("webauth.mismatch")); return; }
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      saveToken(body.token ?? "");
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "ready") return <>{children}</>;

  if (state === "checking") {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        {t("webauth.checking")}
      </div>
    );
  }

  const isSetup = state === "setup";
  return (
    <div className="relative h-screen flex items-center justify-center bg-background overflow-hidden">
      {/* Soft brand glow — matches the welcome screen treatment */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(560px 300px at 50% 42%, hsl(var(--primary) / 0.08), transparent 70%)" }}
      />
      <form
        className="popover-panel relative w-80 space-y-4 p-6 rounded-2xl border border-border/70 bg-card"
        onSubmit={(e) => { e.preventDefault(); void submit(isSetup ? "setup" : "login"); }}
      >
        <div className="flex items-center gap-2">
          <img src="/crab.svg" alt="" className="w-8 h-8" onError={(e) => (e.currentTarget.style.display = "none")} />
          <h1 className="text-lg font-semibold text-foreground">CrabHub</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          {isSetup ? t("webauth.setupHint") : t("webauth.loginHint")}
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("webauth.password")}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
        />
        {isSetup && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t("webauth.confirmPassword")}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
          />
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground
                     shadow-[0_2px_12px_-2px_hsl(var(--primary)/0.5)] hover:brightness-110
                     active:scale-[0.99] transition-all duration-150 disabled:opacity-50"
        >
          {isSetup ? t("webauth.setPassword") : t("webauth.login")}
        </button>
      </form>
    </div>
  );
}
