import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Play,
  AlignLeft,
  Loader2,
  ChevronRight,
  Database,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Code2,
  Scissors,
  Copy,
  ClipboardPaste,
  MousePointerClick,
  TextCursorInput,
  Brain,
  Lightbulb,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { QueryResult, PagedQueryResult } from "@/types";
import { t } from "@/lib/i18n";
import { executeQuery, executeQueryPaged, executeSql, getTables, getSchemas, getColumns } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, exportToSQL, downloadFile, importFromCSV, importFromJSON } from "@/lib/export";
import { format as formatSQL } from "sql-formatter";
import ERDiagram from "./ERDiagram";
import TableDesigner from "./TableDesigner";
import QueryAnalyzer from "./QueryAnalyzer";
import NotebookView from "./notebook/NotebookView";
import VisualQueryBuilder from "./query-builder/VisualQueryBuilder";

// SQL keywords for autocompletion
const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "DATABASE", "SCHEMA",
  "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "FULL", "ON", "USING",
  "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS", "NULL",
  "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL",
  "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "CAST", "COALESCE",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ASC", "DESC", "NULLS", "FIRST", "LAST",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK", "DEFAULT",
  "CONSTRAINT", "NOT", "NULL", "AUTO_INCREMENT", "SERIAL", "BIGSERIAL",
  "INTEGER", "INT", "BIGINT", "SMALLINT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC",
  "VARCHAR", "CHAR", "TEXT", "BOOLEAN", "BOOL", "DATE", "TIME", "TIMESTAMP",
  "TIMESTAMPTZ", "JSON", "JSONB", "UUID", "BYTEA", "BLOB", "CLOB",
  "IF", "ELSE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "TRANSACTION",
  "GRANT", "REVOKE", "WITH", "RECURSIVE", "RETURNING", "EXPLAIN", "ANALYZE",
  "TRUNCATE", "CASCADE", "RESTRICT", "TRIGGER", "FUNCTION", "PROCEDURE",
  "EXECUTE", "REPLACE", "MERGE", "UPSERT", "CONFLICT", "DO", "NOTHING",
  "PARTITION", "OVER", "WINDOW", "ROW_NUMBER", "RANK", "DENSE_RANK",
  "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTH_VALUE", "NTILE",
  "FETCH", "NEXT", "ROWS", "ONLY", "PERCENT", "TOP", "PIVOT", "UNPIVOT",
  "SHOW", "DESCRIBE", "DESC", "USE", "RENAME", "TO", "ADD", "COLUMN",
  "MATERIALIZED", "REFRESH", "CONCURRENTLY", "LATERAL", "TABLESAMPLE",
  "GROUPING", "SETS", "CUBE", "ROLLUP", "FILTER", "WITHIN", "ARRAY",
];

type ResultTab = "results" | "messages";

// Configure Monaco Editor to use local files instead of CDN
loader.config({ monaco });

// Strip leading SQL comments (-- and /* */) to find the actual statement keyword
function stripLeadingComments(sql: string): string {
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && sql.charAt(i + 1) === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return '';
      i = nl + 1;
      continue;
    }
    if (ch === '/' && sql.charAt(i + 1) === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return '';
      i = end + 2;
      continue;
    }
    break;
  }
  return sql.substring(i);
}

function isSelectQuery(sql: string): boolean {
  const trimmed = stripLeadingComments(sql).trim().toUpperCase();
  return (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("SHOW") ||
    trimmed.startsWith("DESCRIBE") ||
    trimmed.startsWith("DESC ") ||
    trimmed.startsWith("EXPLAIN") ||
    trimmed.startsWith("WITH")
  );
}

// Only SELECT and WITH queries should get auto-LIMIT injection
// SHOW/DESCRIBE/EXPLAIN return small result sets, no need for pagination
function shouldAutoLimit(sql: string): boolean {
  const trimmed = stripLeadingComments(sql).trim().toUpperCase();
  return trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
}

const QUERY_PAGE_SIZE = 1000;

