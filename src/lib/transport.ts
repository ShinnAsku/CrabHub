import { invoke } from "@tauri-apps/api/core";
import { isMockMode, mockInvoke } from "@/lib/tauri-commands-mock";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function webAuthHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem("crabhub-web-token");
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function webInvoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result> {
  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...webAuthHeaders() },
    body: JSON.stringify(args ?? {}),
  });
  if (response.status === 401) {
    try { sessionStorage.removeItem("crabhub-web-token"); } catch {}
    window.location.reload();
    throw new Error("Unauthorized: login required");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as Result;
}

export async function transportInvoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result> {
  if (isMockMode()) return mockInvoke<Result>(command, args);
  if (!isDesktop()) return webInvoke<Result>(command, args);
  return invoke<Result>(command, args);
}