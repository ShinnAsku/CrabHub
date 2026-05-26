import { invoke } from "@tauri-apps/api/core";
import type { Message } from "@/stores/ai-store";

export interface AISettings {
  provider: "deepseek" | "qwen" | "ollama" | "openai";
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface OptimizationSuggestion {
  type: string;
  severity: string;
  message: string;
  suggestion?: string;
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  indexType: string;
}

export interface OptimizationResult {
  suggestions: OptimizationSuggestion[];
  indexSuggestions: IndexSuggestion[];
  rewrittenQuery?: string;
}

/**
 * Chat with AI assistant (streaming via events)
 */
export async function aiChatStream(
  settings: AISettings,
  messages: Message[],
  onChunk: (chunk: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<() => void> {
  // Listen for stream chunks
  const unlisten = await window.__TAURI__!.event.listen<string>(
    "ai-stream-chunk",
    (event: any) => {
      if (event.payload.done) {
        onComplete();
      } else {
        onChunk(event.payload);
      }
    }
  );

  try {
    await invoke("ai_chat_stream", {
      provider: settings.provider,
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    unlisten();
  }

  return unlisten;
}

/**
 * Analyze SQL query for optimization opportunities
 */
export async function analyzeSQL(
  sql: string,
  tableName?: string
): Promise<OptimizationResult> {
  return invoke("analyze_sql", {
    sql,
    tableName,
  });
}

/**
 * Format SQL query
 */
export async function formatSQL(sql: string): Promise<string> {
  return invoke("format_sql", {
    sql,
  });
}

// ---------------------------------------------------------------------------
// AI API-key keyring helpers
// ---------------------------------------------------------------------------

export type AIProvider = "deepseek" | "qwen" | "ollama" | "openai" | "custom";

/** Test the AI provider connection with a minimal ping message. */
export async function testAiConnection(
  provider: string,
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<string> {
  return invoke("test_ai_connection", { provider, endpoint, apiKey, model });
}

/** Persist the API key for `provider` in the OS keyring. Empty string deletes it. */
export async function setAiApiKey(provider: AIProvider, key: string): Promise<void> {
  return invoke("set_ai_api_key", { provider, key });
}

/** Read the API key for `provider` from the OS keyring. Returns "" if not set. */
export async function getAiApiKey(provider: AIProvider): Promise<string> {
  return invoke("get_ai_api_key", { provider });
}

/** Remove the API key for `provider` from the OS keyring. */
export async function deleteAiApiKey(provider: AIProvider): Promise<void> {
  return invoke("delete_ai_api_key", { provider });
}
