// Re-export sub-stores as the primary import surface.
// Components should import directly from sub-stores for minimal re-renders.
export { useConnectionStore } from "./modules/connection";
export { useTabStore } from "./modules/tab";
export { useUIStore } from "./modules/ui";
export { useHistoryStore } from "./modules/history";

// Re-export types for convenience
export * from "./modules/connection";
export * from "./modules/tab";
export * from "./modules/ui";
export * from "./modules/history";

import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "./modules/connection";
import { useTabStore } from "./modules/tab";
import { useUIStore } from "./modules/ui";
import { useHistoryStore } from "./modules/history";

/**
 * Lightweight combined hook for components that need slices from multiple stores.
 * Uses useShallow to only trigger re-renders when the selected slice actually changes.
 */
export function useAppStore() {
  const conn = useConnectionStore(
    useShallow((s) => ({
      connections: s.connections,
      activeConnectionId: s.activeConnectionId,
      transactionActive: s.transactionActive,
      addConnection: s.addConnection,
      setConnections: s.setConnections,
      updateConnection: s.updateConnection,
      removeConnection: s.removeConnection,
      setActiveConnection: s.setActiveConnection,
      setTransactionActive: s.setTransactionActive,
    }))
  );

  const tab = useTabStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      queryResults: s.queryResults,
      isExecuting: s.isExecuting,
      addTab: s.addTab,
      closeTab: s.closeTab,
      setActiveTab: s.setActiveTab,
      updateTabContent: s.updateTabContent,
      setQueryResult: s.setQueryResult,
      setIsExecuting: s.setIsExecuting,
    }))
  );

  const ui = useUIStore(
    useShallow((s) => ({
      aiPanelOpen: s.aiPanelOpen,
      theme: s.theme,
      language: s.language,
      sidebarOpen: s.sidebarOpen,
      resultPanelOpen: s.resultPanelOpen,
      snippetPanelOpen: s.snippetPanelOpen,
      activeNavicatTab: s.activeNavicatTab,
      viewModeType: s.viewModeType,
      selectedSchemaId: s.selectedSchemaId,
      selectedSchemaName: s.selectedSchemaName,
      selectedTableId: s.selectedTableId,
      selectedTable: s.selectedTable,
      selectedTableData: s.selectedTableData,
      selectedTableDDL: s.selectedTableDDL,
      schemaData: s.schemaData,
      selectedContext: s.selectedContext,
      toggleAIPanel: s.toggleAIPanel,
      toggleTheme: s.toggleTheme,
      setLanguage: s.setLanguage,
      toggleSidebar: s.toggleSidebar,
      toggleResultPanel: s.toggleResultPanel,
      setResultPanelOpen: s.setResultPanelOpen,
      toggleSnippetPanel: s.toggleSnippetPanel,
      setActiveNavicatTab: s.setActiveNavicatTab,
      setViewModeType: s.setViewModeType,
      setSelectedSchemaId: s.setSelectedSchemaId,
      setSelectedSchemaName: s.setSelectedSchemaName,
      setSelectedTableId: s.setSelectedTableId,
      setSelectedTable: s.setSelectedTable,
      setSelectedTableData: s.setSelectedTableData,
      setSelectedTableDDL: s.setSelectedTableDDL,
      setSchemaData: s.setSchemaData,
      setSelectedContext: s.setSelectedContext,
      updateSchemaChildren: s.updateSchemaChildren,
    }))
  );

  const history = useHistoryStore(
    useShallow((s) => ({
      queryHistory: s.queryHistory,
      slowQueryLog: s.slowQueryLog,
      slowQueryThreshold: s.slowQueryThreshold,
      addQueryHistory: s.addQueryHistory,
      clearQueryHistory: s.clearQueryHistory,
      addSlowQuery: s.addSlowQuery,
      clearSlowQueries: s.clearSlowQueries,
      setSlowQueryThreshold: s.setSlowQueryThreshold,
    }))
  );

  return { ...conn, ...tab, ...ui, ...history };
}
