import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  BarChart3,
} from "lucide-react";
import { useAppStore, useConnectionStore, useTabStore, useUIStore } from "@/stores/app-store";
import TabBar from "./TabBar";
import type { QueryResult, PagedQueryResult } from "@/types";
import { t } from "@/lib/i18n";
import { executeQuery, executeQueryPaged, executeSql, getTables, getSchemas, getDatabases, getColumns, updateTableRows, deleteTableRows, cancelQuery } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, exportToSQL, downloadFile, importFromCSV, importFromJSON, buildWhereClause } from "@/lib/export";
import { format as formatSQL } from "sql-formatter";
import ERDiagram from "./ERDiagram";
import TableDesigner from "./TableDesigner";
import QueryAnalyzer from "./QueryAnalyzer";
import NotebookView from "./notebook/NotebookView";
import VisualQueryBuilder from "./query-builder/VisualQueryBuilder";
import QuickChartPanel from "./QuickChartPanel";

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

const QUERY_PAGE_SIZE = 500;

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

function rowsToMarkdown(
  columns: { name: string }[],
  rows: Record<string, unknown>[]
): string {
  if (rows.length === 0) return "";
  const headers = columns.map(c => c.name);
  const separator = headers.map(() => "---");

  const body = rows.map(row =>
    "| " + headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return "";
      return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
    }).join(" | ") + " |"
  );

  return [
    "| " + headers.join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...body,
  ].join("\n");
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
            useTabStore.getState().setActiveTab(newTabId);
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
    addSlowQuery: _addSlowQuery,
    slowQueryThreshold: _slowQueryThreshold,
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
  const [chartPanel, setChartPanel] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);

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
  // Cache database lists per connection to avoid re-fetching
  const dbCacheRef = useRef<Record<string, string[]>>({});

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

    // Return cached list if already loaded for this connection
    if (dbCacheRef.current[effectiveConnectionId]) {
      setDatabaseList(dbCacheRef.current[effectiveConnectionId]);
      if (conn.database && dbCacheRef.current[effectiveConnectionId].includes(conn.database)) {
        setSelectedDatabase(conn.database);
      } else if (!selectedDatabase) {
        setSelectedDatabase(dbCacheRef.current[effectiveConnectionId][0] || "");
      }
      return;
    }

    setLoadingDatabases(true);
    if (conn.type === 'mysql') {
      executeQuery(effectiveConnectionId, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").then((res) => {
        const dbs = res.rows.map((row: any) => {
          const val = row['SCHEMA_NAME'] || row['schema_name'] || Object.values(row)[0];
          return String(val);
        }).filter((v: string) => v && v !== 'undefined');
        dbCacheRef.current[effectiveConnectionId] = dbs;
        setDatabaseList(dbs);
        setSelectedDatabase(conn.database && dbs.includes(conn.database) ? conn.database : dbs[0] || "");
      }).catch(() => setDatabaseList([])).finally(() => setLoadingDatabases(false));
    } else {
      getDatabases(effectiveConnectionId).then((dbs) => {
        if (dbs.length > 0) {
          dbCacheRef.current[effectiveConnectionId] = dbs;
          setDatabaseList(dbs);
          setSelectedDatabase(conn.database && dbs.includes(conn.database) ? conn.database : dbs[0] || "");
        } else {
          // Fallback: load schemas
          getSchemas(effectiveConnectionId).then((schemas) => {
            dbCacheRef.current[effectiveConnectionId] = schemas;
            setDatabaseList(schemas);
            setSelectedDatabase(schemas[0] || "");
          }).catch(() => setDatabaseList([])).finally(() => setLoadingDatabases(false));
          return;
        }
        setLoadingDatabases(false);
      }).catch(() => {
        getSchemas(effectiveConnectionId).then((schemas) => {
          dbCacheRef.current[effectiveConnectionId] = schemas;
          setDatabaseList(schemas);
          setSelectedDatabase(schemas[0] || "");
        }).catch(() => setDatabaseList([])).finally(() => setLoadingDatabases(false));
      });
    }
  }, [effectiveConnectionId]);

  // Handle connection change
  const handleConnectionChange = useCallback((connId: string) => {
    setSelectedConnId(connId);
    setSelectedDatabase("");
    setDatabaseList([]);
    useConnectionStore.getState().setActiveConnection(connId);
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          updateTabContent(activeTabId, value);
        }, 300);
      }
    },
    [activeTabId, updateTabContent]
  );

  const handleExecute = useCallback(async (selectedOnly?: boolean) => {
    if (!activeTabId || !effectiveConnectionId || !editorRef.current) return;
    if (isExecuting[activeTabId]) return;

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

    setIsExecuting(activeTabId!, true);
    setMessages([]);
    setExecutionTime(null);
    setImportPreview(null);

    const startTime = performance.now();
    const allMessages: string[] = [];
    const collectedResults: QueryResult[] = [];
    const newLoadMoreState: Record<number, { hasMore: boolean; currentOffset: number; originalSql: string }> = {};

    try {
      // Execute ALL statements in parallel — database controls concurrency
      const allResults = await Promise.all(statements.map(async (sql, idx) => {
        const stmtStart = performance.now();
        const ipcStart = performance.now();
        let queryResult: QueryResult;
        let hasMore = false;
        if (isSelectQuery(sql)) {
          if (shouldAutoLimit(sql)) {
            const pagedResult: PagedQueryResult = await executeQueryPaged(effectiveConnectionId, sql, QUERY_PAGE_SIZE, 0);
            queryResult = pagedResult;
            hasMore = pagedResult.hasMore;
          } else {
            queryResult = await executeQuery(effectiveConnectionId, sql);
          }
        } else {
          await executeSql(effectiveConnectionId, sql);
          const elapsed = performance.now() - stmtStart;
          return { idx, queryResult: { columns: [], rows: [], rowCount: 0, duration: elapsed }, hasMore: false, stmtElapsed: elapsed, dbTime: elapsed, overhead: 0, sql };
        }
        const ipcElapsed = performance.now() - ipcStart;
        const dbTime = (queryResult as any).duration ?? (queryResult as any).executionTimeMs ?? 0;
        return { idx, queryResult, hasMore, stmtElapsed: performance.now() - stmtStart, dbTime, overhead: ipcElapsed - dbTime, sql };
      }));

      // Process results in original statement order
      allResults.sort((a, b) => a.idx - b.idx);
      for (const { idx, queryResult, hasMore, stmtElapsed, dbTime, overhead, sql } of allResults) {
        if (queryResult.columns.length > 0 || queryResult.rows.length > 0) {
          const resultIdx = collectedResults.length;
          collectedResults.push(queryResult);
          newLoadMoreState[resultIdx] = { hasMore, currentOffset: queryResult.rows.length, originalSql: sql };
          const prefix = statements.length > 1 ? `[${idx + 1}/${statements.length}] ` : '';
          const timingDetail = `(DB: ${dbTime.toFixed(0)}ms | 传输: ${Math.max(0, overhead).toFixed(0)}ms | 总计: ${stmtElapsed.toFixed(0)}ms)`;
          allMessages.push(`${prefix}${t('editor.querySuccess', { rows: String(queryResult.rowCount), ms: stmtElapsed.toFixed(0) })} ${timingDetail}`);
          addQueryHistory({ connectionId: effectiveConnectionId, sql, duration: stmtElapsed, timestamp: new Date(), rowCount: queryResult.rowCount || 0 });
        } else {
          allMessages.push(
            statements.length > 1
              ? `[${idx + 1}/${statements.length}] ${t('editor.executeSuccess', { message: '', ms: stmtElapsed.toFixed(0) })}`
              : t('editor.executeSuccess', { message: '', ms: stmtElapsed.toFixed(0) })
          );
          addQueryHistory({ connectionId: effectiveConnectionId, sql, duration: stmtElapsed, timestamp: new Date(), rowCount: 0 });
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
      setIsExecuting(activeTabId!, false);
    }
  }, [activeTabId, effectiveConnectionId, activeConnection, setQueryResult, setIsExecuting, addQueryHistory]);

  // Load more rows for a specific result index
  const MAX_DISPLAY_ROWS = 10000;

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
          const newTotal = existing.rows.length + pagedResult.rows.length;
          if (newTotal > MAX_DISPLAY_ROWS) {
            updated[resultIdx] = {
              ...existing,
              rowCount: Math.min(newTotal, MAX_DISPLAY_ROWS),
            };
          } else {
            updated[resultIdx] = {
              ...existing,
              rows: [...existing.rows, ...pagedResult.rows],
              rowCount: newTotal,
            };
          }
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
          hasMore: state.currentOffset + pagedResult.rows.length < MAX_DISPLAY_ROWS && pagedResult.hasMore,
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

  const handleGenerateChart = useCallback(() => {
    const selectedResult = multiResults[activeResultIdx];
    if (!selectedResult || selectedResult.columns.length === 0) return;
    setChartPanel({
      columns: selectedResult.columns.map((c: any) => c.name),
      rows: selectedResult.rows,
    });
  }, [multiResults, activeResultIdx]);

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

    setIsExecuting(activeTabId!, true);
    try {
      await executeSql(effectiveConnectionId, fullSql);
      setMessages([t('editor.importSuccess', { rows: String(rows.length), table: importTableName })]);
      setImportPreview(null);
      setResultTab("messages");
    } catch (err) {
      setMessages([t('editor.importFailed', { error: err instanceof Error ? err.message : (typeof err === 'string' ? err : t('common.unknownError')) })]);
      setResultTab("messages");
    } finally {
      setIsExecuting(activeTabId!, false);
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
      {/* Tabs row — only show when tabs exist */}
      {tabs.length > 0 && (
        <div className="flex items-center border-b border-border shrink-0 bg-muted/20">
          <TabBar />
        </div>
      )}
      {/* Toolbar row */}
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
            title="Database"
          >
            {loadingDatabases ? (
              <option value="">Loading...</option>
            ) : databaseList.length === 0 ? (
              <option value="">Database</option>
            ) : (
              databaseList.map((db) => (
                <option key={db} value={db}>{db}</option>
              ))
            )}
          </select>
          {isTxActive && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning/20 text-warning animate-pulse">
              {t('common.transactionActive')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {executionTime !== null && (
            <span className="text-[11px] text-muted-foreground mr-1">
              {executionTime.toFixed(0)} ms
            </span>
          )}
          {/* Transaction buttons */}
          {effectiveConnectionId && (
            <>
              <button
                onClick={() => handleTransaction("begin")}
                disabled={isTxActive || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                title={t('editor.beginTransaction')}
              >
                <Database size={11} />
                {t('editor.beginTransaction')}
              </button>
              <button
                onClick={() => handleTransaction("commit")}
                disabled={!isTxActive || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                title={t('editor.commitTransaction')}
              >
                <CheckCircle2 size={11} />
                {t('editor.commit')}
              </button>
              <button
                onClick={() => handleTransaction("rollback")}
                disabled={!isTxActive || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
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
            onClick={() => useUIStore.getState().toggleAIPanel()}
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
                useUIStore.getState().toggleAIPanel();
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
          {isExecuting[activeTabId!] && (
            <button
              onClick={async () => {
                if (effectiveConnectionId) {
                  await cancelQuery(effectiveConnectionId);
                  setMessages(prev => [...prev, 'Query cancelled by user']);
                }
              }}
              className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors"
              title="Cancel query"
            >
              <XCircle size={12} />
              Cancel
            </button>
          )}
          <button
            onClick={() => handleExecute()}
            disabled={!!isExecuting[activeTabId!] || !effectiveConnectionId}
            className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
            title={t('editor.executeQuery')}
          >
            {isExecuting[activeTabId!] ? (
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
        <PanelResizeHandle className="h-px bg-border hover:bg-[hsl(var(--tab-active))] transition-colors cursor-row-resize opacity-0 hover:opacity-100" />

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
                  <>
                    {multiResults.length === 1 && (
                      <button
                        onClick={() => setResultTab("results")}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          resultTab === "results"
                            ? "text-foreground border-b-2 border-[hsl(var(--tab-active))]"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t('editor.resultCount', { suffix: ` (${multiResults[0]!.rowCount}${loadMoreState[0]?.hasMore ? '+' : ''})` })}
                      </button>
                    )}
                    <button
                      onClick={() => setResultTab("messages")}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        resultTab === "messages"
                          ? "text-foreground border-b-2 border-[hsl(var(--tab-active))]"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t('editor.messages')}
                      {messages.length > 0 && ` (${messages.length})`}
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Export buttons */}
                {resultTab === "results" && result && result.columns.length > 0 && (
                  <>
                    <button
                      onClick={() => handleExport("csv")}
                      className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                    >
                      CSV
                    </button>
                    <button
                      onClick={() => handleExport("json")}
                      className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
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
                <span className="text-[11px] text-muted-foreground">{t('editor.importTargetTable')}</span>
                <input
                  type="text"
                  value={importTableName}
                  onChange={(e) => setImportTableName(e.target.value)}
                  className="px-2 py-0.5 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground w-40"
                />
                <button
                  onClick={handleConfirmImport}
                  disabled={isExecuting[activeTabId!] || !importTableName.trim()}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
                >
                  <CheckCircle2 size={10} />
                  {t('editor.confirmImport')}
                </button>
                <button
                  onClick={() => setImportPreview(null)}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
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
                  onApplyChanges={async (modifiedCells, columns, rows) => {
                    if (!activeTab?.tableName || !effectiveConnectionId) return;
                    const rowGroups = new Map<number, [string, any][]>();
                    for (const [key, value] of modifiedCells.entries()) {
                      const parts = key.split(':');
                      const rowIdxStr = parts[0];
                      const colName = parts[1];
                      if (!rowIdxStr || !colName) continue;
                      const idx = parseInt(rowIdxStr);
                      if (!rowGroups.has(idx)) rowGroups.set(idx, []);
                      rowGroups.get(idx)!.push([colName, value]);
                    }
                    for (const [rowIdx, updates] of rowGroups.entries()) {
                      const row = rows[rowIdx];
                      if (!row) continue;
                      const whereClause = buildWhereClause(columns, row);
                      await updateTableRows(effectiveConnectionId, activeTab.tableName, updates, whereClause, activeTab.schemaName);
                    }
                    handleExecute();
                  }}
                  onDeleteRows={async (rowIndices) => {
                    if (!activeTab?.tableName || !effectiveConnectionId) return;
                    const msg = t('table.deleteConfirm', { count: String(rowIndices.length) });
                    if (!window.confirm(msg)) return;
                    for (const idx of rowIndices) {
                      const row = result?.rows[idx];
                      if (!row) continue;
                      const whereClause = buildWhereClause(result!.columns, row);
                      await deleteTableRows(effectiveConnectionId, activeTab.tableName, whereClause, activeTab.schemaName);
                    }
                    handleExecute();
                  }}
                  onGenerateDeleteSQL={(rowIndices) => {
                    const statements = rowIndices.map(idx => {
                      const row = result?.rows[idx];
                      if (!row) return '';
                      const whereClause = buildWhereClause(result!.columns, row);
                      const schemaPrefix = activeTab?.schemaName ? `"${activeTab.schemaName}".` : '';
                      return `DELETE FROM ${schemaPrefix}"${activeTab?.tableName || 'table'}" WHERE ${whereClause};`;
                    }).filter(Boolean).join('\n');
                    if (!statements) return;
                    const editor = editorRef.current;
                    if (editor) {
                      const selection = editor.getSelection();
                      editor.executeEdits('delete-sql', [{
                        range: selection || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
                        text: statements + '\n',
                      }]);
                    }
                  }}
                  onGenerateChart={handleGenerateChart}
                />
              )}
              {resultTab === "messages" && (
                <div className="p-3 space-y-2 overflow-auto">
                  {/* Summary */}
                  {executionTime !== null && (
                    <div className="text-xs text-muted-foreground space-y-1 mb-3 pb-3 border-b border-border">
                      <p>{t('editor.totalTime', { ms: executionTime.toFixed(0) })}</p>
                      {multiResults.length > 0 && (
                        <p>{t('editor.resultCount', { suffix: `: ${multiResults.map(r => r.rowCount).join(', ')}` })}</p>
                      )}
                    </div>
                  )}
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

      {chartPanel && (
        <QuickChartPanel
          columns={chartPanel.columns}
          rows={chartPanel.rows}
          onClose={() => setChartPanel(null)}
        />
      )}
    </div>
  );
}

// ===== Virtualized Table Body =====

const COL_MIN_WIDTH = 120;

interface TableContextMenuProps {
  x: number;
  y: number;
  selectedCount: number;
  hasSelection: boolean;
  canEdit: boolean;
  onClose: () => void;
  onCopyRows: () => void;
  onCopyAsMarkdown: () => void;
  onExportCSV: () => void;
  onExportJSON: () => void;
  onExportSQL: () => void;
  onEditRow: () => void;
  onDeleteRows: () => void;
  onGenerateDeleteSQL: () => void;
  onGenerateChart?: () => void;
}

function TableContextMenu({
  x, y, selectedCount, hasSelection, canEdit, onClose,
  onCopyRows, onCopyAsMarkdown, onExportCSV, onExportJSON, onExportSQL,
  onEditRow, onDeleteRows, onGenerateDeleteSQL, onGenerateChart,
}: TableContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let ax = x, ay = y;
      if (x + rect.width > window.innerWidth) ax = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight) ay = window.innerHeight - rect.height - 4;
      setPos({ x: ax, y: ay });
    }
  }, [x, y]);

  const item = (label: string, onClick: () => void, icon: React.ReactNode, disabled?: boolean, destructive?: boolean) => (
    <button
      onClick={() => { if (!disabled) { onClick(); onClose(); } }}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${
        destructive ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-muted'
      }`}
    >
      <span className="w-4 flex items-center justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {selectedCount > 0 && (
        <span className="text-[11px] text-muted-foreground ml-2">{selectedCount}</span>
      )}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[200px]"
        style={{ left: pos.x, top: pos.y, backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
      >
        {item(t('table.copyRows'), onCopyRows, <Copy size={12} />, !hasSelection)}
        {item(t('table.copyAsMarkdown'), onCopyAsMarkdown, <Copy size={12} />, !hasSelection)}
        <div className="border-t border-border my-1" />
        {item(t('table.exportCSV'), onExportCSV, <Database size={12} />, !hasSelection)}
        {item(t('table.exportJSON'), onExportJSON, <Code2 size={12} />, !hasSelection)}
        {item(t('table.exportSQL'), onExportSQL, <Database size={12} />, !hasSelection)}
        {item(t('table.generateChart'), () => onGenerateChart?.(), <BarChart3 size={12} />, !hasSelection)}
        <div className="border-t border-border my-1" />
        {item(t('table.editRow'), onEditRow, <TextCursorInput size={12} />, !canEdit || selectedCount !== 1)}
        {item(t('table.generateDeleteSQL'), onGenerateDeleteSQL, <Code2 size={12} />, !canEdit || !hasSelection)}
        {item(t('table.deleteRows'), onDeleteRows, <XCircle size={12} />, !canEdit || !hasSelection, true)}
      </div>
    </>
  );
}

function VirtualTableBody({
  rows, columns, virtualCount, hasMore, isLoadingMore, onLoadMore,
  onSelectionChange,
  onModifiedCellsChange,
  onDeleteRows,
  onGenerateDeleteSQL,
  onGenerateChart,
  discardRef,
  selectedRowsRef,
  sortConfig,
  onSort,
}: {
  rows: any[];
  columns: any[];
  virtualCount: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onSelectionChange?: (indices: number[]) => void;
  onModifiedCellsChange?: (count: number, getCells: () => Map<string, any>) => void;
  onDeleteRows?: () => void;
  onGenerateDeleteSQL?: () => void;
  onGenerateChart?: () => void;
  discardRef?: React.MutableRefObject<(() => void) | null>;
  selectedRowsRef?: React.MutableRefObject<Set<number> | null>;
  sortConfig?: { key: string; direction: 'asc' | 'desc' } | null;
  onSort?: (key: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colName: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [modifiedCells, setModifiedCells] = useState<Map<string, any>>(new Map());
  const editInputRef = useRef<HTMLInputElement>(null);
  const suppressBlurRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Auto-focus and select input when editing starts
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Reset selection and edit state when result set changes
  useEffect(() => {
    setSelectedRows(new Set());
    setLastClickedIdx(null);
    setModifiedCells(new Map());
    setEditingCell(null);
    setEditValue('');
    setContextMenu(null);
  }, [rows]);

  // Notify parent of modified cells changes
  useEffect(() => {
    onModifiedCellsChange?.(modifiedCells.size, () => modifiedCells);
  }, [modifiedCells, onModifiedCellsChange]);

  // Expose discard function to parent
  if (discardRef) {
    discardRef.current = () => {
      setModifiedCells(new Map());
      setEditingCell(null);
      setEditValue('');
    };
  }

  // Expose selected rows to parent for delete callbacks
  if (selectedRowsRef) {
    selectedRowsRef.current = selectedRows;
  }

  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 15,
  });

  // Trigger load-more when last items come into view
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    if (!lastItem) return;
    const lastIdx = lastItem.index;
    if (lastIdx >= rows.length - 5 && hasMore && !isLoadingMore) {
      onLoadMore();
    }
  }, [virtualizer.getVirtualItems(), rows.length, hasMore, isLoadingMore, onLoadMore]);

  // Notify parent of selection changes
  useEffect(() => {
    onSelectionChange?.(Array.from(selectedRows));
  }, [selectedRows, onSelectionChange]);

  // Close context menu on Escape key
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu]);

  const toggleRow = useCallback((idx: number, ctrl: boolean, shift: boolean) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (shift && lastClickedIdx !== null && lastClickedIdx !== idx) {
        const from = Math.min(lastClickedIdx, idx);
        const to = Math.max(lastClickedIdx, idx);
        for (let i = from; i <= to; i++) next.add(i);
      } else if (ctrl) {
        if (next.has(idx)) { next.delete(idx); } else { next.add(idx); }
      } else {
        next.clear();
        next.add(idx);
      }
      return next;
    });
    setLastClickedIdx(idx);
  }, [lastClickedIdx]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const firstItem = virtualItems[0];
  const lastItem = virtualItems[virtualItems.length - 1];
  const beforeHeight = firstItem ? firstItem.start : 0;
  const afterHeight = totalSize - (lastItem ? lastItem.end : 0);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <table
        className="text-xs border-collapse border"
        style={{ tableLayout: 'fixed', width: '100%', minWidth: 36 + columns.length * COL_MIN_WIDTH }}
      >
        <thead className="sticky top-0 z-10">
          <tr>
            <th
              className="px-1.5 py-1.5 text-center font-medium text-white/50 border border-white/30"
              style={{ backgroundColor: 'hsl(var(--tab-active))', width: 36, minWidth: 36 }}
            >
              #
            </th>
            {columns.map((col: any) => (
              <th
                key={col.name}
                className="px-3 py-1.5 text-left font-medium text-white border border-white/30 cursor-pointer hover:bg-white/10 transition-colors select-none"
                style={{ backgroundColor: 'hsl(var(--tab-active))', minWidth: COL_MIN_WIDTH }}
                onClick={() => onSort?.(col.name)}
              >
                <div className="flex items-center gap-1 overflow-hidden">
                  <span className="truncate">{col.name}</span>
                  {sortConfig && sortConfig.key === col.name && (
                    <span className="text-white shrink-0">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                  )}
                  {col.isPrimaryKey && (
                    <span className="text-[11px] px-0.5 rounded bg-white/20 text-white shrink-0">PK</span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Top spacer row for virtual scroll offset */}
          {beforeHeight > 0 && (
            <tr style={{ height: beforeHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
          {virtualItems.map((virtualRow) => {
            if (virtualRow.index >= rows.length) {
              return (
                <tr key="sentinel" style={{ height: 28 }}>
                  <td colSpan={columns.length + 1} className="border">
                    <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                      {isLoadingMore && <Loader2 size={12} className="animate-spin" />}
                      {isLoadingMore ? 'Loading...' : 'Scroll for more...'}
                    </div>
                  </td>
                </tr>
              );
            }
            const row = rows[virtualRow.index];
            const rowIdx = virtualRow.index;
            const isSelected = selectedRows.has(rowIdx);
            return (
              <tr
                key={virtualRow.key}
                className={`hover:bg-accent transition-colors even:bg-muted/60 ${isSelected ? 'ring-1 ring-inset ring-blue-400' : ''}`}
                style={{ height: 28, backgroundColor: isSelected ? 'hsl(var(--accent))' : undefined }}
                onClick={(e) => {
                  e.preventDefault();
                  toggleRow(rowIdx, e.ctrlKey || e.metaKey, e.shiftKey);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selectedRows.has(rowIdx)) {
                    setSelectedRows(new Set([rowIdx]));
                    setLastClickedIdx(rowIdx);
                  }
                  setContextMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                <td
                  className="px-1.5 py-1 text-center border text-muted-foreground select-none"
                  style={{ width: 36, minWidth: 36, fontSize: 10, cursor: 'pointer' }}
                >
                  {rowIdx + 1}
                </td>
                {columns.map((col: any) => {
                  const cellKey = `${rowIdx}:${col.name}`;
                  const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.colName === col.name;
                  const modifiedValue = modifiedCells.get(cellKey);
                  const displayValue = modifiedValue !== undefined ? modifiedValue : row[col.name];
                  const isModified = modifiedCells.has(cellKey);

                  if (isEditing) {
                    return (
                      <td
                        key={col.name}
                        className="px-0 py-0 border border-orange-400"
                        style={{ minWidth: COL_MIN_WIDTH, boxShadow: 'inset 0 0 0 1px #f97316' }}
                      >
                        <input
                          ref={editInputRef}
                          className="w-full h-full px-3 py-1 text-xs bg-orange-50 dark:bg-orange-950/40 text-foreground outline-none"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const originalVal = row[col.name];
                              if (editValue !== String(originalVal ?? '')) {
                                setModifiedCells((prev) => {
                                  const next = new Map(prev);
                                  next.set(cellKey, editValue === 'NULL' ? null : editValue);
                                  return next;
                                });
                              }
                              suppressBlurRef.current = true;
                              setEditingCell(null);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              suppressBlurRef.current = true;
                              setEditingCell(null);
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              const originalVal = row[col.name];
                              if (editValue !== String(originalVal ?? '')) {
                                setModifiedCells((prev) => {
                                  const next = new Map(prev);
                                  next.set(cellKey, editValue === 'NULL' ? null : editValue);
                                  return next;
                                });
                              }
                              setEditingCell(null);
                              const colIdx = columns.findIndex((c: any) => c.name === col.name);
                              if (e.shiftKey) {
                                if (colIdx > 0) {
                                  const prevCol = columns[colIdx - 1];
                                  setTimeout(() => {
                                    setEditingCell({ rowIdx, colName: prevCol.name });
                                    setEditValue(String(modifiedCells.get(`${rowIdx}:${prevCol.name}`) ?? row[prevCol.name] ?? ''));
                                  }, 0);
                                }
                              } else {
                                if (colIdx < columns.length - 1) {
                                  const nextCol = columns[colIdx + 1];
                                  setTimeout(() => {
                                    setEditingCell({ rowIdx, colName: nextCol.name });
                                    setEditValue(String(modifiedCells.get(`${rowIdx}:${nextCol.name}`) ?? row[nextCol.name] ?? ''));
                                  }, 0);
                                }
                              }
                            }
                          }}
                          onBlur={() => {
                            if (suppressBlurRef.current) {
                              suppressBlurRef.current = false;
                              setEditingCell(null);
                              return;
                            }
                            const originalVal = row[col.name];
                            if (editValue !== String(originalVal ?? '')) {
                              setModifiedCells((prev) => {
                                const next = new Map(prev);
                                next.set(cellKey, editValue === 'NULL' ? null : editValue);
                                return next;
                              });
                            }
                            setEditingCell(null);
                          }}
                        />
                      </td>
                    );
                  }

                  return (
                    <td
                      key={col.name}
                      className={`px-3 py-1 whitespace-nowrap truncate border transition-colors ${isModified ? 'bg-orange-500/25 dark:bg-orange-500/20 ring-1 ring-inset ring-orange-500/70 shadow-[inset_3px_0_0_0_#f97316]' : 'hover:bg-muted/50'}`}
                      style={{ minWidth: COL_MIN_WIDTH, cursor: 'cell' }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const currentVal = modifiedCells.get(cellKey);
                        const val = currentVal !== undefined ? currentVal : row[col.name];
                        setEditValue(val === null ? '' : String(val));
                        setEditingCell({ rowIdx, colName: col.name });
                      }}
                    >
                      <span className={displayValue === null ? "text-muted-foreground/40 italic" : "text-foreground"}>
                        {displayValue === null ? "NULL" : String(displayValue)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {/* Bottom spacer row for virtual scroll offset */}
          {afterHeight > 0 && (
            <tr style={{ height: afterHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
      {contextMenu && (
        <TableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedCount={selectedRows.size}
          hasSelection={selectedRows.size > 0}
          canEdit={onSelectionChange != null}
          onClose={() => setContextMenu(null)}
          onCopyRows={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i]);
            const text = selectedData.map(row =>
              columns.map((c: any) => String(row[c.name] ?? '')).join('\t')
            ).join('\n');
            navigator.clipboard.writeText(text);
          }}
          onCopyAsMarkdown={async () => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i]);
            const md = rowsToMarkdown(columns, selectedData);
            await navigator.clipboard.writeText(md);
          }}
          onExportCSV={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i]);
            const csv = exportToCSV(columns, selectedData);
            downloadFile(csv, 'selected_export.csv', 'text/csv');
          }}
          onExportJSON={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i]);
            const json = exportToJSON(columns, selectedData);
            downloadFile(json, 'selected_export.json', 'application/json');
          }}
          onExportSQL={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i]);
            const sql = exportToSQL(columns, selectedData, 'selected_data');
            downloadFile(sql, 'selected_export.sql', 'text/plain');
          }}
          onEditRow={() => {
            const idx = Array.from(selectedRows).sort((a, b) => a - b)[0];
            if (idx !== undefined && idx < rows.length && columns.length > 0) {
              const col = columns[0];
              const val = rows[idx][col.name];
              setEditValue(val === null ? '' : String(val));
              setEditingCell({ rowIdx: idx, colName: col.name });
            }
          }}
          onDeleteRows={() => {
            onDeleteRows?.();
          }}
          onGenerateDeleteSQL={() => {
            onGenerateDeleteSQL?.();
          }}
          onGenerateChart={() => {
            onGenerateChart?.();
          }}
        />
      )}
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
  onApplyChanges?: (modifiedCells: Map<string, any>, columns: any[], rows: any[]) => void;
  onDeleteRows?: (rowIndices: number[]) => void;
  onGenerateDeleteSQL?: (rowIndices: number[]) => void;
  onGenerateChart?: () => void;
}

function ResultTable({ result, importPreview, hasMore, isLoadingMore, onLoadMore, onApplyChanges, onDeleteRows, onGenerateDeleteSQL, onGenerateChart }: ResultTableProps) {
  const [modifiedCount, setModifiedCount] = useState(0);
  const modifiedCellsRef = useRef<() => Map<string, any>>(() => new Map());
  const discardRef = useRef<(() => void) | null>(null);
  const selectedRowsRef = useRef<Set<number> | null>(new Set());
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const handleModifiedCellsChange = useCallback((count: number, getCells: () => Map<string, any>) => {
    setModifiedCount(count);
    modifiedCellsRef.current = getCells;
  }, []);
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
                  className="px-3 py-1.5 text-left font-medium text-white border border-white/30"
                  style={{ minWidth: 120, maxWidth: 300 }}
                >
                  <span className="truncate block">{col}</span>
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

  const { columns, rows: unsortedRows } = result;
  const rows = sortConfig
    ? [...unsortedRows].sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;
        if (typeof aVal === 'number' && typeof bVal === 'number') return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
        const aStr = String(aVal);
        const bStr = String(bVal);
        return sortConfig.direction === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
      })
    : unsortedRows;
  const virtualCount = rows.length + (hasMore ? 1 : 0);

  return (
    <div className="flex flex-col h-full">
      <VirtualTableBody
        rows={rows}
        columns={columns}
        virtualCount={virtualCount}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={onLoadMore}
        onModifiedCellsChange={handleModifiedCellsChange}
        onDeleteRows={() => onDeleteRows?.(Array.from(selectedRowsRef.current ?? new Set()))}
        onGenerateDeleteSQL={() => onGenerateDeleteSQL?.(Array.from(selectedRowsRef.current ?? new Set()))}
        onGenerateChart={onGenerateChart}
        discardRef={discardRef}
        selectedRowsRef={selectedRowsRef}
        sortConfig={sortConfig}
        onSort={(key) => setSortConfig(prev => prev?.key === key && prev.direction === 'asc' ? { key, direction: 'desc' } : prev?.key === key ? null : { key, direction: 'asc' })}
      />
      {/* Apply Changes toolbar */}
      {modifiedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border shrink-0 bg-orange-500/10">
          <span className="text-xs text-muted-foreground">
            {t('table.changesPending', { count: String(modifiedCount) })}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => discardRef.current?.()}
            className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('table.discardChanges')}
          </button>
          <button
            onClick={() => onApplyChanges?.(modifiedCellsRef.current(), columns, rows)}
            className="px-3 py-0.5 text-xs text-white rounded transition-colors"
            style={{ backgroundColor: 'hsl(var(--tab-active))' }}
          >
            {t('table.applyChanges')}
          </button>
        </div>
      )}
      {/* Bottom status bar */}
      <div className="flex items-center px-3 py-1 border-t border-border shrink-0 bg-muted/20 text-xs text-muted-foreground gap-2">
        {rows.length > 0 && (
          <span>
            {hasMore
              ? `${t('scroll.rowsLoaded', { count: String(rows.length) })} — ${t('scroll.scrollForMore')}`
              : t('scroll.allLoaded', { count: String(rows.length) })
            }
          </span>
        )}
        {rows.length >= 10000 && !hasMore && (
          <span className="text-warning">({t('scroll.rowLimitReached')})</span>
        )}
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
          <kbd className="px-1 py-0.5 bg-muted rounded text-[11px]">Ctrl+N</kbd>{" "}
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
        <span className="text-[11px] text-muted-foreground ml-4">{shortcut}</span>
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
