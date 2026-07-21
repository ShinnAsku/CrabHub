import { useState, useEffect } from "react";
import {
  Plus,
  Clock,
  ChevronRight,
  ChevronDown,
  Plug,
  Unplug,
  Trash2,
  Edit,
  Loader2,
  Table as TableIcon,
  Eye,
  Folder,
  Layers,
  FileText,
  Settings,
  Zap,
  Calendar,
  Database,
} from "lucide-react";
import { useConnectionStore, useUIStore, useTabStore } from "@/stores/app-store";
import type { Connection } from "@/types";
import { t } from "@/lib/i18n";
import {
  connectDatabase,
  disconnectDatabase,
  getDatabases,
  getTables,
  getViews,
  invalidateMetadataCache,
} from "@/lib/tauri-commands";
import QueryHistory from "./QueryHistory";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import DatabaseIcon from "./DatabaseIcon";
import { generateCopyTableName, buildDuplicateTableSQL } from "@/lib/export";
import { log } from "@/lib/log";
import { ConfirmDialog } from "./ConfirmDialog";
import type { SidebarView, TreeNode, TreeNodeType } from "./sidebar/types";
import { ContextMenu, TreeNodeContextMenu } from "./sidebar/ContextMenus";

interface SidebarProps {
  openConnectionDialog: (editConnection?: Connection) => void;
}

