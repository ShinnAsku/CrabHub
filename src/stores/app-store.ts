import { create } from "zustand";
import { setLanguage as setI18nLanguage, initLanguage as initI18nLanguage, type Language } from "@/lib/i18n";

// ===== Exported Types =====

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface SchemaNode {
  id: string;
  name: string;
  type: "schema" | "table" | "view" | "column" | "function" | "materialized_view" | "role" | "backup";
  schema?: string;
  icon?: string;
  children?: SchemaNode[];
}

export type NavicatTab = "tables" | "views" | "materialized_views" | "functions" | "roles" | "other" | "queries" | "backups";

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Record<string, any>[];
  rowCount: number;
  executionTime: number;
}

export interface ExecuteResult {
  success: boolean;
  message: string;
  affectedRows?: number;
  executionTime?: number;
}

export interface TableInfo {
  name: string;
  schema?: string;
  type: "table" | "view";
}

export interface ConnectionConfig {
  id?: string;
  name: string;
  type: Connection["type"];
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  sslEnabled: boolean;
  keepaliveInterval?: number;
  autoReconnect?: boolean;
  filePath?: string;
}

export interface ConnectionHealth {
  healthy: boolean;
  reconnectCount: number;
  lastHeartbeat: string;
}

export interface Connection {
  id: string;
  name: string;
  type: "postgresql" | "mysql" | "sqlite" | "mssql" | "clickhouse" | "gaussdb";
  host: string;
  port: number;
  username: string;
  password?: string;
  database?: string;
  sslEnabled: boolean;
  keepaliveInterval: number;
  autoReconnect: boolean;
  connected: boolean;
  color: string;
  health?: ConnectionHealth;
}

export interface Tab {
  id: string;
  title: string;
  type: "query" | "table" | "er_diagram" | "schema_diff" | "settings" | "table_designer" | "query_analyzer";
  content: string;
  connectionId?: string;
  modified: boolean;
}

export interface SlowQuery {
  id: string;
  sql: string;
  executionTime: number;
  timestamp: number;
  connectionName: string;
  connectionId: string;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  executionTime: number;
  timestamp: number;
  success: boolean;
}

// ===== App State =====

interface AppState {
  connections: Connection[];
  tabs: Tab[];
  activeTabId: string | null;
  aiPanelOpen: boolean;
  theme: "light" | "dark";
  language: Language;

  // New state
  queryResults: Record<string, QueryResult>;
  schemaData: Record<string, SchemaNode[]>;
  activeConnectionId: string | null;
  isExecuting: boolean;

  // Navicat-style state
  activeNavicatTab: NavicatTab;
  selectedSchemaId: string | null;
  selectedSchemaName: string | undefined;
  selectedTableId: string | null;
  selectedTable: SchemaNode | null;
  selectedTableData: QueryResult | null;
  selectedTableDDL: string;

  // Query history
  queryHistory: QueryHistoryEntry[];

  // Transaction state per connection
  transactionActive: Record<string, boolean>;

  // Sidebar open state
  sidebarOpen: boolean;

  // Result panel collapsed state
  resultPanelOpen: boolean;

  // Snippet panel open state
  snippetPanelOpen: boolean;

  // Slow query tracking
  slowQueryLog: SlowQuery[];
  slowQueryThreshold: number;

  // Existing actions
  addTab: (tab: Omit<Tab, "id">) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  toggleAIPanel: () => void;
  toggleTheme: () => void;
  setLanguage: (lang: Language) => void;
  addConnection: (conn: Omit<Connection, "id"> & { id?: string }) => void;
  setConnections: (connections: Connection[]) => void;
  updateTabContent: (id: string, content: string) => void;

  // New actions
  setActiveConnection: (id: string | null) => void;
  setQueryResult: (tabId: string, result: QueryResult) => void;
  setSchemaData: (connectionId: string, data: SchemaNode[]) => void;
  setIsExecuting: (v: boolean) => void;
  updateConnection: (id: string, updates: Partial<Connection>) => void;
  removeConnection: (id: string) => void;

  // Query history actions
  addQueryHistory: (entry: Omit<QueryHistoryEntry, "id">) => void;
  clearQueryHistory: () => void;

