import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  Play,
  AlignLeft,
  Loader2,
  ChevronRight,
  Upload,
  FileText,
  Database,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Code2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useAppStore, type QueryResult } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { executeQuery, executeSql } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, exportToSQL, downloadFile, importFromCSV, importFromJSON } from "@/lib/export";
import ERDiagram from "./ERDiagram";
import TableDesigner from "./TableDesigner";
import QueryAnalyzer from "./QueryAnalyzer";

type ResultTab = "results" | "messages" | "plan";

// Configure Monaco Editor to use local files instead of CDN
loader.config({ monaco });

function isSelectQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("SHOW") ||
    trimmed.startsWith("DESCRIBE") ||
    trimmed.startsWith("DESC ") ||
    trimmed.startsWith("EXPLAIN") ||
    trimmed.startsWith("WITH")
  );
}

function EditorPanel() {
  const { tabs, activeTabId, connections, addTab } = useAppStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Handle different tab types
  if (!activeTab) {
    return <WelcomeScreen />;
  }

  if (activeTab.type === "er_diagram") {
    return (
      <div className="flex-1 min-h-0">
        <ERDiagram
          embedded={true}
          connectionId={activeTab.connectionId || ""}
        />
      </div>
    );
  }

  if (activeTab.type === "schema_diff") {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {t('layout.schemaDiffHint')}
      </div>
    );
  }

  if (activeTab.type === "table_designer") {
    return (
      <div className="flex-1 min-h-0">
        <TableDesigner
          connectionId={activeTab.connectionId || ""}
        />
      </div>
    );
  }

  if (activeTab.type === "query_analyzer") {
    const activeConnection = connections.find((c) => c.id === activeTab.connectionId);
    return (
      <div className="flex-1 min-h-0">
        <QueryAnalyzer
          connectionId={activeTab.connectionId || null}
          dbType={activeConnection?.type || "postgresql"}
          onInsertQuery={(sql) => {
            // Create a new query tab with the SQL
            const queryCount = tabs.filter((t) => t.type === "query").length + 1;
            addTab({
              title: `${t('tab.query')} ${queryCount}`,
              type: "query",
              content: sql,
              connectionId: activeTab.connectionId,
              modified: false,
            });
          }}
        />
      </div>
    );
  }

  // Default: query tab
  return <QueryEditor />;
}

// ===== Query Editor (with result panel) =====

