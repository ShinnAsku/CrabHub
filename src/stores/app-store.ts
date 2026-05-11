// Import types from modules
export * from "./modules/connection";
export * from "./modules/tab";
export * from "./modules/ui";
export * from "./modules/history";

// Re-export stores for backward compatibility
export { useConnectionStore } from "./modules/connection";
export { useTabStore } from "./modules/tab";
export { useUIStore } from "./modules/ui";
export { useHistoryStore } from "./modules/history";

// Create a reactive combined store using subscribe pattern
import { create } from "zustand";
import { useConnectionStore } from "./modules/connection";
import { useTabStore } from "./modules/tab";
import { useUIStore } from "./modules/ui";
import { useHistoryStore } from "./modules/history";
import type { Connection, Tab, QueryResult, SchemaNode, TableInfo, QueryHistoryEntry, SlowQueryEntry, SelectedContext } from '@/types';
import type { NavicatTab } from "./modules/ui";
import type { Language } from "@/lib/i18n";

// Combined store interface
interface CombinedAppState {
  // Connection state
  connections: Connection[];
  activeConnectionId: string | null;
  transactionActive: Record<string, boolean>;

  // Tab state
  tabs: Tab[];
  activeTabId: string | null;
  queryResults: Record<string, QueryResult>;
  isExecuting: boolean;

  // UI state
  aiPanelOpen: boolean;
  theme: "light" | "dark";
  language: Language;
  sidebarOpen: boolean;
  resultPanelOpen: boolean;
  snippetPanelOpen: boolean;
  activeNavicatTab: NavicatTab;
  viewModeType: "navicat" | "query";
  selectedSchemaId: string | null;
  selectedSchemaName: string | undefined;
  selectedTableId: string | null;
  selectedTable: TableInfo | null;
  selectedTableData: QueryResult | null;
  selectedTableDDL: string;
  schemaData: Record<string, SchemaNode[]>;
  selectedContext: SelectedContext | null;

  // History state
  queryHistory: QueryHistoryEntry[];
  slowQueryLog: SlowQueryEntry[];
  slowQueryThreshold: number;

