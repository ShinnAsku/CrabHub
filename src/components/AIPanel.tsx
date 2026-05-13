import { useState, useCallback, useRef, useEffect } from "react";
import {
  Send,
  Settings,
  ChevronDown,
  Bot,
  User,
  Copy,
  Play,
  FileCode,
  X,
  Loader2,
  Minus,
  Square,
  GripHorizontal,
  Lightbulb,
  Code,
  Database,
  BarChart2,
  Zap,
  Brain,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

// ===== AI Settings Types =====

interface AISettings {
  provider: "deepseek" | "qwen" | "ollama" | "openai";
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
};

const DEFAULT_MODELS: Record<string, string> = {
  deepseek: "deepseek-chat",
  qwen: "qwen-turbo",
  ollama: "llama3",
  openai: "gpt-4o-mini",
};

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  qwen: "Qwen",
  ollama: "Ollama",
  openai: "OpenAI",
};

// ===== Message Types =====

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sqlBlocks?: string[];
  streaming?: boolean;
}

// ===== AI Settings Dialog =====

function AISettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AISettings;
  onSave: (s: AISettings) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<AISettings>({ ...settings });

  const handleProviderChange = (provider: AISettings["provider"]) => {
    setForm({
      ...form,
      provider,
      endpoint: DEFAULT_ENDPOINTS[provider] ?? "",
      model: DEFAULT_MODELS[provider] ?? "",
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[380px] bg-background border border-border rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium text-foreground">{t('ai.settings')}</span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          {/* Provider */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('ai.provider')}</label>
            <div className="relative">
              <select
                value={form.provider}
                onChange={(e) =>
                  handleProviderChange(e.target.value as AISettings["provider"])
                }
                className="w-full appearance-none px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground cursor-pointer pr-8"
              >
                {Object.entries(PROVIDER_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={12}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
            </div>
          </div>

          {/* Endpoint */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('ai.endpoint')}</label>
            <input
              type="text"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('ai.apiKey')}</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={form.provider === "ollama" ? t('ai.noApiKey') : "sk-..."}
              className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
            />
          </div>

          {/* Model */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('ai.model')}</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground"
            />
          </div>

          {/* Temperature */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('ai.temperature', { value: form.temperature.toFixed(1) })}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={form.temperature}
              onChange={(e) =>
                setForm({ ...form, temperature: parseFloat(e.target.value) })
              }
              className="w-full accent-[hsl(var(--tab-active))]"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onSave(form);
              onClose();
            }}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Main AIPanel (Floating) =====

function AIPanel() {
  const { connections, activeConnectionId, addTab, tabs, activeTabId, updateTabContent, toggleAIPanel } =
    useAppStore();

  const [settings, setSettings] = useState<AISettings>(() => {
    try {
      const saved = localStorage.getItem("crabhub-ai-settings");
      if (saved) return JSON.parse(saved) as AISettings;
    } catch {
      // Ignore
    }
    return {
      provider: "deepseek" as const,
      endpoint: DEFAULT_ENDPOINTS["deepseek"] as string,
      apiKey: "",
      model: DEFAULT_MODELS["deepseek"] as string,
      temperature: 0.3,
    };
  });

  const [showSettings, setShowSettings] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content:
        t('ai.welcome'),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem("crabhub-ai-settings", JSON.stringify(settings));
  }, [settings]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Build system prompt with database context
  const buildSystemPrompt = useCallback(() => {
    const activeConnection = connections.find(
      (c) => c.id === activeConnectionId
    );

    let prompt = t('ai.systemPrompt');

    if (activeConnection) {
      prompt += `\n\n${t('ai.currentConnection')}${activeConnection.name} (${activeConnection.type})`;
      prompt += `\n${t('ai.database')}${activeConnection.database}`;

      // Add table info if available
      const { schemaData } = useAppStore.getState();
      const schema = schemaData[activeConnection.id];
      if (schema && schema.length > 0) {
        prompt += `\n\n${t('ai.dbStructure')}`;
        const describeNode = (node: typeof schema[0], indent: string = "") => {
          let desc = `${indent}${node.type}: ${node.name}`;
          if (node.children) {
            for (const child of node.children) {
              if (child.type === "function") {
                desc += `\n${indent}  - ${child.name}`;
              } else {
                desc += `\n${describeNode(child, indent + "  ")}`;
              }
            }
          }
          return desc;
        };
        for (const node of schema) {
          prompt += `\n${describeNode(node)}`;
        }
      }
    }

    prompt += `\n\n${t('ai.languageInstruction')}`;
    return prompt;
  }, [connections, activeConnectionId]);

  // Extract SQL blocks from markdown
  const extractSqlBlocks = (text: string): string[] => {
    const regex = /```sql\n([\s\S]*?)```/g;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      blocks.push((match[1] ?? "").trim());
    }
    return blocks;
  };

  // Call AI API with streaming
  const callAI = useCallback(
    async (userMessage: string) => {
      if (isStreaming) return;

      setIsStreaming(true);
      const abortController = new AbortController();
      abortRef.current = abortController;

      // Add user message
      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        content: userMessage,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add placeholder assistant message
      const assistantId = (Date.now() + 1).toString();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          streaming: true,
          sqlBlocks: [],
        },
      ]);

      try {
        const systemPrompt = buildSystemPrompt();
        const apiMessages = [
          ...messages
            .filter((m) => !m.streaming)
            .map((m) => ({
              role: m.role,
              content: m.content,
            })),
          { role: "user" as const, content: userMessage },
        ];

        const response = await fetch(`${settings.endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(settings.apiKey
              ? { Authorization: `Bearer ${settings.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: settings.model,
            messages: [
              { role: "system", content: systemPrompt },
              ...apiMessages,
            ],
            temperature: settings.temperature,
            stream: true,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => t('ai.unknownError'));
          throw new Error(
            `${t('ai.apiError')}${response.status}): ${errorText.slice(0, 200)}`
          );
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error(t('ai.streamError'));

        const decoder = new TextDecoder();
        let fullContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          content: fullContent,
                          sqlBlocks: extractSqlBlocks(fullContent),
                        }
                      : m
                  )
                );
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Finalize message
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  content: fullContent,
                  sqlBlocks: extractSqlBlocks(fullContent),
                }
              : m
          )
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, content: t('ai.cancelled') }
                : m
            )
          );
        } else {
          const errorMsg =
            err instanceof Error ? err.message : (typeof err === 'string' ? err : t('ai.callFailed'));
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    streaming: false,
                    content: `${t('ai.errorPrefix')}${errorMsg}\n\n${t('ai.errorHint')}`,
                  }
                : m
            )
          );
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages, settings, buildSystemPrompt]
  );

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    const msg = input.trim();
    setInput("");
    callAI(msg);
  }, [input, isStreaming, callAI]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleCopySQL = useCallback((sql: string) => {
    navigator.clipboard.writeText(sql).catch(() => {
      const textarea = document.createElement("textarea");
      textarea.value = sql;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    });
  }, []);

  const handleInsertToEditor = useCallback(
    (sql: string) => {
      if (activeTabId) {
        const currentTab = tabs.find((t) => t.id === activeTabId);
        const newContent = currentTab ? currentTab.content + "\n" + sql : sql;
        updateTabContent(activeTabId, newContent);
      } else {
        addTab({
          title: t('ai.queryTitle'),
          titleKey: 'ai.queryTitle',
          type: "query",
          content: sql,

        });
      }
    },
    [activeTabId, tabs, addTab, updateTabContent]
  );

  const handleExecuteSQL = useCallback(
    (sql: string) => {
      // Insert into current editor tab (or create one), then dispatch execute event
      if (activeTabId) {
        const currentTab = tabs.find((t) => t.id === activeTabId);
        const newContent = currentTab ? currentTab.content + "\n" + sql : sql;
        updateTabContent(activeTabId, newContent);
      } else {
        addTab({
          title: t('tab.query') + ' 1',
          titleKey: 'tab.query',
          titleNum: 1,
          type: "query",
          content: sql,
        });
      }
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("crabhub:execute-query"));
      }, 100);
    },
    [activeTabId, tabs, addTab, updateTabContent]
  );

  // Simple markdown-like rendering
  const renderContent = (content: string) => {
    const parts = content.split(/(```sql\n[\s\S]*?```)/g);
    return parts.map((part, i) => {
      if (part.startsWith("```sql")) {
        const sql = part.replace(/```sql\n/, "").replace(/```$/, "").trim();
        return (
          <div key={i} className="my-1.5">
            <pre className="bg-muted/80 rounded p-2 text-[11px] font-mono overflow-x-auto text-foreground border border-border/50">
              {sql}
            </pre>
            <div className="flex items-center gap-1 mt-1">
              <button
                onClick={() => handleCopySQL(sql)}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Copy size={10} />
                {t('ai.copySql')}
              </button>
              <button
                onClick={() => handleExecuteSQL(sql)}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Play size={10} />
                {t('ai.runSql')}
              </button>
              <button
                onClick={() => handleInsertToEditor(sql)}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <FileCode size={10} />
                {t('ai.insertEditor')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <span key={i} className="whitespace-pre-wrap">
          {part}
        </span>
      );
    });
  };

  return (
    <div
      className="ai-panel fixed z-30 flex flex-col bg-background border-l border-border shadow-xl"
      style={{
        right: 0,
        top: "36px", // below toolbar
        bottom: "24px", // above status bar
        width: "380px",
        borderRadius: "6px 0 0 6px",
      }}
    >
      {/* Drag Handle + Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 cursor-move select-none"
        onMouseDown={(e) => {
          // Allow dragging the floating panel (basic implementation)
          e.preventDefault();
        }}
      >
        <div className="flex items-center gap-1.5">
          <GripHorizontal size={12} className="text-muted-foreground/50" />
          <Bot size={13} className="text-[hsl(var(--tab-active))]" />
          <span className="text-xs font-medium text-foreground">
            {t('ai.title')}
          </span>
          <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
            {PROVIDER_LABELS[settings.provider]}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSettings(true)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={t('ai.settings')}
          >
            <Settings size={12} />
          </button>
          <button
            onClick={() => setMinimized(!minimized)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={minimized ? t('ai.expand') : t('ai.minimize')}
          >
            {minimized ? <Square size={10} /> : <Minus size={12} />}
          </button>
          <button
            onClick={toggleAIPanel}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={t('common.close')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content (hidden when minimized) */}
      {!minimized && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2 ${
                  msg.role === "user" ? "flex-row-reverse" : "flex-row"
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 ${
                    msg.role === "user"
                      ? "bg-accent text-accent-foreground"
                      : "bg-[hsl(var(--tab-active))] text-white"
                  }`}
                >
                  {msg.role === "user" ? (
                    <User size={11} />
                  ) : (
                    <Bot size={11} />
                  )}
                </div>
                {/* Content */}
                <div
                  className={`text-xs leading-relaxed px-2.5 py-1.5 rounded-lg max-w-[85%] ${
                    msg.role === "user"
                      ? "bg-accent text-accent-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {msg.streaming && !msg.content ? (
                    <div className="flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin text-muted-foreground" />
                      <span className="text-muted-foreground">{t('ai.thinking')}</span>
                    </div>
                  ) : (
                    renderContent(msg.content)
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Actions */}
          <div className="border-t border-border px-3 py-2 shrink-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setInput("帮我写一个查询用户表的SQL语句")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Code size={10} />
                <span>{t('ai.writeSql')}</span>
              </button>
              <button
                onClick={() => setInput("帮我分析这个SQL的性能: ")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Zap size={10} />
                <span>{t('ai.analyzePerformance')}</span>
              </button>
              <button
                onClick={() => setInput("帮我根据需求设计表结构")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Database size={10} />
                <span>{t('ai.designTable')}</span>
              </button>
              <button
                onClick={() => setInput("帮我分析查询结果")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <BarChart2 size={10} />
                <span>{t('ai.analyzeData')}</span>
              </button>
              <button
                onClick={() => setInput("帮我解释这个SQL语句")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Brain size={10} />
                <span>{t('ai.explainSql')}</span>
              </button>
              <button
                onClick={() => setInput("帮我优化这个SQL: ")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <Lightbulb size={10} />
                <span>{t('ai.optimizeSql')}</span>
              </button>
            </div>
          </div>

          {/* Input Area */}
          <div className="border-t border-border p-2 shrink-0">
            <div className="flex items-end gap-1.5 bg-muted rounded-lg p-1.5">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('ai.inputPlaceholder')}
                rows={1}
                className="ai-input flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none resize-none min-h-[20px] max-h-[80px]"
                style={{ lineHeight: "20px" }}
              />
              {isStreaming ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="p-1 rounded text-destructive hover:bg-accent transition-colors shrink-0"
                  title={t('ai.stopGenerate')}
                >
                  <X size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Settings Dialog */}
      {showSettings && (
        <AISettingsDialog
          settings={settings}
          onSave={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default AIPanel;