  // Transaction actions
  setTransactionActive: (connectionId: string, active: boolean) => void;

  // Sidebar actions
  toggleSidebar: () => void;

  // Result panel actions
  toggleResultPanel: () => void;
  setResultPanelOpen: (open: boolean) => void;

  // Snippet panel actions
  toggleSnippetPanel: () => void;

  // Slow query actions
  addSlowQuery: (query: Omit<SlowQuery, "id">) => void;
  clearSlowQueries: () => void;
  setSlowQueryThreshold: (ms: number) => void;

  // Navicat-style actions
  setActiveNavicatTab: (tab: NavicatTab) => void;
  setSelectedSchemaId: (id: string | null) => void;
  setSelectedSchemaName: (name: string | undefined) => void;
  setSelectedTableId: (id: string | null) => void;
  setSelectedTable: (table: SchemaNode | null) => void;
  setSelectedTableData: (data: QueryResult | null) => void;
  setSelectedTableDDL: (ddl: string) => void;
}

let tabCounter = 0;
let connCounter = 0;
let historyCounter = 0;

// Load theme from localStorage
function loadTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("opendb-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

// Apply theme class to document
function applyThemeClass(theme: "light" | "dark") {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// Initialize language from localStorage
const initialLanguage = initI18nLanguage();

// Load initial theme and apply
const initialTheme = loadTheme();
applyThemeClass(initialTheme);

// Load query history from localStorage
function loadQueryHistory(): QueryHistoryEntry[] {
  try {
    const saved = localStorage.getItem("opendb-query-history");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return [];
}

// Save query history to localStorage
function saveQueryHistory(history: QueryHistoryEntry[]) {
  try {
    localStorage.setItem("opendb-query-history", JSON.stringify(history));
  } catch {
    // ignore
  }
}

// Load slow query log from localStorage
function loadSlowQueryLog(): SlowQuery[] {
  try {
    const saved = localStorage.getItem("opendb-slow-queries");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return [];
}

// Save slow query log to localStorage
function saveSlowQueryLog(log: SlowQuery[]) {
  try {
    localStorage.setItem("opendb-slow-queries", JSON.stringify(log));
  } catch {
    // ignore
  }
}

// Load slow query threshold from localStorage
function loadSlowQueryThreshold(): number {
  try {
    const saved = localStorage.getItem("opendb-slow-query-threshold");
    if (saved) {
      const val = parseInt(saved, 10);
      if (!isNaN(val) && val >= 0) return val;
    }
  } catch {
    // ignore
  }
  return 1000; // default: 1000ms
}

export const useAppStore = create<AppState>((set) => ({
  connections: [],
  tabs: [],
  activeTabId: null,
  aiPanelOpen: false,
  theme: initialTheme,
  language: initialLanguage,

  // New state defaults
  queryResults: {},
  schemaData: {},
  activeConnectionId: null,
  isExecuting: false,

  // Navicat-style state defaults
  activeNavicatTab: "tables",
  selectedSchemaId: null,
  selectedSchemaName: undefined,
  selectedTableId: null,
  selectedTable: null,
  selectedTableData: null,
  selectedTableDDL: "",

  // Query history
  queryHistory: loadQueryHistory(),

  // Transaction state
  transactionActive: {},

  // Sidebar state
  sidebarOpen: true,

  // Result panel state
  resultPanelOpen: true,

  // Snippet panel state
  snippetPanelOpen: false,

  // Slow query state
  slowQueryLog: loadSlowQueryLog(),
  slowQueryThreshold: loadSlowQueryThreshold(),

  // ===== Existing Actions =====

  addTab: (tab) =>
    set((state) => {
      tabCounter++;
      const newTab: Tab = { ...tab, id: `tab-${tabCounter}` };
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        newActiveId =
          newTabs.length > 0
            ? newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
            : null;
      }
      // Clean up query results for closed tab
      const newQueryResults = { ...state.queryResults };
      delete newQueryResults[id];
      return { tabs: newTabs, activeTabId: newActiveId, queryResults: newQueryResults };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  toggleAIPanel: () =>
    set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),

  toggleTheme: () =>
    set((state) => {
      const newTheme = state.theme === "dark" ? "light" : "dark";
      applyThemeClass(newTheme);
      try { localStorage.setItem("opendb-theme", newTheme); } catch {}
      return { theme: newTheme };
    }),

  setLanguage: (lang) =>
    set(() => {
      setI18nLanguage(lang);
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      return { language: lang };
    }),

  addConnection: (conn) =>
    set((state) => {
      connCounter++;
      const id = conn.id || `conn-${connCounter}`;
      const newConn: Connection = {
        ...conn,
        id,
        connected: true,
        keepaliveInterval: conn.keepaliveInterval ?? 30,
        autoReconnect: conn.autoReconnect ?? true,
      };
      return { connections: [...state.connections, newConn] };
    }),

  setConnections: (connections) => set({ connections }),

  updateTabContent: (id, content) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, modified: true } : t
      ),
    })),

  // ===== New Actions =====

  setActiveConnection: (id) => set({ activeConnectionId: id }),

  setQueryResult: (tabId, result) =>
    set((state) => ({
      queryResults: { ...state.queryResults, [tabId]: result },
    })),

  setSchemaData: (connectionId, data) =>
    set((state) => ({
      schemaData: { ...state.schemaData, [connectionId]: data },
    })),

  setIsExecuting: (v) => set({ isExecuting: v }),

  updateConnection: (id, updates) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    })),

  removeConnection: (id) =>
    set((state) => {
      const newConnections = state.connections.filter((c) => c.id !== id);
      const newSchemaData = { ...state.schemaData };
      delete newSchemaData[id];
      return {
        connections: newConnections,
        schemaData: newSchemaData,
        activeConnectionId:
          state.activeConnectionId === id ? null : state.activeConnectionId,
      };
    }),

  // ===== Query History Actions =====

  addQueryHistory: (entry) =>
    set((state) => {
      historyCounter++;
      const newEntry: QueryHistoryEntry = { ...entry, id: `hist-${historyCounter}` };
      const newHistory = [newEntry, ...state.queryHistory].slice(0, 100);
      saveQueryHistory(newHistory);
      return { queryHistory: newHistory };
    }),

  clearQueryHistory: () =>
    set(() => {
      saveQueryHistory([]);
      return { queryHistory: [] };
    }),

  // ===== Transaction Actions =====

  setTransactionActive: (connectionId, active) =>
    set((state) => ({
      transactionActive: { ...state.transactionActive, [connectionId]: active },
    })),

  // ===== Sidebar Actions =====

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  // ===== Result Panel Actions =====

  toggleResultPanel: () =>
    set((state) => ({ resultPanelOpen: !state.resultPanelOpen })),

  setResultPanelOpen: (open) =>
    set({ resultPanelOpen: open }),

  // ===== Snippet Panel Actions =====

  toggleSnippetPanel: () =>
    set((state) => ({ snippetPanelOpen: !state.snippetPanelOpen })),

  // ===== Slow Query Actions =====

  addSlowQuery: (query) =>
    set((state) => {
      const id = `slow-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const newEntry: SlowQuery = { ...query, id };
      const newLog = [newEntry, ...state.slowQueryLog].slice(0, 200);
      saveSlowQueryLog(newLog);
      return { slowQueryLog: newLog };
    }),

  clearSlowQueries: () =>
    set(() => {
      saveSlowQueryLog([]);
      return { slowQueryLog: [] };
    }),

  setSlowQueryThreshold: (ms) =>
    set(() => {
      try { localStorage.setItem("opendb-slow-query-threshold", String(ms)); } catch {}
      return { slowQueryThreshold: ms };
    }),

  // ===== Navicat-style Actions =====

  setActiveNavicatTab: (tab) => set({ activeNavicatTab: tab }),
  setSelectedSchemaId: (id) => set({ selectedSchemaId: id }),
  setSelectedSchemaName: (name) => set({ selectedSchemaName: name }),
  setSelectedTableId: (id) => set({ selectedTableId: id }),
  setSelectedTable: (table) => set({ selectedTable: table }),
  setSelectedTableData: (data) => set({ selectedTableData: data }),
  setSelectedTableDDL: (ddl) => set({ selectedTableDDL: ddl }),
}));
