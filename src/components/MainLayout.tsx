import { useState, useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useAppStore, type Connection, type SchemaNode } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import Toolbar from "./Toolbar";
import Sidebar from "./Sidebar";
import NavicatMainPanel from "./NavicatMainPanel";
import TabBar from "./TabBar";
import EditorPanel from "./EditorPanel";
import AIPanel from "./AIPanel";
import StatusBar from "./StatusBar";
import ConnectionDialog from "./ConnectionDialog";
import SnippetPanel from "./SnippetPanel";
import SchemaDiffDialog from "./SchemaDiffDialog";
import DataMigration from "./DataMigration";

function MainLayout() {
  const {
    aiPanelOpen,
    sidebarOpen,
    toggleSidebar,
    toggleAIPanel,
    addTab,
    closeTab,
    activeTabId,
    tabs,
    activeConnectionId,
    connections,
    snippetPanelOpen,
    toggleSnippetPanel,
    setSelectedSchemaId,
    selectedSchemaName,
    setSelectedSchemaName,
    setSelectedTable,
    setSelectedTableId,
  } = useAppStore();

  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | undefined>();
  const [schemaDiffOpen, setSchemaDiffOpen] = useState(false);
  const [dataMigrationOpen, setDataMigrationOpen] = useState(false);

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
    if (!activeConnectionId) return;
    // Open ER diagram as a tab
    addTab({
      title: t('layout.erDiagram'),
      type: "er_diagram",
      content: "",
      connectionId: activeConnectionId,
      modified: false,
    });
  }, [activeConnectionId, addTab]);

  const handleOpenTableDesigner = useCallback(() => {
    addTab({
      title: t('layout.tableDesigner'),
      type: "table_designer",
      content: "",
      connectionId: activeConnectionId || undefined,
      modified: false,
    });
  }, [activeConnectionId, addTab]);

  const handleOpenQueryAnalyzer = useCallback(() => {
    addTab({
      title: t('layout.queryAnalyzer'),
      type: "query_analyzer",
      content: "",
      connectionId: activeConnectionId || undefined,
      modified: false,
    });
  }, [activeConnectionId, addTab]);

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
        addTab({
          title: `${t('tab.query')} ${tabs.length + 1}`,
          type: "query",
          content: "",
          modified: false,
        });
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
        window.dispatchEvent(new CustomEvent("opendb:execute-query"));
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

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTab, closeTab, activeTabId, tabs.length, toggleSidebar, toggleAIPanel]);

  const handleSchemaClick = useCallback((schemaName: string, connectionId: string) => {
    setSelectedSchemaName(schemaName);
    setSelectedSchemaId(`${connectionId}-${schemaName}`);
  }, [setSelectedSchemaId, setSelectedSchemaName]);

  const handleTableClick = useCallback((table: SchemaNode, _connectionId: string) => {
    setSelectedTable(table);
    setSelectedTableId(table.id);
  }, [setSelectedTable, setSelectedTableId]);

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
        onOpenTableDesigner={handleOpenTableDesigner}
        onOpenQueryAnalyzer={handleOpenQueryAnalyzer}
        onOpenDataMigration={() => setDataMigrationOpen(true)}
      />

      {/* Main Content: Sidebar + Navicat Panel */}
      <PanelGroup direction="horizontal">
        {/* Left Sidebar (Connection Tree) */}
        {sidebarOpen && (
          <Panel defaultSize={18} minSize={12} maxSize={30}>
            <Sidebar openConnectionDialog={handleOpenConnectionDialog} onSchemaClick={handleSchemaClick} onTableClick={handleTableClick} />
          </Panel>
        )}
        {sidebarOpen && <PanelResizeHandle className="w-px bg-border hover:bg-[hsl(var(--tab-active))] transition-colors cursor-col-resize" />}

        {/* Center: Navicat-style Panel */}
        <Panel>
          {activeConnection ? (
            <NavicatMainPanel activeConnection={activeConnection} selectedSchemaName={selectedSchemaName} />
          ) : (
            <div className="flex flex-col h-full">
              <TabBar />
              <EditorPanel />
            </div>
          )}
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
            useAppStore.getState().updateTabContent(
              activeTabId!,
              activeTab.content ? activeTab.content + "\n" + sql : sql
            );
          } else {
            addTab({
              title: t('welcome.codeSnippet'),
              type: "query",
              content: sql,
              modified: false,
            });
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
    </div>
  );
}

export default MainLayout;