function QueryEditor() {
  const {
    tabs,
    activeTabId,
    queryResults,
    isExecuting,
    theme,
    activeConnectionId,
    connections,
    updateTabContent,
    setQueryResult,
    setIsExecuting,
    addQueryHistory,
    transactionActive,
    setTransactionActive,
    resultPanelOpen,
    toggleResultPanel,
    toggleSnippetPanel,
    addSlowQuery,
    slowQueryThreshold,
  } = useAppStore();

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("results");
  const [messages, setMessages] = useState<string[]>([]);
  const [executionTime, setExecutionTime] = useState<number | null>(null);
  const [importPreview, setImportPreview] = useState<{ columns: string[]; rows: any[] } | null>(null);
  const [importTableName, setImportTableName] = useState("imported_data");

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const result = activeTabId ? queryResults[activeTabId] : undefined;
  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const isTxActive = activeConnectionId ? !!transactionActive[activeConnectionId] : false;

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  }, []);

  // Listen for custom events from Toolbar
  useEffect(() => {
    const handleExportEvent = (e: Event) => {
      const { format } = (e as CustomEvent).detail;
      handleExport(format);
    };
    const handleImportEvent = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      handleImport(type);
    };
    const handleExecuteEvent = () => {
      handleExecute();
    };

    window.addEventListener("opendb:export", handleExportEvent);
    window.addEventListener("opendb:import", handleImportEvent);
    window.addEventListener("opendb:execute-query", handleExecuteEvent);

    return () => {
      window.removeEventListener("opendb:export", handleExportEvent);
      window.removeEventListener("opendb:import", handleImportEvent);
      window.removeEventListener("opendb:execute-query", handleExecuteEvent);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeConnectionId, result]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        updateTabContent(activeTabId, value);
      }
    },
    [activeTabId, updateTabContent]
  );

  const handleExecute = useCallback(async () => {
    if (!activeTabId || !activeConnectionId || !editorRef.current) return;

    const sql = editorRef.current.getValue().trim();
    if (!sql) return;

    setIsExecuting(true);
    setMessages([]);
    setExecutionTime(null);
    setImportPreview(null);

    const startTime = performance.now();

    try {
      if (isSelectQuery(sql)) {
        const queryResult: QueryResult = await executeQuery(activeConnectionId, sql);
        const elapsed = performance.now() - startTime;
        setQueryResult(activeTabId, queryResult);
        setExecutionTime(elapsed);
        setMessages([t('editor.querySuccess', { rows: String(queryResult.rowCount), ms: elapsed.toFixed(0) })]);
        setResultTab("results");

        addQueryHistory({
          connectionId: activeConnectionId,
          connectionName: activeConnection?.name || t('common.unknown'),
          sql,
          executionTime: elapsed,
          timestamp: Date.now(),
          success: true,
        });

        // Check slow query threshold
        if (elapsed >= slowQueryThreshold) {
          addSlowQuery({
            sql,
            executionTime: elapsed,
            timestamp: Date.now(),
            connectionName: activeConnection?.name || t('common.unknown'),
            connectionId: activeConnectionId,
          });
        }
      } else {
        const execResult = await executeSql(activeConnectionId, sql);
        const elapsed = performance.now() - startTime;
        setExecutionTime(elapsed);
        setMessages([t('editor.executeSuccess', { message: execResult.message, ms: elapsed.toFixed(0) })]);
        setQueryResult(activeTabId, {
          columns: [],
          rows: [],
          rowCount: 0,
          executionTime: elapsed,
        });
        setResultTab("messages");

        addQueryHistory({
          connectionId: activeConnectionId,
          connectionName: activeConnection?.name || t('common.unknown'),
          sql,
          executionTime: elapsed,
          timestamp: Date.now(),
          success: true,
        });

        // Check slow query threshold
        if (elapsed >= slowQueryThreshold) {
          addSlowQuery({
            sql,
            executionTime: elapsed,
            timestamp: Date.now(),
            connectionName: activeConnection?.name || t('common.unknown'),
            connectionId: activeConnectionId,
          });
        }
      }
    } catch (err) {
      const elapsed = performance.now() - startTime;
      setExecutionTime(elapsed);
      const errorMsg = err instanceof Error ? err.message : t('editor.executeFailed');
      setMessages([t('editor.errorPrefix', { error: errorMsg })]);
      setQueryResult(activeTabId, {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: elapsed,
      });
      setResultTab("messages");

      addQueryHistory({
        connectionId: activeConnectionId,
        connectionName: activeConnection?.name || t('common.unknown'),
        sql,
        executionTime: elapsed,
        timestamp: Date.now(),
        success: false,
      });
    } finally {
      setIsExecuting(false);
    }
  }, [activeTabId, activeConnectionId, activeConnection, setQueryResult, setIsExecuting, addQueryHistory]);

  // Bind Ctrl+Enter whenever activeTabId or activeConnectionId changes
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const disposable = editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => handleExecute()
    );
    return () => disposable?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeConnectionId, handleExecute]);

  const handleFormat = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.getAction("editor.action.formatDocument")?.run();
  }, []);

  const handleExport = useCallback(
    (format: "csv" | "json" | "sql") => {
      if (!result || result.columns.length === 0) return;
      let content = "";
      let filename = "";
      let mimeType = "";

      switch (format) {
        case "csv":
          content = exportToCSV(result.columns, result.rows);
          filename = "query_result.csv";
          mimeType = "text/csv";
          break;
        case "json":
          content = exportToJSON(result.columns, result.rows);
          filename = "query_result.json";
          mimeType = "application/json";
          break;
        case "sql":
          content = exportToSQL(result.columns, result.rows, "query_result");
          filename = "query_result.sql";
          mimeType = "text/plain";
          break;
      }

      downloadFile(content, filename, mimeType);
    },
    [result]
  );

  const handleImport = useCallback(async (type: "csv" | "json") => {
    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    let file: File | null = null;

    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: type === "csv"
            ? [{ name: "CSV", extensions: ["csv", "tsv"] }]
            : [{ name: "JSON", extensions: ["json"] }],
        });
        if (!selected) return;
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const text = await readTextFile(selected as string);
        file = new File([text], (selected as string).split(/[/\\]/).pop() || `data.${type}`, { type });
      } catch {
        return;
      }
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = type === "csv" ? ".csv,.tsv" : ".json";
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        if (target.files && target.files[0]) {
          processImport(target.files[0], type);
        }
      };
      input.click();
      return;
    }

    if (file) {
      processImport(file, type);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processImport = useCallback(async (file: File, type: "csv" | "json") => {
    try {
      const data = type === "csv" ? await importFromCSV(file) : await importFromJSON(file);
      setImportPreview(data);
      setResultTab("results");
      setMessages([t('editor.importPreview', { rows: String(data.rows.length), cols: String(data.columns.length) })]);
    } catch (err) {
      setMessages([t('editor.importFailed', { error: err instanceof Error ? err.message : t('common.unknownError') })]);
      setResultTab("messages");
    }
  }, []);

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview || !activeConnectionId || !activeTabId) return;

    const { columns, rows } = importPreview;
    const colDefs = columns.map((c) => `"${c}"`).join(", ");
    const sql = `CREATE TABLE IF NOT EXISTS "${importTableName}" (${colDefs});\n`;

    const insertStatements = rows.map((row) => {
      const vals = columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return "NULL";
        if (typeof val === "number") return String(val);
        if (typeof val === "boolean") return val ? "1" : "0";
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      return `INSERT INTO "${importTableName}" (${colDefs}) VALUES (${vals.join(", ")});`;
    });

    const fullSql = sql + insertStatements.join("\n");

    setIsExecuting(true);
    try {
      await executeSql(activeConnectionId, fullSql);
      setMessages([t('editor.importSuccess', { rows: String(rows.length), table: importTableName })]);
      setImportPreview(null);
      setResultTab("messages");
    } catch (err) {
      setMessages([t('editor.importFailed', { error: err instanceof Error ? err.message : t('common.unknownError') })]);
      setResultTab("messages");
    } finally {
      setIsExecuting(false);
    }
  }, [importPreview, activeConnectionId, activeTabId, importTableName, setIsExecuting]);

  const handleTransaction = useCallback(async (action: "begin" | "commit" | "rollback") => {
    if (!activeConnectionId) return;

    const sqlMap = { begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" };
    const labelMap: Record<string, string> = {
      begin: t('editor.beginTransactionLabel'),
      commit: t('editor.commitTransactionLabel'),
      rollback: t('editor.rollbackTransactionLabel'),
    };

    try {
      await executeSql(activeConnectionId, sqlMap[action]);
      setTransactionActive(activeConnectionId, action === "begin");
      setMessages([t('editor.transactionSuccess', { action: labelMap[action] || action })]);
      setResultTab("messages");
    } catch (err) {
      setMessages([t('editor.transactionFailed') + `: ${err instanceof Error ? err.message : t('common.unknownError')}`]);
      setResultTab("messages");
    }
  }, [activeConnectionId, setTransactionActive]);

  if (!activeTab) {
    return <WelcomeScreen />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Editor Area */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Editor Toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('editor.sqlEditor')}</span>
            {activeConnection && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {activeConnection.name}
              </span>
            )}
            {isTxActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 animate-pulse">
                {t('common.transactionActive')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {executionTime !== null && (
              <span className="text-[10px] text-muted-foreground mr-1">
                {executionTime.toFixed(0)} ms
              </span>
            )}
            {/* Transaction buttons */}
            {activeConnectionId && (
              <>
                <button
                  onClick={() => handleTransaction("begin")}
                  disabled={isTxActive || isExecuting}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                  title={t('editor.beginTransaction')}
                >
                  <Database size={11} />
                  {t('editor.beginTransaction')}
                </button>
                <button
                  onClick={() => handleTransaction("commit")}
                  disabled={!isTxActive || isExecuting}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                  title={t('editor.commitTransaction')}
                >
                  <CheckCircle2 size={11} />
                  {t('editor.commit')}
                </button>
                <button
                  onClick={() => handleTransaction("rollback")}
                  disabled={!isTxActive || isExecuting}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                  title={t('editor.rollbackTransaction')}
                >
                  <RotateCcw size={11} />
                  {t('editor.rollback')}
                </button>
              </>
            )}
            <button
              onClick={handleFormat}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
              title={t('editor.formatSql')}
            >
              <AlignLeft size={12} />
              {t('editor.format')}
            </button>
            <button
              onClick={toggleSnippetPanel}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
              title={t('editor.snippet')}
            >
              <Code2 size={12} />
              {t('editor.snippetShort')}
            </button>
            <button
              onClick={handleExecute}
              disabled={isExecuting || !activeConnectionId}
              className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-[hsl(var(--tab-active))] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-40"
              title={t('editor.executeQuery')}
            >
              {isExecuting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              {t('common.execute')}
            </button>
          </div>
        </div>

        {/* Monaco Editor */}
        <div className="flex-1 min-h-0">
          <Editor
            key={activeTab.id}
            height="100%"
            language="sql"
            theme={theme === "dark" ? "vs-dark" : "vs"}
            value={activeTab.content || ""}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 20,
              padding: { top: 8, bottom: 8 },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: 2,
              renderLineHighlight: "line",
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              folding: true,
              lineNumbers: "on",
              glyphMargin: false,
              contextmenu: true,
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
              },
            }}
          />
        </div>
      </div>

      {/* Result Panel Toggle Button */}
      <button
        onClick={toggleResultPanel}
        className="flex items-center justify-center h-5 border-t border-border hover:bg-muted transition-colors shrink-0"
        title={resultPanelOpen ? t('editor.collapseResult') : t('editor.expandResult')}
      >
        {resultPanelOpen ? (
          <ChevronDown size={12} className="text-muted-foreground" />
        ) : (
          <ChevronUp size={12} className="text-muted-foreground" />
        )}
      </button>

      {/* Result Panel (collapsible) */}
      {resultPanelOpen && (
        <div className="flex flex-col border-t border-border" style={{ height: "35%", minHeight: "100px" }}>
          {/* Result Tab Bar */}
          <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0">
            <div className="flex items-center gap-0">
              {(["results", "messages", "plan"] as ResultTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setResultTab(tab)}
                  className={`px-2.5 py-1 text-xs transition-colors ${
                    resultTab === tab
                      ? "text-foreground border-b-2 border-[hsl(var(--tab-active))]"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab === "results"
                    ? t('editor.resultCount', { suffix: result ? ` (${result.rowCount})` : "" }) + (importPreview ? ` (${importPreview.rows.length})` : "")
                    : tab === "messages"
                    ? t('editor.messages')
                    : t('editor.executionPlan')}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {/* Import buttons */}
              <button
                onClick={() => handleImport("csv")}
                disabled={isExecuting}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-40"
                title={t('toolbar.importCsv')}
              >
                <Upload size={10} />
                CSV
              </button>
              <button
                onClick={() => handleImport("json")}
                disabled={isExecuting}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-40"
                title={t('toolbar.importJson')}
              >
                <FileText size={10} />
                JSON
              </button>
              {resultTab === "results" && result && result.columns.length > 0 && (
                <>
                  <span className="text-border">|</span>
                  <button
                    onClick={() => handleExport("csv")}
                    className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                  >
                    CSV
                  </button>
                  <button
                    onClick={() => handleExport("json")}
                    className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                  >
                    JSON
                  </button>
                  <button
                    onClick={() => handleExport("sql")}
                    className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                  >
                    SQL
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Import preview bar */}
          {importPreview && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
              <span className="text-[10px] text-muted-foreground">{t('editor.importTargetTable')}</span>
              <input
                type="text"
                value={importTableName}
                onChange={(e) => setImportTableName(e.target.value)}
                className="px-2 py-0.5 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground w-40"
              />
              <button
                onClick={handleConfirmImport}
                disabled={isExecuting || !importTableName.trim()}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-[hsl(var(--tab-active))] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <CheckCircle2 size={10} />
                {t('editor.confirmImport')}
              </button>
              <button
                onClick={() => setImportPreview(null)}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <XCircle size={10} />
                {t('common.cancel')}
              </button>
            </div>
          )}

          {/* Result Content */}
          <div className="flex-1 min-h-0 overflow-auto">
            {resultTab === "results" && (
              <ResultTable result={result} importPreview={importPreview} />
            )}
            {resultTab === "messages" && (
              <div className="p-3 space-y-1">
                {messages.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('editor.noMessages')}</p>
                ) : (
                  messages.map((msg, i) => (
                    <p
                      key={i}
                      className={`text-xs ${
                        msg.startsWith(t('common.error')) || msg.startsWith(t('editor.importFailedShort')) || msg.startsWith(t('editor.transactionFailed'))
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {msg}
                    </p>
                  ))
                )}
              </div>
            )}
            {resultTab === "plan" && (
              <EmbeddedExplainPanel
                connectionId={activeConnectionId}
                dbType={activeConnection?.type || "postgresql"}
                currentSql={activeTab?.content || ""}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Embedded Explain Panel (for the "plan" tab in result panel) =====

function EmbeddedExplainPanel({
  connectionId,
  dbType,
  currentSql,
}: {
  connectionId: string | null;
  dbType: string;
  currentSql: string;
}) {
  return (
    <div className="h-full">
      <QueryAnalyzer
        connectionId={connectionId}
        dbType={dbType}
        initialSql={currentSql}
        embedded={true}
      />
    </div>
  );
}

// ===== Result Table =====

function ResultTable({ result, importPreview }: { result?: QueryResult; importPreview?: { columns: string[]; rows: any[] } | null }) {
  if (importPreview) {
    const { columns, rows } = importPreview;
    return (
      <div className="overflow-auto h-full">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted">
              {columns.map((col) => (
                <th
                  key={col}
                  className="px-3 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap border-b border-border"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-b border-border/50 hover:bg-muted/50 transition-colors"
              >
                {columns.map((col) => (
                  <td
                    key={col}
                    className="px-3 py-1 whitespace-nowrap max-w-[300px] truncate"
                  >
                    <span className="text-foreground">
                      {row[col] === null || row[col] === undefined ? "NULL" : String(row[col])}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 100 && (
          <div className="flex items-center justify-center py-2 text-[10px] text-muted-foreground">
            {t('editor.showingRows', { total: String(rows.length) })}
          </div>
        )}
      </div>
    );
  }

  if (!result || result.columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {t('editor.clickToExecute')}
      </div>
    );
  }

  const { columns, rows } = result;

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted">
            {columns.map((col) => (
              <th
                key={col.name}
                className="px-3 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap border-b border-border"
              >
                <div className="flex items-center gap-1">
                  <span>{col.name}</span>
                  {col.isPrimaryKey && (
                    <span className="text-[9px] px-0.5 rounded bg-[hsl(var(--tab-active))]/20 text-[hsl(var(--tab-active))]">
                      PK
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-normal text-muted-foreground/60 block">
                  {col.dataType}
                  {col.nullable ? "" : " NOT NULL"}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className="border-b border-border/50 hover:bg-muted/50 transition-colors"
            >
              {columns.map((col) => (
                <td
                  key={col.name}
                  className="px-3 py-1 whitespace-nowrap max-w-[300px] truncate"
                >
                  <span className={row[col.name] === null ? "text-muted-foreground/40 italic" : "text-foreground"}>
                    {row[col.name] === null ? "NULL" : String(row[col.name])}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          {t('editor.noResults')}
        </div>
      )}
    </div>
  );
}

// ===== Welcome Screen =====

function WelcomeScreen() {
  const { addTab, toggleAIPanel } = useAppStore();

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        {/* Butterfly Logo */}
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-20"
        >
          <path d="M12 12 C8 8, 2 6, 3 10 C4 14, 10 14, 12 12" />
          <path d="M12 12 C8 16, 2 18, 3 14 C4 10, 10 10, 12 12" />
          <path d="M12 12 C16 8, 22 6, 21 10 C20 14, 14 14, 12 12" />
          <path d="M12 12 C16 16, 22 18, 21 14 C20 10, 14 10, 12 12" />
          <line x1="12" y1="6" x2="12" y2="18" />
          <path d="M12 6 C11 4, 9 3, 8 2" />
          <path d="M12 6 C13 4, 15 3, 16 2" />
        </svg>
        <h2 className="text-base font-medium text-foreground/60">openDB</h2>
        <p className="text-xs text-muted-foreground/60 text-center max-w-[240px]">
          {t('welcome.description')}{" "}
          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Ctrl+N</kbd>{" "}
          {t('welcome.newQuery')}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() =>
              addTab({
                title: t('welcome.query1'),
                type: "query",
                content: "",
                modified: false,
              })
            }
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-muted rounded transition-colors text-foreground"
          >
            <ChevronRight size={13} />
            {t('welcome.newQueryBtn')}
          </button>
          <button
            onClick={toggleAIPanel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-muted rounded transition-colors text-foreground"
          >
            <Code2 size={13} />
            {t('welcome.aiAssistant')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EditorPanel;