// Split SQL text into individual statements, respecting strings, comments, dollar-quotes, and BEGIN...END blocks
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const len = sql.length;
  let blockDepth = 0;

  // Check if current context is a block-creating statement (CREATE FUNCTION/PROCEDURE/TRIGGER, DO)
  function isBlockContext(): boolean {
    const stripped = current.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').toUpperCase().trim();
    return /\b(CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|TRIGGER))\b/.test(stripped) ||
           /^\s*DO\b/.test(stripped);
  }

  // Try to read a word (identifier/keyword) at position i
  function readWord(): string | null {
    const m = sql.substring(i).match(/^[a-zA-Z_]\w*/);
    return m ? m[0] : null;
  }

  while (i < len) {
    const ch = sql.charAt(i);

    // Single-line comment
    if (ch === '-' && sql.charAt(i + 1) === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { current += sql.substring(i); break; }
      current += sql.substring(i, nl + 1);
      i = nl + 1;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && sql.charAt(i + 1) === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { current += sql.substring(i); break; }
      current += sql.substring(i, end + 2);
      i = end + 2;
      continue;
    }

    // String literal (single quote)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql.charAt(j) === "'" && sql.charAt(j + 1) === "'") { j += 2; }
        else if (sql.charAt(j) === "'") { break; }
        else { j++; }
      }
      current += sql.substring(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted string (PostgreSQL)
    if (ch === '$') {
      const tagMatch = sql.substring(i).match(/^\$([a-zA-Z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          current += sql.substring(i, endIdx + tag.length);
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    // Word token - track BEGIN/END block nesting
    if (/[a-zA-Z_]/.test(ch)) {
      const word = readWord();
      if (word) {
        const upper = word.toUpperCase();
        current += word;
        i += word.length;

        if (upper === 'BEGIN') {
          if (blockDepth > 0 || isBlockContext()) {
            blockDepth++;
          }
          // else: standalone BEGIN (transaction) - don't track
        } else if (upper === 'END' && blockDepth > 0) {
          blockDepth--;
        }
        continue;
      }
    }

    // Semicolon - statement boundary only when not inside a BEGIN...END block
    if (ch === ';') {
      if (blockDepth > 0) {
        // Inside a block - keep the semicolon as part of the statement
        current += ch;
        i++;
        continue;
      }
      const stmt = current.trim();
      if (stmt) { statements.push(stmt); }
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  let lastStmt = current.trim();
  // Filter out standalone '/' (Oracle/GaussDB block terminator)
  if (lastStmt === '/') { lastStmt = ''; }
  if (lastStmt) { statements.push(lastStmt); }

  // Also filter out any standalone '/' statements in the array
  return statements.filter(s => s !== '/');
}

function EditorPanel() {
  const { tabs, activeTabId, connections, addTab, closeTab } = useAppStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Handle different tab types
  if (!activeTab) {
    return <WelcomeScreen />;
  }

  if (activeTab.type === "er") {
    return (
      <div className="flex-1 min-h-0">
        <ERDiagram
          embedded={true}
          connectionId={activeTab.connectionId || ""}
          schemaName={activeTab.schemaName}
        />
      </div>
    );
  }

  if (activeTab.type === "diff") {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {t('layout.schemaDiffHint')}
      </div>
    );
  }

  if (activeTab.type === "designer") {
    const editTable = activeTab.tableName
      ? { name: activeTab.tableName, schema: activeTab.schemaName }
      : undefined;
    return (
      <div className="flex-1 min-h-0">
        <TableDesigner
          connectionId={activeTab.connectionId || ""}
          editTable={editTable}
        />
      </div>
    );
  }

  if (activeTab.type === "analyzer") {
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
              
            });
          }}
        />
      </div>
    );
  }

  if (activeTab.type === "notebook") {
    return (
      <div className="flex-1 min-h-0">
        <NotebookView
          connectionId={activeTab.connectionId || ""}
          onClose={() => activeTabId && closeTab(activeTabId)}
        />
      </div>
    );
  }

  if (activeTab.type === "query-builder") {
    return (
      <div className="flex-1 min-h-0">
        <VisualQueryBuilder
          connectionId={activeTab.connectionId || ""}
          onClose={() => activeTabId && closeTab(activeTabId)}
          onQueryGenerated={(sql) => {
            // Create a new query tab with the generated SQL
            const queryCount = tabs.filter((t) => t.type === "query").length + 1;
            const newTabId = addTab({
              title: `${t('tab.query')} ${queryCount}`,
              type: "query",
              content: sql,
              connectionId: activeTab.connectionId,
            });
            // Activate the new tab
            useAppStore.getState().setActiveTab(newTabId);
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [multiResults, setMultiResults] = useState<QueryResult[]>([]);
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  // Scroll-to-load-more state for query results
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreState, setLoadMoreState] = useState<Record<number, { hasMore: boolean; currentOffset: number; originalSql: string }>>({});

  // Dynamic completion data: schema names, table names, column names
  const dbSchemasRef = useRef<string[]>([]);
  const dbTablesRef = useRef<{ name: string; schema?: string }[]>([]);
  const dbColumnsRef = useRef<Record<string, string[]>>({});

  // Connection / Database selector state
  const [selectedConnId, setSelectedConnId] = useState<string | null>(activeConnectionId);
  const [databaseList, setDatabaseList] = useState<string[]>([]);
  const [selectedDatabase, setSelectedDatabase] = useState<string>("");
  const [loadingDatabases, setLoadingDatabases] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const result = activeTabId ? queryResults[activeTabId] : undefined;
  const connectedConnections = connections.filter((c: any) => c.connected);
  const effectiveConnectionId = selectedConnId || activeConnectionId;
  const activeConnection = connections.find((c) => c.id === effectiveConnectionId);
  const isTxActive = effectiveConnectionId ? !!transactionActive[effectiveConnectionId] : false;

  // Sync selectedConnId when global activeConnectionId changes
  useEffect(() => {
    if (activeConnectionId) {
      setSelectedConnId(activeConnectionId);
    }
  }, [activeConnectionId]);

  // Fetch database list when selected connection changes
  useEffect(() => {
    if (!effectiveConnectionId) {
      setDatabaseList([]);
      setSelectedDatabase("");
      return;
    }
    const conn = connections.find((c) => c.id === effectiveConnectionId);
    if (!conn || !conn.connected) {
      setDatabaseList([]);
      return;
    }

    setLoadingDatabases(true);
    if (conn.type === 'mysql') {
      executeQuery(effectiveConnectionId, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").then((res) => {
        const dbs = res.rows.map((row: any) => {
          const val = row['SCHEMA_NAME'] || row['schema_name'] || Object.values(row)[0];
          return String(val);
        }).filter((v: string) => v && v !== 'undefined');
        setDatabaseList(dbs);
        if (conn.database && dbs.includes(conn.database)) {
          setSelectedDatabase(conn.database);
        } else if (dbs.length > 0 && !selectedDatabase) {
          setSelectedDatabase(dbs[0] || "");
        }
      }).catch(() => setDatabaseList([])).finally(() => setLoadingDatabases(false));
    } else {
      getSchemas(effectiveConnectionId).then((schemas) => {
        setDatabaseList(schemas);
        if (schemas.includes('public')) {
          setSelectedDatabase('public');
        } else if (schemas.length > 0 && !selectedDatabase) {
          setSelectedDatabase(schemas[0] || "");
        }
      }).catch(() => setDatabaseList([])).finally(() => setLoadingDatabases(false));
    }
  }, [effectiveConnectionId, connections]);

  // Handle connection change
  const handleConnectionChange = useCallback((connId: string) => {
    setSelectedConnId(connId);
    setSelectedDatabase("");
    setDatabaseList([]);
    useAppStore.getState().setActiveConnection(connId);
  }, []);

  // Handle database change
  const handleDatabaseChange = useCallback(async (db: string) => {
    setSelectedDatabase(db);
    if (!effectiveConnectionId) return;
    const conn = connections.find((c) => c.id === effectiveConnectionId);
    if (conn?.type === 'mysql') {
      try {
        await executeSql(effectiveConnectionId, `USE \`${db}\``);
      } catch (err) {
        console.error('Failed to switch database:', err);
      }
    }
  }, [effectiveConnectionId, connections]);

  // Load schemas, tables, and columns for autocomplete when connection changes
  useEffect(() => {
    if (!effectiveConnectionId) {
      dbSchemasRef.current = [];
      dbTablesRef.current = [];
      dbColumnsRef.current = {};
      return;
    }
    // Load schemas
    getSchemas(effectiveConnectionId).then((schemas) => {
      dbSchemasRef.current = schemas;
    }).catch(() => { dbSchemasRef.current = []; });
    // Load tables
    getTables(effectiveConnectionId).then((tables) => {
      dbTablesRef.current = tables.map((t) => ({ name: t.name, schema: t.schema }));
      // Load columns for each table (limit to first 50 tables to avoid overload)
      const tablesToLoad = tables.slice(0, 50);
      tablesToLoad.forEach((table) => {
        getColumns(effectiveConnectionId, table.name, table.schema).then((cols) => {
          dbColumnsRef.current[table.name] = cols.map((c) => c.name);
        }).catch(() => {});
      });
    }).catch(() => { dbTablesRef.current = []; });
  }, [effectiveConnectionId]);

  // Clear stale editor refs when tab changes to prevent accessing disposed Monaco instances
  useEffect(() => {
    editorRef.current = null;
    monacoRef.current = null;
  }, [activeTabId]);

  // Register SQL completion provider once
  const completionDisposableRef = useRef<any>(null);

  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;

    // Custom right-click context menu
    editor.onContextMenu((e: any) => {
      e.event.preventDefault();
      e.event.stopPropagation();
      setContextMenu({ x: e.event.posx, y: e.event.posy });
    });

    // Register SQL completion provider with dynamic db objects (only once)
    if (!completionDisposableRef.current) {
      completionDisposableRef.current = monacoInstance.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          // Check if typing after a dot (e.g. "schema." or "table.")
          const textBeforeCursor = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: word.startColumn,
          });
          const dotMatch = textBeforeCursor.match(/(\w+)\.$/);

          const suggestions: any[] = [];

          if (dotMatch) {
            const prefix = dotMatch[1];
            // If prefix is a schema name, suggest tables in that schema
            if (dbSchemasRef.current.includes(prefix)) {
              dbTablesRef.current
                .filter((t) => t.schema === prefix)
                .forEach((t) => {
                  suggestions.push({
                    label: t.name,
                    kind: monacoInstance.languages.CompletionItemKind.Field,
                    insertText: t.name,
                    detail: "Table",
                    range,
                  });
                });
            }
            // If prefix is a table name, suggest columns
            const cols = dbColumnsRef.current[prefix];
            if (cols) {
              cols.forEach((col) => {
                suggestions.push({
                  label: col,
                  kind: monacoInstance.languages.CompletionItemKind.Property,
                  insertText: col,
                  detail: "Column",
                  range,
                });
              });
            }
          } else {
            // SQL keywords
            SQL_KEYWORDS.forEach((kw) => {
              suggestions.push({
                label: kw,
                kind: monacoInstance.languages.CompletionItemKind.Keyword,
                insertText: kw,
                range,
                sortText: `2_${kw}`,
              });
            });
            // Schema names
            dbSchemasRef.current.forEach((schema) => {
              suggestions.push({
                label: schema,
                kind: monacoInstance.languages.CompletionItemKind.Module,
                insertText: schema,
                detail: "Schema",
                range,
                sortText: `0_${schema}`,
              });
            });
            // Table names
            dbTablesRef.current.forEach((t) => {
              suggestions.push({
                label: t.name,
                kind: monacoInstance.languages.CompletionItemKind.Field,
                insertText: t.name,
                detail: t.schema ? `Table (${t.schema})` : "Table",
                range,
                sortText: `1_${t.name}`,
              });
            });
            // Column names (all tables)
            const addedCols = new Set<string>();
            Object.entries(dbColumnsRef.current).forEach(([tableName, cols]) => {
              cols.forEach((col) => {
                if (!addedCols.has(col)) {
                  addedCols.add(col);
                  suggestions.push({
                    label: col,
                    kind: monacoInstance.languages.CompletionItemKind.Property,
                    insertText: col,
                    detail: `Column (${tableName})`,
                    range,
                    sortText: `3_${col}`,
                  });
                }
              });
            });
          }

          return { suggestions };
        },
      });
    }
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

    window.addEventListener("crabhub:export", handleExportEvent);
    window.addEventListener("crabhub:import", handleImportEvent);
    window.addEventListener("crabhub:execute-query", handleExecuteEvent);

    return () => {
      window.removeEventListener("crabhub:export", handleExportEvent);
      window.removeEventListener("crabhub:import", handleImportEvent);
      window.removeEventListener("crabhub:execute-query", handleExecuteEvent);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, effectiveConnectionId, result]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        updateTabContent(activeTabId, value);
      }
    },
    [activeTabId, updateTabContent]
  );

  const handleExecute = useCallback(async (selectedOnly?: boolean) => {
    if (!activeTabId || !effectiveConnectionId || !editorRef.current) return;

    let sqlText: string;
    try {
      if (selectedOnly) {
        const selection = editorRef.current.getSelection();
        if (selection && !selection.isEmpty()) {
          sqlText = editorRef.current.getModel()?.getValueInRange(selection)?.trim() || "";
        } else {
          return;
        }
      } else {
        const selection = editorRef.current.getSelection();
        if (selection && !selection.isEmpty()) {
          sqlText = editorRef.current.getModel()?.getValueInRange(selection)?.trim() || "";
        } else {
          sqlText = editorRef.current.getValue().trim();
        }
      }
    } catch {
      return;
    }
    if (!sqlText) return;

    // Split into individual statements
    const statements = splitSqlStatements(sqlText);
    if (statements.length === 0) return;

    setIsExecuting(true);
    setMessages([]);
    setExecutionTime(null);
    setImportPreview(null);

    const startTime = performance.now();
    const allMessages: string[] = [];
    const collectedResults: QueryResult[] = [];
    const newLoadMoreState: Record<number, { hasMore: boolean; currentOffset: number; originalSql: string }> = {};

    try {
      for (let idx = 0; idx < statements.length; idx++) {
        const sql = statements[idx]!;
        const stmtStart = performance.now();

        if (isSelectQuery(sql)) {
          let queryResult: QueryResult;
          let hasMore = false;

          // Use paged API for SELECT/WITH queries (auto-LIMIT injection)
          // For SHOW/DESCRIBE/EXPLAIN, use regular executeQuery (no LIMIT needed)
          if (shouldAutoLimit(sql)) {
            const pagedResult: PagedQueryResult = await executeQueryPaged(effectiveConnectionId, sql, QUERY_PAGE_SIZE, 0);
            queryResult = pagedResult;
            hasMore = pagedResult.hasMore;
          } else {
            queryResult = await executeQuery(effectiveConnectionId, sql);
          }

          const stmtElapsed = performance.now() - stmtStart;
          const resultIdx = collectedResults.length;
          collectedResults.push(queryResult);

          // Track load-more state for this result
          newLoadMoreState[resultIdx] = {
            hasMore,
            currentOffset: queryResult.rows.length,
            originalSql: sql,
          };

          allMessages.push(
            statements.length > 1
              ? `[${idx + 1}/${statements.length}] ${t('editor.querySuccess', { rows: String(queryResult.rowCount), ms: stmtElapsed.toFixed(0) })}`
              : t('editor.querySuccess', { rows: String(queryResult.rowCount), ms: stmtElapsed.toFixed(0) })
          );

          addQueryHistory({
            connectionId: effectiveConnectionId,
            sql,
            duration: stmtElapsed,
            timestamp: new Date(),
            rowCount: queryResult.rowCount || 0,
          });

          if (stmtElapsed >= slowQueryThreshold) {
            addSlowQuery({
              sql,
              duration: stmtElapsed,
              timestamp: new Date(),
              connectionId: effectiveConnectionId,
              rowCount: queryResult.rowCount || 0,
            });
          }
        } else {
          const execResult = await executeSql(effectiveConnectionId, sql);
          const stmtElapsed = performance.now() - stmtStart;
          allMessages.push(
            statements.length > 1
              ? `[${idx + 1}/${statements.length}] ${t('editor.executeSuccess', { message: execResult.message, ms: stmtElapsed.toFixed(0) })}`
              : t('editor.executeSuccess', { message: execResult.message, ms: stmtElapsed.toFixed(0) })
          );

          addQueryHistory({
            connectionId: effectiveConnectionId,
            sql,
            duration: stmtElapsed,
            timestamp: new Date(),
            rowCount: 0,
          });

          if (stmtElapsed >= slowQueryThreshold) {
            addSlowQuery({
              sql,
              duration: stmtElapsed,
              timestamp: new Date(),
              connectionId: effectiveConnectionId,
              rowCount: 0,
            });
          }
        }
      }

      const totalElapsed = performance.now() - startTime;
      setExecutionTime(totalElapsed);
      setMessages(allMessages);
      setMultiResults(collectedResults);
      setActiveResultIdx(0);
      setLoadMoreState(newLoadMoreState);

      if (collectedResults.length > 0) {
        setQueryResult(activeTabId, collectedResults[0]!);
        setResultTab("results");
      } else {
        setQueryResult(activeTabId, { columns: [], rows: [], rowCount: 0, duration: totalElapsed });
        setResultTab("messages");
      }
    } catch (err) {
      const totalElapsed = performance.now() - startTime;
      setExecutionTime(totalElapsed);
      const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : t('editor.executeFailed'));
      allMessages.push(t('editor.errorPrefix', { error: errorMsg }));
      setMessages(allMessages);
      setMultiResults(collectedResults);
      setActiveResultIdx(0);
      setLoadMoreState(newLoadMoreState);

      if (collectedResults.length > 0) {
        setQueryResult(activeTabId, collectedResults[0]!);
      } else {
        setQueryResult(activeTabId, { columns: [], rows: [], rowCount: 0, duration: totalElapsed });
      }
      setResultTab("messages");
    } finally {
      setIsExecuting(false);
    }
  }, [activeTabId, effectiveConnectionId, activeConnection, setQueryResult, setIsExecuting, addQueryHistory]);

  // Load more rows for a specific result index
  const handleLoadMore = useCallback(async (resultIdx: number) => {
    if (isLoadingMore || !effectiveConnectionId) return;
    const state = loadMoreState[resultIdx];
    if (!state || !state.hasMore) return;

    setIsLoadingMore(true);
    try {
      const pagedResult: PagedQueryResult = await executeQueryPaged(
        effectiveConnectionId,
        state.originalSql,
        QUERY_PAGE_SIZE,
        state.currentOffset
      );

      setMultiResults(prev => {
        const updated = [...prev];
        if (updated[resultIdx]) {
          const existing = updated[resultIdx];
          updated[resultIdx] = {
            ...existing,
            rows: [...existing.rows, ...pagedResult.rows],
            rowCount: existing.rows.length + pagedResult.rows.length,
          };
          // Update the store if this is the active result
          if (activeTabId && activeResultIdx === resultIdx) {
            setQueryResult(activeTabId, updated[resultIdx]);
          }
        }
        return updated;
      });

      setLoadMoreState(prev => ({
        ...prev,
        [resultIdx]: {
          ...state,
          hasMore: pagedResult.hasMore,
          currentOffset: state.currentOffset + pagedResult.rows.length,
        },
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, t('editor.errorPrefix', { error: errorMsg })]);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, effectiveConnectionId, loadMoreState, activeTabId, activeResultIdx, setQueryResult]);

  // Bind Ctrl+Enter whenever activeTabId or effectiveConnectionId changes
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    try {
      const disposable = editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        () => handleExecute()
      );
      return () => { try { disposable?.dispose(); } catch {} };
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, effectiveConnectionId, handleExecute]);

  // Context menu helpers
  const hasSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return false;
    const selection = editor.getSelection();
    return selection ? !selection.isEmpty() : false;
  }, []);

  const getSelectedText = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return "";
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return "";
    return editor.getModel()?.getValueInRange(selection) || "";
  }, []);

  const handleCut = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = getSelectedText();
    if (!text) return;
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (isTauri) {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      // Delete selected text
      const selection = editor.getSelection();
      if (selection) {
        editor.executeEdits('cut', [{
          range: selection,
          text: '',
        }]);
      }
    } catch {
      // fallback: use document.execCommand
      editor.focus();
      document.execCommand('cut');
    }
    editor.focus();
  }, [getSelectedText]);

  const handleCopy = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = getSelectedText();
    if (!text) return;
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (isTauri) {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      editor.focus();
      document.execCommand('copy');
    }
    editor.focus();
  }, [getSelectedText]);

  const handlePaste = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      let text: string | null = null;
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (isTauri) {
        const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
        text = await readText();
      } else {
        text = await navigator.clipboard.readText();
      }
      if (text) {
        const selection = editor.getSelection();
        if (selection) {
          editor.executeEdits('paste', [{
            range: selection,
            text: text,
          }]);
        }
      }
    } catch {
      editor.focus();
      document.execCommand('paste');
    }
    editor.focus();
  }, []);

  const handleSelectAll = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const model = editor.getModel();
    if (model) {
      const fullRange = model.getFullModelRange();
      editor.setSelection(fullRange);
    }
  }, []);

  const handleSelectCurrentStatement = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const model = editor.getModel();
    if (!model) return;
    const position = editor.getPosition();
    if (!position) return;

    const fullText = model.getValue();
    const offset = model.getOffsetAt(position);
    // Find the statement boundaries (split by semicolons)
    let start = 0;
    let end = fullText.length;
    const parts = fullText.split(';');
    let currentOffset = 0;
    for (const part of parts) {
      const partEnd = currentOffset + part.length;
      if (offset >= currentOffset && offset <= partEnd) {
        start = currentOffset;
        end = partEnd;
        break;
      }
      currentOffset = partEnd + 1; // +1 for the semicolon
    }
    const startPos = model.getPositionAt(start);
    const endPos = model.getPositionAt(end);
    editor.setSelection({
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
    });
  }, []);

  const handleFormat = useCallback(() => {
    if (!editorRef.current || !activeTabId) return;
    try {
      const currentValue = editorRef.current.getValue();
      if (!currentValue?.trim()) return;
      const formatted = formatSQL(currentValue, {
        language: "sql",
        tabWidth: 2,
        keywordCase: "upper",
        linesBetweenQueries: 2,
      });
      editorRef.current.setValue(formatted);
      updateTabContent(activeTabId, formatted);
    } catch {}
  }, [activeTabId, updateTabContent]);

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
      setMessages([t('editor.importFailed', { error: err instanceof Error ? err.message : (typeof err === 'string' ? err : t('common.unknownError')) })]);
      setResultTab("messages");
    }
  }, []);

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview || !effectiveConnectionId || !activeTabId) return;

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
      await executeSql(effectiveConnectionId, fullSql);
      setMessages([t('editor.importSuccess', { rows: String(rows.length), table: importTableName })]);
      setImportPreview(null);
      setResultTab("messages");
    } catch (err) {
      setMessages([t('editor.importFailed', { error: err instanceof Error ? err.message : (typeof err === 'string' ? err : t('common.unknownError')) })]);
      setResultTab("messages");
    } finally {
      setIsExecuting(false);
    }
  }, [importPreview, effectiveConnectionId, activeTabId, importTableName, setIsExecuting]);

  const handleTransaction = useCallback(async (action: "begin" | "commit" | "rollback") => {
    if (!effectiveConnectionId) {
      setMessages(["No active connection"]);
      setResultTab("messages");
      return;
    }

    const sqlMap = { begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" };
    const labelMap: Record<string, string> = {
      begin: t('editor.beginTransactionLabel'),
      commit: t('editor.commitTransactionLabel'),
      rollback: t('editor.rollbackTransactionLabel'),
    };

    try {
      const result = await executeSql(effectiveConnectionId, sqlMap[action]);
      setTransactionActive(effectiveConnectionId, action === "begin");
      setMessages([
        t('editor.transactionSuccess', { action: labelMap[action] || action }),
        `(${result.duration}ms)`,
      ]);
      setResultTab("messages");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setMessages([`${t('editor.transactionFailed')}: ${errMsg}`]);
      setResultTab("messages");
    }
  }, [effectiveConnectionId, setTransactionActive]);

  if (!activeTab) {
    return <WelcomeScreen />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      {/* Navicat-style Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0 bg-muted/20">
        <div className="flex items-center gap-2">
          {/* Connection selector */}
          <select
            value={effectiveConnectionId || ""}
            onChange={(e) => handleConnectionChange(e.target.value)}
            className="text-xs px-1.5 py-0.5 rounded border border-border bg-background text-foreground max-w-[180px] truncate focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
            title={t('sidebar.connections')}
          >
            <option value="" disabled>{t('sidebar.connections')}</option>
            {connectedConnections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.name}
              </option>
            ))}
          </select>
          {/* Database / Schema selector */}
          <select
            value={selectedDatabase}
            onChange={(e) => handleDatabaseChange(e.target.value)}
            disabled={!effectiveConnectionId || databaseList.length === 0}
            className="text-xs px-1.5 py-0.5 rounded border border-border bg-background text-foreground max-w-[160px] truncate focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] disabled:opacity-40"
            title={activeConnection?.type === 'mysql' ? 'Database' : 'Schema'}
          >
            {loadingDatabases ? (
              <option value="">Loading...</option>
            ) : databaseList.length === 0 ? (
              <option value="">{activeConnection?.type === 'mysql' ? 'Database' : 'Schema'}</option>
            ) : (
              databaseList.map((db) => (
                <option key={db} value={db}>{db}</option>
              ))
            )}
          </select>
          {isTxActive && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 animate-pulse">
              {t('common.transactionActive')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {executionTime !== null && (
            <span className="text-[10px] text-muted-foreground mr-1">
              {executionTime.toFixed(0)} ms
            </span>
          )}
          {/* Transaction buttons */}
          {effectiveConnectionId && (
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
            onClick={() => useAppStore.getState().toggleAIPanel()}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title="AI Assistant"
          >
            <Brain size={12} />
            AI
          </button>
          <button
            onClick={async () => {
              const sql = editorRef.current?.getValue() || '';
              if (sql) {
                useAppStore.getState().toggleAIPanel();
                // Set AI input to optimize the SQL
                setTimeout(() => {
                  const aiInput = document.querySelector('.ai-input');
                  if (aiInput) {
                    (aiInput as HTMLTextAreaElement).value = `帮我优化这个SQL: ${sql}`;
                  }
                }, 100);
              }
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title={t('ai.optimizeSql')}
          >
            <Lightbulb size={12} />
            {t('ai.optimizeSql')}
          </button>
          <button
            onClick={() => handleExecute()}
            disabled={isExecuting || !effectiveConnectionId}
            className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-40"
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

      {/* Resizable Editor + Result panels */}
      <PanelGroup direction="vertical" autoSaveId="query-editor-panels" className="flex-1 min-h-0">
        {/* SQL Editor Panel */}
        <Panel defaultSize={60} minSize={20}>
          <div className="h-full">
            <Editor
              key={activeTab.id}
              height="100%"
              language="sql"
              theme={theme === "dark" ? "vs-dark" : "vs"}
              value={activeTab.content || ""}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={{
                cursorStyle: "line",
                cursorBlinking: "smooth",
                cursorSmoothCaretAnimation: "on",
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
                contextmenu: false,
                scrollbar: {
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6,
                },
              }}
            />
          </div>

          {/* Custom Context Menu */}
          {contextMenu && (
            <EditorContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              hasSelection={hasSelection()}
              onClose={() => setContextMenu(null)}
              onRunAll={() => { setContextMenu(null); handleExecute(false); }}
              onRunSelected={() => { setContextMenu(null); handleExecute(true); }}
              onFormat={() => { setContextMenu(null); handleFormat(); }}
              onCut={() => { setContextMenu(null); handleCut(); }}
              onCopy={() => { setContextMenu(null); handleCopy(); }}
              onPaste={() => { setContextMenu(null); handlePaste(); }}
              onSelectAll={() => { setContextMenu(null); handleSelectAll(); }}
              onSelectCurrentStatement={() => { setContextMenu(null); handleSelectCurrentStatement(); }}
            />
          )}
        </Panel>

        {/* Resize Handle */}
        <PanelResizeHandle className="h-px bg-border hover:bg-[hsl(var(--tab-active))] transition-colors cursor-row-resize" />

        {/* Result Panel */}
        <Panel defaultSize={40} minSize={10}>
          <div className="flex flex-col h-full">
            {/* Result Tab Bar */}
            <div className="flex items-center justify-between px-2 py-0.5 border-b border-border shrink-0 bg-muted/20">
              <div className="flex items-center gap-0">
                {/* Multi-result tabs when multiple SELECT results exist */}
                {multiResults.length > 1 ? (
                  <>
                    {multiResults.map((r, idx) => (
                      <button
                        key={`result-${idx}`}
                        onClick={() => {
                          setActiveResultIdx(idx);
                          if (activeTabId) setQueryResult(activeTabId, r);
                          setResultTab("results");
                        }}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          resultTab === "results" && activeResultIdx === idx
                            ? "text-foreground border-b-2 border-[hsl(var(--tab-active))]"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {`${t('editor.resultCount', { suffix: '' })} ${idx + 1} (${r.rowCount}${loadMoreState[idx]?.hasMore ? '+' : ''})`}
                      </button>
                    ))}
                    <button
                      onClick={() => setResultTab("messages")}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        resultTab === "messages"
                          ? "text-foreground border-b-2 border-[hsl(var(--tab-active))]"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t('editor.messages')}
                    </button>
                  </>
                ) : (
                  (["results", "messages"] as ResultTab[]).map((tab) => (
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
                        : t('editor.messages')}
                    </button>
                  ))
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Export buttons */}
                {resultTab === "results" && result && result.columns.length > 0 && (
                  <>
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
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-40"
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
            <div className="flex-1 min-h-0">
              {resultTab === "results" && (
                <ResultTable
                  result={result}
                  importPreview={importPreview}
                  hasMore={loadMoreState[activeResultIdx]?.hasMore ?? false}
                  isLoadingMore={isLoadingMore}
                  onLoadMore={() => handleLoadMore(activeResultIdx)}
                />
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
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

// ===== Result Table =====

interface ResultTableProps {
  result?: QueryResult;
  importPreview?: { columns: string[]; rows: any[] } | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

function ResultTable({ result, importPreview, hasMore, isLoadingMore, onLoadMore }: ResultTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver for scroll-to-load-more
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!sentinel || !scrollContainer) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          onLoadMore();
        }
      },
      { root: scrollContainer, rootMargin: '200px', threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  if (importPreview) {
    const { columns, rows } = importPreview;
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-xs border-collapse border">
          <thead className="sticky top-0 z-10">
            <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
              {columns.map((col: any) => (
                <th
                  key={col}
                  className="px-3 py-1.5 text-left font-medium text-white whitespace-nowrap border border-white/40"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="hover:bg-accent transition-colors even:bg-muted/60"
              >
                {columns.map((col: any) => (
                  <td
                    key={col}
                    className="px-3 py-1 whitespace-nowrap max-w-[300px] truncate border"
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
    <div className="flex flex-col h-full">
      <div ref={scrollContainerRef} className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-xs border-collapse border">
          <thead className="sticky top-0 z-10">
            <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
              {columns.map((col: any) => (
                <th
                  key={col.name}
                  className="px-3 py-1.5 text-left font-medium text-white whitespace-nowrap border border-white/40"
                >
                  <div className="flex items-center gap-1">
                    <span>{col.name}</span>
                    {col.isPrimaryKey && (
                      <span className="text-[9px] px-0.5 rounded bg-white/20 text-white">
                        PK
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any, rowIdx: number) => (
              <tr
                key={rowIdx}
                className="hover:bg-accent transition-colors even:bg-muted/60"
              >
                {columns.map((col: any) => (
                  <td
                    key={col.name}
                    className="px-3 py-1 whitespace-nowrap max-w-[300px] truncate border"
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
        {/* Sentinel for IntersectionObserver */}
        <div ref={sentinelRef} className="h-1" />
        {/* Loading / status indicator */}
        {isLoadingMore && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('scroll.loadingMore')}
          </div>
        )}
      </div>
      {/* Bottom status bar */}
      <div className="flex items-center px-3 py-1 border-t border-border shrink-0 bg-muted/20 text-[11px] text-muted-foreground">
        {hasMore
          ? t('scroll.rowsLoaded', { count: String(rows.length) })
          : rows.length > 0
            ? t('scroll.allLoaded', { count: String(rows.length) })
            : null
        }
      </div>
    </div>
  );
}

// ===== Welcome Screen =====

function WelcomeScreen() {
  const { addTab, toggleAIPanel } = useAppStore();

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        {/* Crab Logo */}
        <svg width="72" height="72" viewBox="0 0 32 32" fill="none" className="opacity-50"><circle cx="16" cy="16" r="15" fill="white" /><g transform="translate(3,3) scale(0.95)"><ellipse cx="13" cy="16" rx="8" ry="6" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><circle cx="10" cy="13" r="1.8" fill="white" /><circle cx="16" cy="13" r="1.8" fill="white" /><circle cx="10" cy="12.8" r="0.9" fill="#1a1a1a" /><circle cx="16" cy="12.8" r="0.9" fill="#1a1a1a" /><path d="M11 17.5 Q13 19, 15 17.5" stroke="#991B1B" strokeWidth="0.6" fill="none" /><path d="M5 15 C5 15, -1 10, -2 6 C-3 3, 0 3, 1 6 L3 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M-2 6 C-2 6, -4 4, -3 2 C-2 0, -1 2, 0 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M21 15 C21 15, 27 10, 28 6 C29 3, 26 3, 25 6 L23 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M28 6 C28 6, 30 4, 29 2 C28 0, 27 2, 26 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M7 17 L2 19 L1 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M7 18 L3 21 L2 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M8 19 L4 22 L3 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 17 L24 19 L25 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 18 L23 21 L24 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M18 19 L22 22 L23 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /></g></svg>
        <h2 className="text-base font-medium text-foreground/60">CrabHub</h2>
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

// ===== Editor Context Menu (Navicat-style) =====

// Platform-adaptive modifier key
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '⌘' : 'Ctrl+';

interface EditorContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  onClose: () => void;
  onRunAll: () => void;
  onRunSelected: () => void;
  onFormat: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onSelectCurrentStatement: () => void;
}

function EditorContextMenu({
  x,
  y,
  hasSelection,
  onClose,
  onRunAll,
  onRunSelected,
  onFormat,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onSelectCurrentStatement,
}: EditorContextMenuProps) {
  // Adjust position to stay within viewport
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let adjustedX = x;
      let adjustedY = y;
      if (x + rect.width > window.innerWidth) {
        adjustedX = window.innerWidth - rect.width - 4;
      }
      if (y + rect.height > window.innerHeight) {
        adjustedY = window.innerHeight - rect.height - 4;
      }
      setPos({ x: adjustedX, y: adjustedY });
    }
  }, [x, y]);

  const menuItem = (
    label: string,
    onClick: () => void,
    icon: React.ReactNode,
    shortcut?: string,
    disabled?: boolean,
    highlight?: boolean
  ) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${
        highlight
          ? "bg-[hsl(var(--tab-active))] text-white hover:opacity-90"
          : "hover:bg-muted"
      }`}
    >
      <span className="w-4 flex items-center justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-muted-foreground ml-4">{shortcut}</span>
      )}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        ref={menuRef}
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[220px]"
        style={{
          left: pos.x,
          top: pos.y,
          backgroundColor: 'hsl(var(--popover))',
          color: 'hsl(var(--popover-foreground))',
        }}
      >
        {hasSelection
          ? menuItem(t("contextMenu.runSelected"), onRunSelected, <Play size={12} />, undefined, false, true)
          : menuItem(t("contextMenu.run"), onRunAll, <Play size={12} />, `${modKey}Enter`, false, true)
        }

        <div className="border-t border-border my-1" />

        {menuItem(t("contextMenu.cut"), onCut, <Scissors size={12} />, `${modKey}X`, !hasSelection)}
        {menuItem(t("contextMenu.copy"), onCopy, <Copy size={12} />, `${modKey}C`, !hasSelection)}
        {menuItem(t("contextMenu.paste"), onPaste, <ClipboardPaste size={12} />, `${modKey}V`)}

        <div className="border-t border-border my-1" />

        {menuItem(t("contextMenu.formatSql"), onFormat, <AlignLeft size={12} />)}

        <div className="border-t border-border my-1" />

        {menuItem(t("contextMenu.selectCurrentStatement"), onSelectCurrentStatement, <TextCursorInput size={12} />)}
        {menuItem(t("contextMenu.selectAll"), onSelectAll, <MousePointerClick size={12} />, `${modKey}A`)}
      </div>
    </>
  );
}
