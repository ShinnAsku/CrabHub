import { useState, useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useConnectionStore, useTabStore, useUIStore } from "@/stores/app-store";
import type { Connection } from "@/types";
import { t } from "@/lib/i18n";
import Toolbar from "./Toolbar";
import Sidebar from "./Sidebar";
import OpenDbMainPanel from "./OpenDbMainPanel";
import TabBar from "./TabBar";
import EditorPanel from "./EditorPanel";
import AIPanel from "./AIPanel";
import StatusBar from "./StatusBar";
import ConnectionDialog from "./ConnectionDialog";
import SnippetPanel from "./SnippetPanel";
import SchemaDiffDialog from "./SchemaDiffDialog";
import DataMigration from "./DataMigration";
import ErrorBoundary from "./ErrorBoundary";
import ERSelectorDialog from "./ERSelectorDialog";
import ImportExportDialog from "./ImportExportDialog";
import PluginManager from "./PluginManager";
import UpdateManager from "./UpdateManager";
import MessageDialog, { showMessage } from "./MessageDialog";

function MainLayout() {
  const {
    aiPanelOpen,
    sidebarOpen,
    toggleSidebar,
    toggleAIPanel,
    snippetPanelOpen,
    toggleSnippetPanel,
    selectedSchemaName,
    viewModeType,
    setViewModeType,
  } = useUIStore();

  const {
    addTab,
    closeTab,
    activeTabId,
    tabs,
  } = useTabStore();
  
  const {
    activeConnectionId,
    connections,
  } = useConnectionStore();

  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | undefined>();
  const [schemaDiffOpen, setSchemaDiffOpen] = useState(false);
  const [dataMigrationOpen, setDataMigrationOpen] = useState(false);
  const [erSelectorOpen, setERSelectorOpen] = useState(false);
  const [importExportMode, setImportExportMode] = useState<"import" | "export" | null>(null);
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [updateManagerOpen, setUpdateManagerOpen] = useState(false);

  const handleOpenConnectionDialog = useCallback(
    (editConnection?: Connection) => {
      setEditingConnection(editConnection);
      setConnectionDialogOpen(true);
    },
    []
  );

  const handleCloseConnectionDialog = useCallback(() => {
    setConnectionDialogOpen(false);
    setEditingConnection(undefined);
  }, []);

  const handleOpenERDiagram = useCallback(() => {
    setERSelectorOpen(true);
  }, []);

  const handleERSelectorConfirm = useCallback((connectionId: string, schemaName?: string) => {
    addTab({
      title: t('layout.erDiagram'),
      titleKey: 'layout.erDiagram',
      type: "er",
      content: "",
      connectionId,
      schemaName,
    });
    setERSelectorOpen(false);
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [addTab]);

  const handleOpenQueryAnalyzer = useCallback(() => {
    addTab({
      title: t('layout.queryAnalyzer'),
      titleKey: 'layout.queryAnalyzer',
      type: "analyzer",
      content: "",
      connectionId: activeConnectionId || undefined,

    });
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [activeConnectionId, addTab]);

  // Auto-switch to navicat when no tabs remain
  useEffect(() => {
    if (tabs.length === 0 && viewModeType === "query") {
      setViewModeType("navicat");
    }
  }, [tabs.length, viewModeType, setViewModeType]);

  // Clear test connection data on startup
  useEffect(() => {
    try {
      const STORAGE_KEY = "crabhub-connections";
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Filter out test connections (those with "test" in name or host)
        const filtered = parsed.filter((conn: any) => {
          const name = (conn.name || "").toLowerCase();
          const host = (conn.host || "").toLowerCase();
          return !name.includes('test') && !host.includes('test') && !name.includes('示例') && !host.includes('示例');
        });
        if (filtered.length !== parsed.length) {
          console.log(`Cleared ${parsed.length - filtered.length} test connections`);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
          // Force reload connections in store
          useConnectionStore.getState().setConnections(filtered);
        }
      }
    } catch (e) {
      console.error("Failed to clear test connections:", e);
    }
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+N: Open new connection dialog
      if (ctrl && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        setConnectionDialogOpen(true);
        return;
      }

      // Ctrl+Shift+N: New query tab
      if (ctrl && e.shiftKey && e.key === "N") {
        e.preventDefault();
        const connectedConnections = connections.filter(conn => conn.connected);
        
        if (connectedConnections.length === 0) {
          showMessage(t('common.noConnectionHint'));
          return;
        } else if (connectedConnections.length > 1) {
          showMessage(t('common.multipleConnectionsHint'));
          return;
        } else {
          // Only one connected database
          const queryCount = tabs.filter((t) => t.type === "query").length + 1;
          addTab({
            title: `${t('tab.query')} ${queryCount}`,
            titleKey: 'tab.query',
            titleNum: queryCount,
            type: "query",
            content: "",
            connectionId: connectedConnections[0]?.id,
          });
          setTimeout(() => {
            const newActiveId = useTabStore.getState().activeTabId;
            if (newActiveId) {
              window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
            }
          }, 0);
        }
        return;
      }

      // Ctrl+W: Close active tab
      if (ctrl && !e.shiftKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) {
          closeTab(activeTabId);
        }
        return;
      }

      // Ctrl+S: Save current query (prevent default, show toast)
      if (ctrl && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        const toast = document.createElement("div");
        toast.textContent = t('layout.saved');
        toast.style.cssText = `
          position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
          background: hsl(var(--tab-active)); color: white; padding: 6px 16px;
          border-radius: 6px; font-size: 12px; z-index: 9999;
          animation: fadeInOut 1.5s ease-in-out forwards;
        `;
        if (!document.getElementById("toast-style")) {
          const style = document.createElement("style");
          style.id = "toast-style";
          style.textContent = `
            @keyframes fadeInOut {
              0% { opacity: 0; transform: translateX(-50%) translateY(10px); }
              20% { opacity: 1; transform: translateX(-50%) translateY(0); }
              80% { opacity: 1; transform: translateX(-50%) translateY(0); }
              100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
            }
          `;
          document.head.appendChild(style);
        }
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1500);
        return;
      }

      // F5: Execute query in active tab
      if (e.key === "F5") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("crabhub:execute-query"));
        return;
      }

      // Ctrl+B: Toggle sidebar
      if (ctrl && !e.shiftKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+J: Toggle AI panel
      if (ctrl && !e.shiftKey && e.key === "j") {
        e.preventDefault();
        toggleAIPanel();
        return;
      }
    };

    const handleOpenPluginManager = () => {
      setPluginManagerOpen(true);
    };

    const handleOpenUpdateManager = () => {
      setUpdateManagerOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("openPluginManager", handleOpenPluginManager);
    window.addEventListener("openUpdateManager", handleOpenUpdateManager);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("openPluginManager", handleOpenPluginManager);
      window.removeEventListener("openUpdateManager", handleOpenUpdateManager);
    };
  }, [addTab, closeTab, activeTabId, tabs.length, toggleSidebar, toggleAIPanel]);

  const activeConnection = activeConnectionId
    ? connections.find((c) => c.id === activeConnectionId) || null
    : null;

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden">
      {/* Top Toolbar */}
      <Toolbar
        onOpenConnectionDialog={() => handleOpenConnectionDialog()}
        onOpenSnippetPanel={toggleSnippetPanel}
        onOpenSchemaDiff={() => setSchemaDiffOpen(true)}
        onOpenERDiagram={handleOpenERDiagram}
        onOpenQueryAnalyzer={handleOpenQueryAnalyzer}
        onOpenDataMigration={() => setDataMigrationOpen(true)}
        onOpenImport={() => setImportExportMode("import")}
        onOpenExport={() => setImportExportMode("export")}
        connections={connections}
      />

      {/* Main Content: Sidebar + Editor/Navicat Panel */}
      <PanelGroup direction="horizontal">
        {/* Left Sidebar (Connection Tree) */}
        {sidebarOpen && (
          <Panel defaultSize={18} minSize={12} maxSize={30}>
            <Sidebar openConnectionDialog={handleOpenConnectionDialog} />
          </Panel>
        )}
        {sidebarOpen && <PanelResizeHandle className="w-px bg-border hover:bg-[hsl(var(--tab-active))] transition-colors cursor-col-resize" />}

        {/* Center: Editor or Navicat Panel */}
        <Panel>
          <ErrorBoundary>
          {activeConnection ? (
            <OpenDbMainPanel activeConnection={activeConnection} selectedSchemaName={selectedSchemaName} />
          ) : (
            <>
              {tabs.length > 0 && <TabBar />}
              <EditorPanel />
            </>
          )}
          </ErrorBoundary>
        </Panel>
      </PanelGroup>

      {/* Bottom Status Bar */}
      <StatusBar />

      {/* Floating AI Panel */}
      {aiPanelOpen && <AIPanel />}

      {/* Dialogs */}
      <ConnectionDialog
        isOpen={connectionDialogOpen}
        onClose={handleCloseConnectionDialog}
        editConnection={editingConnection}
      />
      <SnippetPanel
        isOpen={snippetPanelOpen}
        onClose={toggleSnippetPanel}
        onInsert={(sql) => {
          // Insert SQL into active tab or create new one
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (activeTab && activeTab.type === "query") {
            useTabStore.getState().updateTabContent(
              activeTabId!,
              activeTab.content ? activeTab.content + "\n" + sql : sql
            );
          } else {
            const connectedConnections = connections.filter(conn => conn.connected);
            
            if (connectedConnections.length === 0) {
              showMessage(t('common.noConnectionHint'));
            } else if (connectedConnections.length > 1) {
              showMessage(t('common.multipleConnectionsHint'));
            } else {
              // Only one connected database
              addTab({
                title: t('welcome.codeSnippet'),
                titleKey: 'welcome.codeSnippet',
                type: "query",
                content: sql,
                connectionId: connectedConnections[0]?.id,
              });
            }
          }
          toggleSnippetPanel();
        }}
      />
      <SchemaDiffDialog
        isOpen={schemaDiffOpen}
        onClose={() => setSchemaDiffOpen(false)}
      />
      <DataMigration
        isOpen={dataMigrationOpen}
        onClose={() => setDataMigrationOpen(false)}
      />
      <ERSelectorDialog
        isOpen={erSelectorOpen}
        onClose={() => setERSelectorOpen(false)}
        onConfirm={handleERSelectorConfirm}
      />
      {importExportMode && (
        <ImportExportDialog
          isOpen={true}
          mode={importExportMode}
          onClose={() => setImportExportMode(null)}
        />
      )}
      {pluginManagerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-2xl h-full max-h-[80vh] bg-background rounded-lg shadow-lg overflow-hidden">
            <PluginManager onClose={() => setPluginManagerOpen(false)} />
          </div>
        </div>
      )}
      {updateManagerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-2xl h-full max-h-[80vh] bg-background rounded-lg shadow-lg overflow-hidden">
            <UpdateManager onClose={() => setUpdateManagerOpen(false)} />
          </div>
        </div>
      )}
      <MessageDialog />
    </div>
  );
}

export default MainLayout;