function Sidebar({ openConnectionDialog }: SidebarProps) {
  const [view, setView] = useState<SidebarView>("connections");
  const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);
  const [treeNodeContextMenu, setTreeNodeContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [treeData, setTreeData] = useState<Record<string, TreeNode[]>>({});
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [createDbDialogOpen, setCreateDbDialogOpen] = useState(false);
  const [createDbConnectionId, setCreateDbConnectionId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; title?: string; variant?: "destructive"; onConfirm: () => void } | null>(null);

  const { activeConnectionId, connections, loadConnections } = useConnectionStore();
  const { schemaData, setSchemaData } = useUIStore();

  // Load connections from SQLite on mount
  useEffect(() => {
    loadConnections();
  }, []);

  // Load schema data when connection becomes active or when a connection's status changes
  useEffect(() => {
    if (activeConnectionId) {
      const activeConn = connections.find(c => c.id === activeConnectionId);
      if (activeConn?.connected && !schemaData[activeConnectionId]) {
        loadSchemaData(activeConnectionId);
      }
    }
  }, [activeConnectionId, connections]);

  const loadSchemaData = async (connectionId: string) => {
    log.debug('[Sidebar] Loading schema data for connection:', connectionId);
    try {
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return;

      const isSQLite = conn.type === 'sqlite';
      let nodes: TreeNode[];

      if (isSQLite) {
        nodes = [{
          id: `${connectionId}-db-main`,
          name: 'main',
          type: 'database' as const,
          connectionId,
          loaded: false,
        }];
      } else {
        // Always load databases first (DBeaver-style)
        const dbNames = await getDatabases(connectionId);
        log.debug('[Sidebar] Loaded databases:', dbNames);
        nodes = dbNames.map((name) => ({
          id: `${connectionId}-db-${name}`,
          name,
          type: 'database' as const,
          connectionId,
          loaded: false,
        }));
      }

      setSchemaData(connectionId, nodes as any);
      log.debug('[Sidebar] Data loaded:', nodes.length, 'nodes');
    } catch (error) {
      console.error('[Sidebar] Failed to load schema data:', error);
    }
  };

  // Handle tree node context menu
  const handleTreeNodeContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    log.debug('[Sidebar] Right-click on tree node:', node.name, 'Type:', node.type);
    setTreeNodeContextMenu({
      x: e.clientX,
      y: e.clientY,
      node,
    });
  };

  // Handle refresh tree node - will be implemented in DatabaseTree
  const handleRefreshNode = async (node: TreeNode) => {
    log.debug('[Sidebar] Refreshing node:', node.name);
    // Bypass the backend's metadata TTL cache so the reload sees fresh structure
    if (node.connectionId) {
      try { await invalidateMetadataCache(node.connectionId); } catch { /* best-effort */ }
    }
    // This will be called from DatabaseTree with the actual implementation
  };

  // Handle copy name
  const handleCopyName = (name: string) => {
    navigator.clipboard.writeText(name);
    log.debug('[Sidebar] Copied to clipboard:', name);
  };

  // Handle create database from context menu
  const handleCreateDatabase = (connectionId: string) => {
    log.debug('[Sidebar] Opening create database dialog for:', connectionId);
    setCreateDbConnectionId(connectionId);
    setCreateDbDialogOpen(true);
  };

  // Handle database created successfully
  const handleDatabaseCreated = async (connectionId: string) => {
    log.debug('[Sidebar] Database created, refreshing for:', connectionId);
    try { await invalidateMetadataCache(connectionId); } catch { /* best-effort */ }
    // Clear cached tree data for this connection
    const newTreeData = { ...treeData };
    Object.keys(newTreeData).forEach((key) => {
      if (key.startsWith(connectionId)) {
        delete newTreeData[key];
      }
    });
    setTreeData(newTreeData);
    // Reload schema data
    await loadSchemaData(connectionId);
  };

  // Handle new query from context menu
  const handleNewQuery = (node: TreeNode) => {
    log.debug('[Sidebar] New query for node:', node.name, 'connectionId:', node.connectionId);
    const connId = node.connectionId;
    if (!connId) return;
    // Set active connection
    useConnectionStore.getState().setActiveConnection(connId);
    // Create a new query tab
    const queryCount = useTabStore.getState().tabs.filter((tab: any) => tab.type === 'query').length + 1;
    useTabStore.getState().addTab({
      title: `${t('tab.newQuery')} ${queryCount}`,
      type: 'query',
      content: '',
      connectionId: connId,
    });
    // Dispatch event so NavicatMainPanel can switch to query view
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  };

  // Handle design table from context menu
  const handleDesignTable = (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    useConnectionStore.getState().setActiveConnection(connId);
    useTabStore.getState().addTab({
      title: `${t('sidebar.designTable')} - ${node.name}`,
      type: 'designer',
      content: '',
      connectionId: connId,
      tableName: node.name,
      schemaName: node.schemaName,
    });
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  };

  // Handle delete table from context menu
  const handleDeleteTable = (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    setConfirmDialog({
      title: t('common.confirm'),
      message: t('sidebar.confirmDeleteTable', { name: node.name }),
      variant: "destructive",
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const { executeSql } = await import("@/lib/tauri-commands");
          const conn = connections.find(c => c.id === connId);
          const dbType = conn?.type || 'postgresql';
          let tableName = node.name;
          if (node.schemaName && !['mysql', 'sqlite'].includes(dbType)) {
            tableName = `"${node.schemaName}"."${node.name}"`;
          } else if (dbType === 'mysql') {
            tableName = `\`${node.name}\``;
          } else if (dbType === 'mssql') {
            tableName = node.schemaName ? `[${node.schemaName}].[${node.name}]` : `[${node.name}]`;
          } else {
            tableName = `"${node.name}"`;
          }
          await executeSql(connId, `DROP TABLE ${tableName}`);
          const newTreeData = { ...treeData };
          Object.keys(newTreeData).forEach((key) => {
            if (key.startsWith(connId)) delete newTreeData[key];
          });
          setTreeData(newTreeData);
          if (node.connectionId) await loadSchemaData(node.connectionId);
        } catch (error) {
          console.error('[Sidebar] Failed to delete table:', error);
          alert(String(error));
        }
      },
    });
  };

  // Handle truncate table from context menu
  const handleTruncateTable = (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    setConfirmDialog({
      title: t('common.confirm'),
      message: t('sidebar.confirmTruncateTable', { name: node.name }),
      variant: "destructive",
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const { executeSql } = await import("@/lib/tauri-commands");
          const conn = connections.find(c => c.id === connId);
          const dbType = conn?.type || 'postgresql';
          let tableName = node.name;
          if (node.schemaName && !['mysql', 'sqlite'].includes(dbType)) {
            tableName = `"${node.schemaName}"."${node.name}"`;
          } else if (dbType === 'mysql') {
            tableName = `\`${node.name}\``;
          } else if (dbType === 'mssql') {
            tableName = node.schemaName ? `[${node.schemaName}].[${node.name}]` : `[${node.name}]`;
          } else {
            tableName = `"${node.name}"`;
          }
          const sql = dbType === 'sqlite' ? `DELETE FROM ${tableName}` : `TRUNCATE TABLE ${tableName}`;
          await executeSql(connId, sql);
        } catch (error) {
          console.error('[Sidebar] Failed to truncate table:', error);
          alert(String(error));
        }
      },
    });
  };

  // Handle open table from context menu - reuses double-click logic
  const handleOpenTable = (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    useConnectionStore.getState().setActiveConnection(connId);
    if (node.schemaName) {
      useUIStore.getState().setSelectedSchemaName(node.schemaName);
    }
    const tableInfo = {
      oid: null,
      name: node.name,
      schema: node.schemaName || "public",
      owner: null,
      size: "",
      description: "",
      acl: null,
      tablespace: "",
      hasIndexes: null,
      hasRules: false,
      hasTriggers: null,
      rowCount: null,
      primaryKey: null,
      partitionOf: null,
      tableType: "TABLE",
      created: new Date(),
      modified: new Date(),
      engine: null,
      dataLength: null,
      createTime: null,
      updateTime: null,
      collation: null,
    };
    useUIStore.getState().setSelectedTable(tableInfo);
    useUIStore.getState().setSelectedTableId(node.id);
    useUIStore.getState().setSelectedContext({
      type: "table",
      connectionId: connId,
      schemaName: node.schemaName || undefined,
      tableName: node.name,
    });
  };

  // Handle duplicate table from context menu
  const handleDuplicateTable = async (node: TreeNode, includeData: boolean) => {
    const connId = node.connectionId;
    if (!connId) return;
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;

    try {
      const { executeSql, exportTableSql, getTables: getTablesCmd } = await import("@/lib/tauri-commands");
      const dbType = conn.type;
      const schema = node.schemaName;

      // Get existing table names for auto-naming
      const tables = await getTablesCmd(connId);
      const existingNames = tables.map(t => t.name);
      const newName = generateCopyTableName(node.name, existingNames);

      // For DDL-based databases, fetch DDL first
      let ddl: string | undefined;
      const needsDDL = (dbType === 'sqlite' && !includeData)
        || (dbType === 'mssql' && !includeData)
        || (!['postgresql', 'gaussdb', 'opengauss', 'mysql', 'sqlite', 'mssql'].includes(dbType));
      if (needsDDL) {
        ddl = await exportTableSql(connId, node.name, schema);
      }

      const sqls = buildDuplicateTableSQL(dbType, node.name, newName, schema, includeData, ddl);

      for (const sql of sqls) {
        await executeSql(connId, sql);
      }

      // Refresh tree
      const newTreeData = { ...treeData };
      Object.keys(newTreeData).forEach((key) => {
        if (key.startsWith(connId)) delete newTreeData[key];
      });
      setTreeData(newTreeData);
      if (connId) await loadSchemaData(connId);
    } catch (error) {
      console.error('[Sidebar] Failed to duplicate table:', error);
      alert(`${t('sidebar.duplicateFailed')}: ${String(error)}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-sidebar-bg/70 backdrop-blur-xl backdrop-saturate-150 border-r border-border/20">
      {/* View toggle */}
      <div className="flex items-center gap-1 px-2 py-1 shrink-0">
        <button
          onClick={() => setView("connections")}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap overflow-hidden ${
            view === "connections"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
          title={t('sidebar.connections')}
        >
          <Database size={12} className="shrink-0" />
          <span className="truncate">{t('sidebar.connections')}</span>
        </button>
        <button
          onClick={() => setView("history")}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap overflow-hidden ${
            view === "history"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
          title={t('sidebar.history')}
        >
          <Clock size={12} className="shrink-0" />
          <span className="truncate">{t('history.title')}</span>
        </button>
        <div className="flex-1" />
        <button
          onClick={() => openConnectionDialog()}
          data-testid="new-connection"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
          title={t('sidebar.newConnection')}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {view === "connections" ? (
          <ConnectionList
            openConnectionDialog={openConnectionDialog}
            expandedConnections={expandedConnections}
            setExpandedConnections={setExpandedConnections}
            setContextMenu={setContextMenu}
            expandedNodes={expandedNodes}
            setExpandedNodes={setExpandedNodes}
            treeData={treeData}
            setTreeData={setTreeData}
            loadingNodes={loadingNodes}
            setLoadingNodes={setLoadingNodes}
            handleTreeNodeContextMenu={handleTreeNodeContextMenu}
            handleRefreshNode={handleRefreshNode}
            handleCopyName={handleCopyName}
          />
        ) : (
          <QueryHistory />
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          connectionId={contextMenu.connectionId}
          onClose={() => setContextMenu(null)}
          openConnectionDialog={openConnectionDialog}
          expandedConnections={expandedConnections}
          setExpandedConnections={setExpandedConnections}
          onCreateDatabase={handleCreateDatabase}
        />
      )}

      {/* Tree Node Context Menu */}
      {treeNodeContextMenu && (
        <TreeNodeContextMenu
          x={treeNodeContextMenu.x}
          y={treeNodeContextMenu.y}
          node={treeNodeContextMenu.node}
          onClose={() => setTreeNodeContextMenu(null)}
          onRefresh={handleRefreshNode}
          onCopyName={handleCopyName}
          onNewQuery={handleNewQuery}
          onDesignTable={handleDesignTable}
          onOpenTable={handleOpenTable}
          onDuplicateTable={handleDuplicateTable}
          onDeleteTable={handleDeleteTable}
          onTruncateTable={handleTruncateTable}
        />
      )}

      {/* Create Database Dialog */}
      {createDbConnectionId && (() => {
        const conn = connections.find(c => c.id === createDbConnectionId);
        return conn ? (
          <CreateDatabaseDialog
            isOpen={createDbDialogOpen}
            onClose={() => {
              setCreateDbDialogOpen(false);
              setCreateDbConnectionId(null);
            }}
            connectionId={createDbConnectionId}
            connectionType={conn.type}
            connectionName={conn.name}
            onSuccess={handleDatabaseCreated}
          />
        ) : null;
      })()}
      {confirmDialog && (
        <ConfirmDialog
          open
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

// ===== Connection List =====

interface ConnectionListProps {
  openConnectionDialog: (editConnection?: Connection) => void;
  expandedConnections: Set<string>;
  setExpandedConnections: React.Dispatch<React.SetStateAction<Set<string>>>;
  setContextMenu: (menu: { x: number; y: number; connectionId: string } | null) => void;
  expandedNodes: Set<string>;
  setExpandedNodes: (expanded: Set<string>) => void;
  treeData: Record<string, TreeNode[]>;
  setTreeData: (data: Record<string, TreeNode[]>) => void;
  loadingNodes: Set<string>;
  setLoadingNodes: (loading: Set<string>) => void;
  handleTreeNodeContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  handleRefreshNode: (node: TreeNode) => Promise<void>;
  handleCopyName: (name: string) => void;
}

function ConnectionList({
  openConnectionDialog,
  expandedConnections,
  setExpandedConnections,
  setContextMenu,
  expandedNodes,
  setExpandedNodes,
  treeData,
  setTreeData,
  loadingNodes,
  setLoadingNodes,
  handleTreeNodeContextMenu,
  handleRefreshNode,
  handleCopyName,
}: ConnectionListProps) {
  const { connections, activeConnectionId, setActiveConnection } = useConnectionStore();
  const { schemaData, setSchemaData } = useUIStore();
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  // Load schema data helper (lazy loading - only schema names)
  const loadSchemaData = async (connectionId: string) => {
    log.debug('[ConnectionList] Loading schema data for connection:', connectionId);
    try {
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return;

      const isSQLite = conn.type === 'sqlite';
      let nodes: any[];

      if (isSQLite) {
        nodes = [{
          id: `${connectionId}-db-main`,
          name: 'main',
          type: 'database',
          connectionId,
          loaded: false,
        }];
      } else {
        // Always load databases first (DBeaver-style)
        const dbNames = await getDatabases(connectionId);
        log.debug('[ConnectionList] Loaded databases:', dbNames);
        nodes = dbNames.map((name) => ({
          id: `${connectionId}-db-${name}`,
          name,
          type: 'database',
          connectionId,
          loaded: false,
        }));
      }

      setSchemaData(connectionId, nodes);
      log.debug('[ConnectionList] Schema data loaded:', nodes.length, 'databases');
    } catch (error) {
      console.error('[ConnectionList] Failed to load schema data:', error);
    }
  };

  if (connections.length === 0) {
    return <EmptyConnectionList openConnectionDialog={openConnectionDialog} />;
  }

  // Helper: connect, expand, load schemas. Has re-entrance guard.
  const connectAndExpand = async (connection: Connection) => {
    if (connectingIds.has(connection.id)) {
      log.debug('[Sidebar] connectAndExpand: already connecting, skip', connection.name);
      return;
    }
    log.debug('[Sidebar] connectAndExpand:', connection.name);
    setConnectingIds(prev => new Set(prev).add(connection.id));
    try {
      await connectDatabase(connection);
      log.debug('[Sidebar] ✓ Connected:', connection.name);
      useConnectionStore.getState().updateConnection(connection.id, { connected: true, lastConnected: new Date() });
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.add(connection.id);
        return next;
      });
      await loadSchemaData(connection.id);
    } catch (error: any) {
      console.error('[Sidebar] ✗ Failed to connect:', connection.name, error);
      alert(t('sidebar.connectFailed', { error: error?.message || String(error) }));
    } finally {
      setConnectingIds(prev => {
        const next = new Set(prev);
        next.delete(connection.id);
        return next;
      });
    }
  };

  const handleToggleExpand = async (connectionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) return;

    if (expandedConnections.has(connectionId)) {
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    } else if (!connection.connected) {
      setActiveConnection(connectionId);
      await connectAndExpand(connection);
    } else {
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.add(connectionId);
        return next;
      });
      if (!schemaData[connectionId]) {
        await loadSchemaData(connectionId);
      }
    }
  };

  const handleConnectionClick = async (connectionId: string) => {
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) return;
    // Don't do anything if already connecting
    if (connectingIds.has(connectionId)) return;

    setActiveConnection(connectionId);
    useUIStore.getState().setSelectedContext({ type: "connection", connectionId });

    // 单击只展开/收起，不自动连接
    if (expandedConnections.has(connectionId)) {
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    } else if (connection.connected) {
      // 仅已连接时才展开
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.add(connectionId);
        return next;
      });
      if (!schemaData[connectionId]) {
        await loadSchemaData(connectionId);
      }
    }
  };

  const handleDoubleClick = async (connection: Connection) => {
    // 双击时，如果已连接则展开
    if (connectingIds.has(connection.id)) return;
    
    if (connection.connected) {
      setActiveConnection(connection.id);
      useUIStore.getState().setSelectedContext({ type: "connection", connectionId: connection.id });
      
      if (!expandedConnections.has(connection.id)) {
        setExpandedConnections(prev => {
          const next = new Set(prev);
          next.add(connection.id);
          return next;
        });
      }
      if (!schemaData[connection.id]) {
        await loadSchemaData(connection.id);
      }
      return;
    }
    
    // 未连接时，双击尝试连接
    setActiveConnection(connection.id);
    useUIStore.getState().setSelectedContext({ type: "connection", connectionId: connection.id });
    await connectAndExpand(connection);
  };

  const handleContextMenu = (e: React.MouseEvent, connectionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const connection = connections.find(c => c.id === connectionId);
    log.debug(`[Sidebar] handleContextMenu: 右键菜单打开 -> ${connection?.name || connectionId}, 位置=(${e.clientX}, ${e.clientY})`);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      connectionId,
    });
  };

  const handleDisconnect = (connectionId: string) => {
    setExpandedConnections(prev => {
      const next = new Set(prev);
      next.delete(connectionId);
      return next;
    });
  };

  return (
    <div className="py-1">
      {connections.map((connection) => {
        const isExpanded = expandedConnections.has(connection.id);

        return (
          <div key={connection.id}>
            <ConnectionItem
              connection={connection}
              isActive={activeConnectionId === connection.id}
              isExpanded={isExpanded}
              isConnecting={connectingIds.has(connection.id)}
              onToggleExpand={(e) => handleToggleExpand(connection.id, e)}
              onClick={() => handleConnectionClick(connection.id)}
              onDoubleClick={() => handleDoubleClick(connection)}
              onContextMenu={(e) => handleContextMenu(e, connection.id)}
              onDisconnect={handleDisconnect}
              openConnectionDialog={openConnectionDialog}
            />
            
            {/* Loading indicator while connecting */}
            {connectingIds.has(connection.id) && (
              <div className="pl-8 py-2 text-xs text-muted-foreground italic flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" />
                {t('sidebar.connecting')}
              </div>
            )}
            
            {/* Tree structure when expanded */}
            {isExpanded && connection.connected && (
              <DatabaseTree
                connectionId={connection.id}
                connection={connection}
                expandedNodes={expandedNodes}
                setExpandedNodes={setExpandedNodes}
                treeData={treeData}
                setTreeData={setTreeData}
                loadingNodes={loadingNodes}
                setLoadingNodes={setLoadingNodes}
                handleTreeNodeContextMenu={handleTreeNodeContextMenu}
                handleRefreshNode={handleRefreshNode}
                handleCopyName={handleCopyName}
              />
            )}
            
            {isExpanded && !connection.connected && (
              <div className="pl-8 py-2 text-xs text-muted-foreground italic">
                {t('sidebar.needConnection')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===== Database Tree =====

interface DatabaseTreeProps {
  connectionId: string;
  connection: Connection;
  expandedNodes: Set<string>;
  setExpandedNodes: (expanded: Set<string>) => void;
  treeData: Record<string, TreeNode[]>;
  setTreeData: (data: Record<string, TreeNode[]>) => void;
  loadingNodes: Set<string>;
  setLoadingNodes: (loading: Set<string>) => void;
  handleTreeNodeContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  handleRefreshNode: (node: TreeNode) => Promise<void>;
  handleCopyName: (name: string) => void;
}

// Helper: return supported category folder types for each database type
function getSupportedCategories(dbType: string): TreeNodeType[] {
  switch (dbType) {
    case 'mysql':
      return ['tables', 'views', 'functions', 'events', 'procedures', 'triggers'];
    case 'postgresql':
    case 'gaussdb':
    case 'opengauss':
      return ['tables', 'views', 'functions', 'procedures', 'triggers'];
    case 'mssql':
      return ['tables', 'views', 'functions', 'procedures', 'triggers'];
    case 'sqlite':
      return ['tables', 'views', 'triggers'];
    case 'clickhouse':
      return ['tables', 'views'];
    case 'redis':
    case 'mongodb':
      return ['tables'];
    default:
      if (dbType.startsWith('plugin:')) {
        return ['tables'];
      }
      return ['tables', 'views'];
  }
}

// Category display names
const categoryNames: Record<string, string> = {
  tables: '表',
  views: '视图',
  functions: '函数',
  events: '事件',
  procedures: '存储过程',
  triggers: '触发器',
};

function getCategoryName(cat: string, dbType: string): string {
  if (cat === 'tables' && (dbType === 'redis' || dbType === 'mongodb' || dbType.startsWith('plugin:'))) {
    return 'Keys';
  }
  return categoryNames[cat] || cat;
}

function DatabaseTree({
  connectionId,
  connection,
  expandedNodes,
  setExpandedNodes,
  treeData,
  setTreeData,
  loadingNodes,
  setLoadingNodes,
  handleTreeNodeContextMenu,
  handleRefreshNode,
  handleCopyName,
}: DatabaseTreeProps) {
  const { schemaData } = useUIStore();
  const schemas = schemaData[connectionId] || [];

  const supportedCategories = getSupportedCategories(connection.type);

  const handleToggleNode = async (node: TreeNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const nodeId = node.id;
    log.debug('[DatabaseTree] Node clicked:', node.name, 'Type:', node.type, 'Expanded:', expandedNodes.has(nodeId));
    
    // Set selectedContext based on node type
    if (node.type === 'schema') {
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedSchemaName(node.name);
      useUIStore.getState().setSelectedContext({
        type: "schema",
        connectionId,
        schemaName: node.name,
      });
      log.debug('[DatabaseTree] Selected schema:', node.name);
    } else if (node.type === 'database') {
      // For MySQL, database node click sets schema context (MySQL schema == database)
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedSchemaName(node.name);
      useUIStore.getState().setSelectedContext({
        type: "schema",
        connectionId,
        schemaName: node.name,
      });
      log.debug('[DatabaseTree] Selected database (as schema):', node.name);
    } else if (['tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type)) {
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedContext({
        type: "folder",
        connectionId,
        schemaName: node.schemaName || undefined,
        folderType: node.type,
      });
      log.debug('[DatabaseTree] Selected folder:', node.type, 'in schema:', node.schemaName);
    }
    
    const newExpanded = new Set(expandedNodes);
    
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
      setExpandedNodes(newExpanded);
      log.debug('[DatabaseTree] Collapsed node:', node.name);
    } else {
      newExpanded.add(nodeId);
      setExpandedNodes(newExpanded);
      log.debug('[DatabaseTree] Expanded node:', node.name);
      
      // Load children if not loaded - support all folder types + database (for MySQL)
      if (!node.loaded && ['database', 'schema', 'tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type)) {
        log.debug('[DatabaseTree] Loading children for node:', node.name);
        await loadDatabaseChildren(node);
      }
    }
  };

  // Handle table single-click - only highlight and set context (no tab opening)
  const handleTableClick = (table: TreeNode) => {
    log.debug('[DatabaseTree] Table single-clicked:', table.name);
    useUIStore.getState().setViewModeType("navicat");
    useConnectionStore.getState().setActiveConnection(connectionId);
    if (table.schemaName) {
      useUIStore.getState().setSelectedSchemaName(table.schemaName);
    }
    useUIStore.getState().setSelectedContext({
      type: "table",
      connectionId,
      schemaName: table.schemaName || undefined,
      tableName: table.name,
    });
    useUIStore.getState().setSelectedTableId(table.id);
  };

  // Handle table double-click - open table data tab in right panel
  const handleTableDoubleClick = (table: TreeNode) => {
    log.debug('[DatabaseTree] Table double-clicked:', table.name);
    useUIStore.getState().setViewModeType("navicat");
    useConnectionStore.getState().setActiveConnection(connectionId);
    if (table.schemaName) {
      useUIStore.getState().setSelectedSchemaName(table.schemaName);
    }
    // Set selected table info to trigger tab opening in NavicatMainPanel
    const tableInfo = {
      oid: null,
      name: table.name,
      schema: table.schemaName || "public",
      owner: null,
      size: "",
      description: "",
      acl: null,
      tablespace: "",
      hasIndexes: null,
      hasRules: false,
      hasTriggers: null,
      rowCount: null,
      primaryKey: null,
      partitionOf: null,
      tableType: "TABLE",
      created: new Date(),
      modified: new Date(),
      engine: null,
      dataLength: null,
      createTime: null,
      updateTime: null,
      collation: null,
    };
    useUIStore.getState().setSelectedTable(tableInfo);
    useUIStore.getState().setSelectedTableId(table.id);
    useUIStore.getState().setSelectedContext({
      type: "table",
      connectionId,
      schemaName: table.schemaName || undefined,
      tableName: table.name,
    });
  };

  // Handle click on view/function/procedure/trigger leaf nodes - open source in query tab
  const handleObjectClick = async (node: TreeNode) => {
    log.debug('[DatabaseTree] Object clicked:', node.name, 'Type:', node.type);
    useConnectionStore.getState().setActiveConnection(connectionId);

    const { executeQuery } = await import("@/lib/tauri-commands");
    const schema = node.schemaName || 'public';
    let sql = '';
    let titlePrefix = '';

    if (node.type === 'view') {
      titlePrefix = '视图';
      if (connection.type === 'mysql') {
        sql = `SHOW CREATE VIEW \`${node.name}\``;
      } else if (connection.type === 'mssql') {
        sql = `SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('${node.name}')`;
      } else {
        // PostgreSQL / GaussDB / openGauss
        sql = `SELECT pg_get_viewdef('"${schema}"."${node.name}"'::regclass, true) AS definition`;
      }
    } else if (node.type === 'function') {
      titlePrefix = '函数';
      if (connection.type === 'mysql') {
        sql = `SHOW CREATE FUNCTION \`${node.name}\``;
      } else if (connection.type === 'mssql') {
        sql = `SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('${node.name}')`;
      } else {
        sql = `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schema}' AND p.proname = '${node.name}' LIMIT 1`;
      }
    } else if (node.type === 'procedure') {
      titlePrefix = '存储过程';
      if (connection.type === 'mysql') {
        sql = `SHOW CREATE PROCEDURE \`${node.name}\``;
      } else if (connection.type === 'mssql') {
        sql = `SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('${node.name}')`;
      } else {
        sql = `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schema}' AND p.proname = '${node.name}' LIMIT 1`;
      }
    } else if (node.type === 'trigger') {
      titlePrefix = '触发器';
      if (connection.type === 'mysql') {
        sql = `SHOW CREATE TRIGGER \`${node.name}\``;
      } else if (connection.type === 'mssql') {
        sql = `SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('${node.name}')`;
      } else if (connection.type === 'sqlite') {
        sql = `SELECT sql AS definition FROM sqlite_master WHERE type = 'trigger' AND name = '${node.name}'`;
      } else {
        sql = `SELECT pg_get_triggerdef(t.oid, true) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON t.tgrelid = c.oid JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = '${schema}' AND t.tgname = '${node.name}' LIMIT 1`;
      }
    } else if (node.type === 'event') {
      titlePrefix = '事件';
      if (connection.type === 'mysql') {
        sql = `SHOW CREATE EVENT \`${node.name}\``;
      }
    }

    if (!sql) return;

    let content = `-- ${titlePrefix}: ${node.name}\n`;
    try {
      const result = await executeQuery(connectionId, sql);
      if (result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        if (row) {
          // Try common column names for definition
          const def = row['definition'] || row['Definition'] || row['DEFINITION']
            || row['Create View'] || row['Create Function'] || row['Create Procedure']
            || row['Create Trigger'] || row['Create Event']
            || row['sql'] || row['SQL Original Statement']
            || Object.values(row).find((v: unknown) => typeof v === 'string' && (v as string).length > 20)
            || '';
          content += String(def);
        }
      } else {
        content += `-- 未找到 ${titlePrefix} "${node.name}" 的定义`;
      }
    } catch (err) {
      content += `-- 查询定义失败: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Open a query tab with the definition
    useTabStore.getState().addTab({
      title: `${titlePrefix}: ${node.name}`,
      type: 'query',
      content,
      connectionId,
    });

    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  };

  const loadDatabaseChildren = async (node: TreeNode) => {
    setLoadingNodes(new Set(loadingNodes).add(node.id));
    try {
      let children: TreeNode[] = [];
      
      // 根据节点类型加载不同的子节点
      if (node.type === 'database') {
        const dbType = connection.type;
        const needsSchemas = dbType === 'postgresql' || dbType === 'gaussdb' || dbType === 'opengauss' || dbType === 'mssql';

        if (needsSchemas) {
          // PostgreSQL/GaussDB/MSSQL: load schemas via sub-connection
          log.debug('[DatabaseTree] Loading schemas for database:', node.name);
          try {
            const { getSchemasForDatabase } = await import("@/lib/tauri-commands");
            const schemaNames = await getSchemasForDatabase(connectionId, node.name);
            log.debug('[DatabaseTree] Loaded', schemaNames.length, 'schemas for database', node.name);
            children = schemaNames.map((name) => ({
              id: `${node.id}-schema-${name}`,
              type: 'schema' as TreeNodeType,
              name,
              connectionId: node.connectionId,
              databaseName: node.name,
              children: [],
              loaded: false,
            }));
          } catch (err) {
            console.error('[DatabaseTree] Failed to load schemas for database:', node.name, err);
            children = [];
          }
        } else {
          // MySQL/ClickHouse/SQLite: database IS schema - category folders directly
          log.debug('[DatabaseTree] Creating category folders for database:', node.name);
          const cats = getSupportedCategories(connection.type);
          children = cats.map(cat => ({
            id: `${node.id}-${cat}`,
            type: cat,
            name: getCategoryName(cat, connection.type),
            connectionId: node.connectionId,
            databaseName: node.name,
            schemaName: node.name,
            children: [],
            loaded: false,
          }));
          log.debug('[DatabaseTree] Created', children.length, 'category folders');
        }
      } else if (node.type === 'schema') {
        // Schema 节点下创建分类文件夹：表、视图、函数、存储过程、触发器
        log.debug('[DatabaseTree] Creating category folders for schema:', node.name);
        children = supportedCategories.map(cat => ({
          id: `${node.id}-${cat}`,
          type: cat,
          name: getCategoryName(cat, connection.type),
          connectionId: node.connectionId,
          databaseName: node.databaseName,
          schemaName: node.name,
          children: [],
          loaded: false,
        }));
        log.debug('[DatabaseTree] Created', children.length, 'category folders');
      } else if (node.type === 'tables') {
        // 表文件夹 - 加载实际的表列表（按 schema 过滤）
        log.debug('[DatabaseTree] Loading tables for schema:', node.schemaName);
        const tables = await getTables(connectionId);
        const filtered = node.schemaName
          ? tables.filter((table: any) => !table.schema || table.schema === node.schemaName)
          : tables;
        log.debug('[DatabaseTree] Loaded', filtered.length, 'tables (total:', tables.length, ')');
        children = filtered.map((table: any) => ({
          id: `${connectionId}-${node.schemaName || 'default'}-table-${table.name}`,
          type: 'table',
          name: table.name,
          connectionId,
          schemaName: node.schemaName,
        }));
      } else if (node.type === 'views') {
        // 视图文件夹 - 加载实际的视图列表
        log.debug('[DatabaseTree] Loading views for schema:', node.schemaName);
        try {
          const views = await getViews(connectionId, node.schemaName || undefined);
          log.debug('[DatabaseTree] Loaded', views.length, 'views');
          children = views.map((view: any) => ({
            id: `${connectionId}-${node.schemaName || 'default'}-view-${view.name}`,
            type: 'view',
            name: view.name,
            connectionId,
            schemaName: node.schemaName,
          }));
        } catch (err) {
          console.error('[DatabaseTree] Failed to load views:', err);
          children = [];
        }
      } else if (node.type === 'functions') {
        // 函数文件夹 - 使用 SQL 查询系统表获取函数列表
        log.debug('[DatabaseTree] Loading functions for schema:', node.schemaName);
        try {
          const { executeQuery } = await import("@/lib/tauri-commands");
          const schema = node.schemaName || 'public';
          let result: any = null;

          if (connection.type === 'gaussdb' || connection.type === 'opengauss') {
            // GaussDB/openGauss: try prokind first (openGauss 3.x+), fallback to information_schema
            const queries = [
              `SELECT p.proname as name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schema}' AND p.prokind = 'f' ORDER BY p.proname`,
              `SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = '${schema}' AND routine_type = 'FUNCTION' ORDER BY routine_name`,
            ];
            for (const q of queries) {
              try {
                result = await executeQuery(connectionId, q);
                break;
              } catch { /* try next */ }
            }
          } else if (connection.type === 'postgresql') {
            result = await executeQuery(connectionId, `SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = '${schema}' AND routine_type = 'FUNCTION' ORDER BY routine_name`);
          } else if (connection.type === 'mysql') {
            result = await executeQuery(connectionId, `SELECT ROUTINE_NAME as name FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = '${schema}' AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME`);
          } else if (connection.type === 'mssql') {
            result = await executeQuery(connectionId, `SELECT name FROM sys.objects WHERE type IN ('FN', 'IF', 'TF') ORDER BY name`);
          } else if (connection.type === 'clickhouse') {
            result = await executeQuery(connectionId, `SELECT name FROM system.functions WHERE database = '${schema}' AND origin = 'SQL' ORDER BY name`);
          }

          if (result && result.rows) {
            children = result.rows.map((row: any) => ({
              id: `${connectionId}-function-${row.name}`,
              type: 'function',
              name: row.name,
              connectionId,
              schemaName: node.schemaName,
            }));
          }
        } catch (err) {
          console.error('[DatabaseTree] Failed to load functions:', err);
          children = [];
        }
      } else if (node.type === 'procedures') {
        // 存储过程文件夹 - 使用 SQL 查询系统表获取存储过程列表
        log.debug('[DatabaseTree] Loading procedures for schema:', node.schemaName);
        try {
          const { executeQuery } = await import("@/lib/tauri-commands");
          const schema = node.schemaName || 'public';
          let result: any = null;

          if (connection.type === 'gaussdb' || connection.type === 'opengauss') {
            // GaussDB/openGauss: try multiple strategies
            // 1. prokind = 'p' (openGauss 3.x+ / GaussDB with PG11+ catalog)
            // 2. information_schema with routine_type = 'PROCEDURE'
            // 3. pg_proc void-returning non-aggregate functions (broadest fallback)
            const queries = [
              `SELECT p.proname as name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schema}' AND p.prokind = 'p' ORDER BY p.proname`,
              `SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = '${schema}' AND routine_type = 'PROCEDURE' ORDER BY routine_name`,
              `SELECT p.proname as name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schema}' AND p.prorettype = 'void'::regtype AND NOT p.proisagg ORDER BY p.proname`,
            ];
            for (const q of queries) {
              try {
                result = await executeQuery(connectionId, q);
                if (result.rows.length > 0) break;
              } catch { /* try next */ }
            }
          } else if (connection.type === 'postgresql') {
            result = await executeQuery(connectionId, `SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = '${schema}' AND routine_type = 'PROCEDURE' ORDER BY routine_name`);
          } else if (connection.type === 'mysql') {
            result = await executeQuery(connectionId, `SELECT ROUTINE_NAME as name FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = '${schema}' AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME`);
          } else if (connection.type === 'mssql') {
            result = await executeQuery(connectionId, `SELECT name FROM sys.objects WHERE type = 'P' ORDER BY name`);
          }

          if (result && result.rows) {
            children = result.rows.map((row: any) => ({
              id: `${connectionId}-procedure-${row.name}`,
              type: 'procedure',
              name: row.name,
              connectionId,
              schemaName: node.schemaName,
            }));
          }
        } catch (err) {
          console.error('[DatabaseTree] Failed to load procedures:', err);
          children = [];
        }
      } else if (node.type === 'events') {
        // 事件文件夹 - MySQL 特有
        log.debug('[DatabaseTree] Loading events for schema:', node.schemaName);
        try {
          const { executeQuery } = await import("@/lib/tauri-commands");
          let sql = '';
          if (connection.type === 'mysql') {
            sql = `SELECT EVENT_NAME as name FROM INFORMATION_SCHEMA.EVENTS WHERE EVENT_SCHEMA = '${node.schemaName || connection.database}' ORDER BY EVENT_NAME`;
          }
          
          if (sql) {
            const result = await executeQuery(connectionId, sql);
            children = result.rows.map((row: any) => ({
              id: `${connectionId}-event-${row.name}`,
              type: 'event',
              name: row.name,
              connectionId,
              schemaName: node.schemaName,
            }));
          }
        } catch (err) {
          console.error('[DatabaseTree] Failed to load events:', err);
          children = [];
        }
      } else if (node.type === 'triggers') {
        // 触发器文件夹 - 使用 SQL 查询系统表获取触发器列表
        log.debug('[DatabaseTree] Loading triggers for schema:', node.schemaName);
        try {
          const { executeQuery } = await import("@/lib/tauri-commands");
          let sql = '';
          if (connection.type === 'postgresql' || connection.type === 'gaussdb' || connection.type === 'opengauss') {
            sql = `SELECT trigger_name as name FROM information_schema.triggers WHERE trigger_schema = '${node.schemaName || 'public'}' ORDER BY trigger_name`;
          } else if (connection.type === 'mysql') {
            sql = `SELECT TRIGGER_NAME as name FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = '${node.schemaName || connection.database}' ORDER BY TRIGGER_NAME`;
          } else if (connection.type === 'mssql') {
            sql = `SELECT name FROM sys.triggers WHERE parent_class_desc = 'OBJECT_OR_COLUMN' ORDER BY name`;
          } else if (connection.type === 'sqlite') {
            sql = `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`;
          } else if (connection.type === 'clickhouse') {
            children = [];
          }
          
          if (sql) {
            const result = await executeQuery(connectionId, sql);
            children = result.rows.map((row: any) => ({
              id: `${connectionId}-trigger-${row.name}`,
              type: 'trigger',
              name: row.name,
              connectionId,
              schemaName: node.schemaName,
            }));
          }
        } catch (err) {
          console.error('[DatabaseTree] Failed to load triggers:', err);
          children = [];
        }
      }
      
      const newTreeData = { ...treeData };
      newTreeData[node.id] = children;
      setTreeData(newTreeData);
      log.debug('[DatabaseTree] ✓ Successfully loaded children for node:', node.name);
    } catch (error) {
      console.error('[DatabaseTree] ✗ Failed to load children:', error);
    } finally {
      const newLoading = new Set(loadingNodes);
      newLoading.delete(node.id);
      setLoadingNodes(newLoading);
    }
  };

  // All database types now use DBeaver-style: top-level nodes are database nodes.
  // The store's schemaData entries are already database nodes from loadSchemaData.
  const treeNodes: TreeNode[] = schemas.length > 0
    ? (schemas as any[]).map((db: any) => ({
        id: db.id,
        type: 'database' as TreeNodeType,
        name: db.name,
        connectionId,
        databaseName: db.name,
        children: [],
        loaded: db.loaded ?? false,
      }))
    : [];

  return (
    <div className="pl-4">
      {treeNodes.map((node) => (
        <TreeNodeItem
          key={node.id}
          node={node}
          expandedNodes={expandedNodes}
          setExpandedNodes={setExpandedNodes}
          treeData={treeData}
          setTreeData={setTreeData}
          loadingNodes={loadingNodes}
          setLoadingNodes={setLoadingNodes}
          connectionId={connectionId}
          connectionType={connection.type}
          onToggleNode={handleToggleNode}
          onContextMenu={handleTreeNodeContextMenu}
          onRefresh={handleRefreshNode}
          onCopyName={handleCopyName}
          onTableClick={handleTableClick}
          onTableDoubleClick={handleTableDoubleClick}
          onObjectClick={handleObjectClick}
        />
      ))}
    </div>
  );
}