  // Connection actions
  addConnection: (conn: Omit<Connection, "id"> & { id?: string }) => void;
  setConnections: (connections: Connection[]) => void;
  updateConnection: (id: string, updates: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  setTransactionActive: (connectionId: string, active: boolean) => void;

  // Tab actions
  addTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  updateTabContent: (id: string, content: string) => void;
  setQueryResult: (tabId: string, result: QueryResult) => void;
  setIsExecuting: (v: boolean) => void;

  // UI actions
  toggleAIPanel: () => void;
  toggleTheme: () => void;
  setLanguage: (lang: Language) => void;
  toggleSidebar: () => void;
  toggleResultPanel: () => void;
  setResultPanelOpen: (open: boolean) => void;
  toggleSnippetPanel: () => void;
  setActiveNavicatTab: (tab: NavicatTab) => void;
  setViewModeType: (mode: "navicat" | "query") => void;
  setSelectedSchemaId: (id: string | null) => void;
  setSelectedSchemaName: (name: string | undefined) => void;
  setSelectedTableId: (id: string | null) => void;
  setSelectedTable: (table: TableInfo | null) => void;
  setSelectedTableData: (data: QueryResult | null) => void;
  setSelectedTableDDL: (ddl: string) => void;
  setSchemaData: (connectionId: string, data: SchemaNode[]) => void;
  setSelectedContext: (ctx: SelectedContext | null) => void;
  updateSchemaChildren: (connectionId: string, parentNodeId: string, children: SchemaNode[]) => void;

  // History actions
  addQueryHistory: (entry: Omit<QueryHistoryEntry, "id">) => void;
  clearQueryHistory: () => void;
  addSlowQuery: (query: Omit<SlowQueryEntry, "id">) => void;
  clearSlowQueries: () => void;
  setSlowQueryThreshold: (ms: number) => void;
}

// Helper to sync state from sub-stores
function syncState(set: (partial: Partial<CombinedAppState>) => void) {
  // Subscribe to connection store changes
  useConnectionStore.subscribe((state) => {
    set({
      connections: state.connections,
      activeConnectionId: state.activeConnectionId,
      transactionActive: state.transactionActive,
      addConnection: useConnectionStore.getState().addConnection,
      setConnections: useConnectionStore.getState().setConnections,
      updateConnection: useConnectionStore.getState().updateConnection,
      removeConnection: useConnectionStore.getState().removeConnection,
      setActiveConnection: useConnectionStore.getState().setActiveConnection,
      setTransactionActive: useConnectionStore.getState().setTransactionActive,
    });
  });

  // Subscribe to tab store changes
  useTabStore.subscribe((state) => {
    set({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      queryResults: state.queryResults,
      isExecuting: state.isExecuting,
      addTab: useTabStore.getState().addTab,
      closeTab: useTabStore.getState().closeTab,
      setActiveTab: useTabStore.getState().setActiveTab,
      updateTabContent: useTabStore.getState().updateTabContent,
      setQueryResult: useTabStore.getState().setQueryResult,
      setIsExecuting: useTabStore.getState().setIsExecuting,
    });
  });

  // Subscribe to UI store changes
  useUIStore.subscribe((state) => {
    set({
      aiPanelOpen: state.aiPanelOpen,
      theme: state.theme,
      language: state.language,
      sidebarOpen: state.sidebarOpen,
      resultPanelOpen: state.resultPanelOpen,
      snippetPanelOpen: state.snippetPanelOpen,
      activeNavicatTab: state.activeNavicatTab,
      viewModeType: state.viewModeType,
      selectedSchemaId: state.selectedSchemaId,
      selectedSchemaName: state.selectedSchemaName,
      selectedTableId: state.selectedTableId,
      selectedTable: state.selectedTable,
      selectedTableData: state.selectedTableData,
      selectedTableDDL: state.selectedTableDDL,
      schemaData: state.schemaData,
      selectedContext: state.selectedContext,
      toggleAIPanel: useUIStore.getState().toggleAIPanel,
      toggleTheme: useUIStore.getState().toggleTheme,
      setLanguage: useUIStore.getState().setLanguage,
      toggleSidebar: useUIStore.getState().toggleSidebar,
      toggleResultPanel: useUIStore.getState().toggleResultPanel,
      setResultPanelOpen: useUIStore.getState().setResultPanelOpen,
      toggleSnippetPanel: useUIStore.getState().toggleSnippetPanel,
      setActiveNavicatTab: useUIStore.getState().setActiveNavicatTab,
      setViewModeType: useUIStore.getState().setViewModeType,
      setSelectedSchemaId: useUIStore.getState().setSelectedSchemaId,
      setSelectedSchemaName: useUIStore.getState().setSelectedSchemaName,
      setSelectedTableId: useUIStore.getState().setSelectedTableId,
      setSelectedTable: useUIStore.getState().setSelectedTable,
      setSelectedTableData: useUIStore.getState().setSelectedTableData,
      setSelectedTableDDL: useUIStore.getState().setSelectedTableDDL,
      setSchemaData: useUIStore.getState().setSchemaData,
      setSelectedContext: useUIStore.getState().setSelectedContext,
      updateSchemaChildren: useUIStore.getState().updateSchemaChildren,
    });
  });

  // Subscribe to history store changes
  useHistoryStore.subscribe((state) => {
    set({
      queryHistory: state.queryHistory,
      slowQueryLog: state.slowQueryLog,
      slowQueryThreshold: state.slowQueryThreshold,
      addQueryHistory: useHistoryStore.getState().addQueryHistory,
      clearQueryHistory: useHistoryStore.getState().clearQueryHistory,
      addSlowQuery: useHistoryStore.getState().addSlowQuery,
      clearSlowQueries: useHistoryStore.getState().clearSlowQueries,
      setSlowQueryThreshold: useHistoryStore.getState().setSlowQueryThreshold,
    });
  });
}

// Create the combined reactive store
export const useAppStore = create<CombinedAppState>((set) => {
  // Initialize with current state from all sub-stores
  const initialState: CombinedAppState = {
    connections: useConnectionStore.getState().connections,
    activeConnectionId: useConnectionStore.getState().activeConnectionId,
    transactionActive: useConnectionStore.getState().transactionActive,

    tabs: useTabStore.getState().tabs,
    activeTabId: useTabStore.getState().activeTabId,
    queryResults: useTabStore.getState().queryResults,
    isExecuting: useTabStore.getState().isExecuting,

    aiPanelOpen: useUIStore.getState().aiPanelOpen,
    theme: useUIStore.getState().theme,
    language: useUIStore.getState().language,
    sidebarOpen: useUIStore.getState().sidebarOpen,
    resultPanelOpen: useUIStore.getState().resultPanelOpen,
    snippetPanelOpen: useUIStore.getState().snippetPanelOpen,
    activeNavicatTab: useUIStore.getState().activeNavicatTab,
    viewModeType: useUIStore.getState().viewModeType,
    selectedSchemaId: useUIStore.getState().selectedSchemaId,
    selectedSchemaName: useUIStore.getState().selectedSchemaName,
    selectedTableId: useUIStore.getState().selectedTableId,
    selectedTable: useUIStore.getState().selectedTable,
    selectedTableData: useUIStore.getState().selectedTableData,
    selectedTableDDL: useUIStore.getState().selectedTableDDL,
    schemaData: useUIStore.getState().schemaData,
    selectedContext: useUIStore.getState().selectedContext,

    queryHistory: useHistoryStore.getState().queryHistory,
    slowQueryLog: useHistoryStore.getState().slowQueryLog,
    slowQueryThreshold: useHistoryStore.getState().slowQueryThreshold,

    // Connection actions
    addConnection: useConnectionStore.getState().addConnection,
    setConnections: useConnectionStore.getState().setConnections,
    updateConnection: useConnectionStore.getState().updateConnection,
    removeConnection: useConnectionStore.getState().removeConnection,
    setActiveConnection: useConnectionStore.getState().setActiveConnection,
    setTransactionActive: useConnectionStore.getState().setTransactionActive,

    // Tab actions
    addTab: useTabStore.getState().addTab,
    closeTab: useTabStore.getState().closeTab,
    setActiveTab: useTabStore.getState().setActiveTab,
    updateTabContent: useTabStore.getState().updateTabContent,
    setQueryResult: useTabStore.getState().setQueryResult,
    setIsExecuting: useTabStore.getState().setIsExecuting,

    // UI actions
    toggleAIPanel: useUIStore.getState().toggleAIPanel,
    toggleTheme: useUIStore.getState().toggleTheme,
    setLanguage: useUIStore.getState().setLanguage,
    toggleSidebar: useUIStore.getState().toggleSidebar,
    toggleResultPanel: useUIStore.getState().toggleResultPanel,
    setResultPanelOpen: useUIStore.getState().setResultPanelOpen,
    toggleSnippetPanel: useUIStore.getState().toggleSnippetPanel,
    setActiveNavicatTab: useUIStore.getState().setActiveNavicatTab,
    setViewModeType: useUIStore.getState().setViewModeType,
    setSelectedSchemaId: useUIStore.getState().setSelectedSchemaId,
    setSelectedSchemaName: useUIStore.getState().setSelectedSchemaName,
    setSelectedTableId: useUIStore.getState().setSelectedTableId,
    setSelectedTable: useUIStore.getState().setSelectedTable,
    setSelectedTableData: useUIStore.getState().setSelectedTableData,
    setSelectedTableDDL: useUIStore.getState().setSelectedTableDDL,
    setSchemaData: useUIStore.getState().setSchemaData,
    setSelectedContext: useUIStore.getState().setSelectedContext,
    updateSchemaChildren: useUIStore.getState().updateSchemaChildren,

    // History actions
    addQueryHistory: useHistoryStore.getState().addQueryHistory,
    clearQueryHistory: useHistoryStore.getState().clearQueryHistory,
    addSlowQuery: useHistoryStore.getState().addSlowQuery,
    clearSlowQueries: useHistoryStore.getState().clearSlowQueries,
    setSlowQueryThreshold: useHistoryStore.getState().setSlowQueryThreshold,
  };

  // Setup subscriptions to sync state from sub-stores
  syncState(set);

  return initialState;
});