// ===== Tree Node Item =====

interface TreeNodeItemProps {
  node: TreeNode;
  expandedNodes: Set<string>;
  setExpandedNodes: (expanded: Set<string>) => void;
  treeData: Record<string, TreeNode[]>;
  setTreeData: (data: Record<string, TreeNode[]>) => void;
  loadingNodes: Set<string>;
  setLoadingNodes: (loading: Set<string>) => void;
  connectionId: string;
  connectionType?: string;
  onToggleNode: (node: TreeNode, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onRefresh: (node: TreeNode) => Promise<void>;
  onCopyName: (name: string) => void;
  onTableClick?: (table: TreeNode) => void;
  onTableDoubleClick?: (table: TreeNode) => void;
  onObjectClick?: (node: TreeNode) => void;
}

function TreeNodeItem({
  node,
  expandedNodes,
  setExpandedNodes,
  treeData,
  setTreeData,
  loadingNodes,
  setLoadingNodes,
  connectionId,
  connectionType,
  onToggleNode,
  onContextMenu,
  onRefresh,
  onCopyName,
  onTableClick,
  onTableDoubleClick,
  onObjectClick,
}: TreeNodeItemProps) {
  const isExpanded = expandedNodes.has(node.id);
  const isLoading = loadingNodes.has(node.id);
  const children = treeData[node.id] || [];
  const hasChildren = children.length > 0;

  const getIcon = () => {
    switch (node.type) {
      case 'database':
        return <DatabaseIcon type={connectionType || ''} connected={true} size={12} />;
      case 'schema':
        return <Layers size={12} className="text-[hsl(var(--tree-schema))]" />;
      case 'tables':
        return <TableIcon size={12} className="text-[hsl(var(--tree-table))]" />;
      case 'views':
        return <Eye size={12} className="text-[hsl(var(--tree-view))]" />;
      case 'functions':
        return <FileText size={12} className="text-[hsl(var(--tree-function))]" />;
      case 'procedures':
        return <Settings size={12} className="text-[hsl(var(--tree-procedure))]" />;
      case 'events':
        return <Calendar size={12} className="text-pink-500" />;
      case 'triggers':
        return <Zap size={12} className="text-[hsl(var(--tree-trigger))]" />;
      case 'table':
        return <TableIcon size={12} className="text-[hsl(var(--tree-table))]" />;
      case 'view':
        return <Eye size={12} className="text-[hsl(var(--tree-view))]" />;
      case 'function':
        return <FileText size={12} className="text-[hsl(var(--tree-function))]" />;
      default:
        return <Folder size={12} />;
    }
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1 hover:bg-muted/50 cursor-pointer text-xs"
        onClick={(e) => {
          // Single click: table/view -> highlight; leaf objects -> open definition; others -> toggle expand
          if (node.type === 'table' || node.type === 'view') {
            onTableClick?.(node);
          } else if (['function', 'procedure', 'trigger', 'event'].includes(node.type)) {
            onObjectClick?.(node);
          } else {
            onToggleNode(node, e);
          }
        }}
        onDoubleClick={(e) => {
          // Double click: table/view -> open data tab; leaf objects -> open definition
          if (node.type === 'table' || node.type === 'view') {
            e.stopPropagation();
            onTableDoubleClick?.(node);
          } else if (['function', 'procedure', 'trigger', 'event'].includes(node.type)) {
            e.stopPropagation();
            onObjectClick?.(node);
          }
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="p-0.5">
          {hasChildren || ['database', 'schema', 'tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type) ? (
            isExpanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="w-3" />
          )}
        </span>
        {isLoading ? (
          <Loader2 size={12} className="animate-spin text-muted-foreground" />
        ) : (
          getIcon()
        )}
        <span className="truncate">{node.name}</span>
      </div>
      
      {/* Render children */}
      {isExpanded && hasChildren && (
        <div className="pl-4">
          {children.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              expandedNodes={expandedNodes}
              setExpandedNodes={setExpandedNodes}
              treeData={treeData}
              setTreeData={setTreeData}
              loadingNodes={loadingNodes}
              setLoadingNodes={setLoadingNodes}
              connectionId={connectionId}
              connectionType={connectionType}
              onToggleNode={onToggleNode}
              onContextMenu={onContextMenu}
              onRefresh={onRefresh}
              onCopyName={onCopyName}
              onTableClick={onTableClick}
              onTableDoubleClick={onTableDoubleClick}
              onObjectClick={onObjectClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Connection Item =====

interface ConnectionItemProps {
  connection: Connection;
  isActive: boolean;
  isExpanded: boolean;
  isConnecting?: boolean;
  onToggleExpand: (e: React.MouseEvent) => void;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDisconnect: (connectionId: string) => void;
  openConnectionDialog: (editConnection?: Connection) => void;
}

function ConnectionItem({
  connection,
  isActive,
  isExpanded,
  isConnecting: isConnectingProp,
  onToggleExpand,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDisconnect,
  openConnectionDialog,
}: ConnectionItemProps) {
  const { removeConnection } = useConnectionStore();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug('[ConnectionItem] Connect/Disconnect button clicked for:', connection.name, 'Current status:', connection.connected ? 'connected' : 'disconnected');
    if (connection.connected) {
      // Update frontend immediately — don't wait for backend disconnect
      useConnectionStore.getState().updateConnection(connection.id, { connected: false });
      onDisconnect(connection.id);
      // Fire backend disconnect in background (non-blocking)
      disconnectDatabase(connection.id).catch((error) => {
        console.error('[ConnectionItem] Failed to disconnect from backend:', error);
      });
    } else {
      log.debug('[ConnectionItem] Connecting...');
      setIsConnecting(true);
      try {
        await connectDatabase(connection);
        log.debug('[ConnectionItem] ✓ Successfully connected');
        useConnectionStore.getState().updateConnection(connection.id, { connected: true, lastConnected: new Date() });
      } catch (error: any) {
        console.error('[ConnectionItem] ✗ Failed to connect:', error);
        alert(`连接失败：${error?.message || error}`);
      } finally {
        setIsConnecting(false);
      }
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug('[ConnectionItem] Edit button clicked for:', connection.name);
    openConnectionDialog(connection);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug('[ConnectionItem] Delete button clicked for:', connection.name);
    if (confirm(t('sidebar.confirmDeleteConnection', { name: connection.name }))) {
      log.debug('[ConnectionItem] Confirmed deletion of:', connection.name);
      removeConnection(connection.id);
    } else {
      log.debug('[ConnectionItem] Cancelled deletion of:', connection.name);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer text-xs border-l-2 transition-colors ${
        isActive
          ? "bg-[hsl(var(--tab-active))]/10 border-[hsl(var(--tab-active))] text-foreground"
          : "border-transparent hover:bg-muted/50 text-foreground"
      }`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Expand/Collapse arrow or loading spinner - only show when connected or connecting */}
      {isConnectingProp ? (
        <span className="p-0.5">
          <Loader2 size={12} className="animate-spin" />
        </span>
      ) : connection.connected ? (
        <button aria-label={isExpanded ? "折叠" : "展开"} onClick={onToggleExpand}
          className="p-0.5 hover:bg-muted rounded transition-colors"
          title={isExpanded ? "折叠" : "展开"}
        >
          {isExpanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
      ) : (
        <span className="w-5" />
      )}

      {/* Database icon */}
      <DatabaseIcon type={connection.type} connected={connection.connected} size={14} isActive={isActive} />

      {/* Connection name */}
      <span className={`flex-1 truncate ${!connection.connected ? 'text-muted-foreground/50' : ''}`}>{connection.name}</span>

      {/* Connection status and actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isConnecting ? (
          <Loader2 size={12} className="animate-spin text-muted-foreground" />
        ) : connection.connected ? (
          <>
            <button aria-label={t("sidebar.disconnect")} onClick={handleConnect}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title={t("sidebar.disconnect")}
            >
              <Unplug size={12} className="text-success" />
            </button>
            <button aria-label={t("sidebar.editConnection")} onClick={handleEdit}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title={t("sidebar.editConnection")}
            >
              <Edit size={12} />
            </button>
            <button aria-label={t("sidebar.deleteConnection")} onClick={handleDelete}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title={t("sidebar.deleteConnection")}
            >
              <Trash2 size={12} className="text-destructive" />
            </button>
          </>
        ) : (
          <>
            <button aria-label="连接" onClick={handleConnect}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="连接"
            >
              <Plug size={12} className="text-muted-foreground" />
            </button>
            <button aria-label={t("sidebar.editConnection")} onClick={handleEdit}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title={t("sidebar.editConnection")}
            >
              <Edit size={12} />
            </button>
            <button aria-label={t("sidebar.deleteConnection")} onClick={handleDelete}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title={t("sidebar.deleteConnection")}
            >
              <Trash2 size={12} className="text-destructive" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ===== Empty Connection List =====

function EmptyConnectionList({ openConnectionDialog }: { openConnectionDialog: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs px-4 text-center">
      <Database size={32} className="mb-3 opacity-30" />
      <p className="text-sm font-medium mb-2">{t('sidebar.noConnections')}</p>
      <p className="text-[11px] text-muted-foreground/60 mb-3">
        {t('sidebar.noConnectionsHint')}
      </p>
      <button
        onClick={() => openConnectionDialog()}
        className="flex items-center gap-1.5 px-4 py-2 bg-[hsl(var(--tab-active))] text-white rounded text-xs hover:opacity-90 transition-opacity"
      >
        <Plus size={14} />
        <span>{t('sidebar.newConnection')}</span>
      </button>
    </div>
  );
}

export default Sidebar;
