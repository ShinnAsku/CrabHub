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
  FileText,
  Settings,
  Zap,
  Calendar,
  RefreshCw,
  Wrench,
  Eraser,
  Copy,
  Database,
} from "lucide-react";
import { useConnectionStore, useUIStore, useTabStore } from "@/stores/app-store";
import type { Connection } from "@/types";
import { t } from "@/lib/i18n";
import { 
  connectDatabase, 
  disconnectDatabase, 
  getSchemas,
  getTables,
  getViews,
} from "@/lib/tauri-commands";
import QueryHistory from "./QueryHistory";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import DatabaseIcon from "./DatabaseIcon";
import { generateCopyTableName, buildDuplicateTableSQL } from "@/lib/export";

interface SidebarProps {
  openConnectionDialog: (editConnection?: Connection) => void;
}

type SidebarView = "connections" | "history";

// Node types for database tree
type TreeNodeType = 'connection' | 'database' | 'schema' | 'tables' | 'views' | 'functions' | 'procedures' | 'events' | 'triggers' | 'table' | 'view' | 'function' | 'procedure' | 'event' | 'trigger';

interface TreeNode {
  id: string;
  type: TreeNodeType;
  name: string;
  connectionId?: string;
  databaseName?: string;
  schemaName?: string;
  children?: TreeNode[];
  loaded?: boolean;
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
    console.log('[Sidebar] Loading schema data for connection:', connectionId);
    try {
      const schemaNames = await getSchemas(connectionId);
      console.log('[Sidebar] Loaded schemas:', schemaNames);
      
      // Only create schema-level nodes (lazy loading - children loaded on expand)
      const schemaNodes = schemaNames.map((name) => ({
        id: `${connectionId}-schema-${name}`,
        name,
        type: 'schema' as const,
        connectionId,
        loaded: false,
      }));
      
      setSchemaData(connectionId, schemaNodes);
      console.log('[Sidebar] Schema data loaded:', schemaNodes.length, 'schemas');
    } catch (error) {
      console.error('[Sidebar] Failed to load schema data:', error);
    }
  };

  // Handle tree node context menu
  const handleTreeNodeContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Sidebar] Right-click on tree node:', node.name, 'Type:', node.type);
    setTreeNodeContextMenu({
      x: e.clientX,
      y: e.clientY,
      node,
    });
  };

  // Handle refresh tree node - will be implemented in DatabaseTree
  const handleRefreshNode = async (node: TreeNode) => {
    console.log('[Sidebar] Refreshing node:', node.name);
    // This will be called from DatabaseTree with the actual implementation
  };

  // Handle copy name
  const handleCopyName = (name: string) => {
    navigator.clipboard.writeText(name);
    console.log('[Sidebar] Copied to clipboard:', name);
  };

  // Handle create database from context menu
  const handleCreateDatabase = (connectionId: string) => {
    console.log('[Sidebar] Opening create database dialog for:', connectionId);
    setCreateDbConnectionId(connectionId);
    setCreateDbDialogOpen(true);
  };

  // Handle database created successfully
  const handleDatabaseCreated = async (connectionId: string) => {
    console.log('[Sidebar] Database created, refreshing for:', connectionId);
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
    console.log('[Sidebar] New query for node:', node.name, 'connectionId:', node.connectionId);
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
  const handleDeleteTable = async (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    const msg = t('sidebar.confirmDeleteTable', { name: node.name });
    if (!window.confirm(msg)) return;
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
  };

  // Handle truncate table from context menu
  const handleTruncateTable = async (node: TreeNode) => {
    const connId = node.connectionId;
    if (!connId) return;
    const msg = t('sidebar.confirmTruncateTable', { name: node.name });
    if (!window.confirm(msg)) return;
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
    <div className="flex flex-col h-full bg-sidebar-bg">
      {/* Mini Toolbar */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-sidebar-border shrink-0">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setView("connections")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
              view === "connections"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            title={t('sidebar.connections')}
          >
            <Database size={12} />
            <span>{t('sidebar.connections')}</span>
          </button>
          <button
            onClick={() => setView("history")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
              view === "history"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            title={t('sidebar.history')}
          >
            <Clock size={12} />
            <span>{t('history.title')}</span>
          </button>
        </div>
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
    console.log('[ConnectionList] Loading schema data for connection:', connectionId);
    try {
      const schemaNames = await getSchemas(connectionId);
      console.log('[ConnectionList] Loaded schemas:', schemaNames);
      
      const schemaNodes = schemaNames.map((name) => ({
        id: `${connectionId}-schema-${name}`,
        name,
        type: 'schema' as const,
        connectionId,
        loaded: false,
      }));
      
      setSchemaData(connectionId, schemaNodes);
      console.log('[ConnectionList] Schema data loaded:', schemaNodes.length, 'schemas');
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
      console.log('[Sidebar] connectAndExpand: already connecting, skip', connection.name);
      return;
    }
    console.log('[Sidebar] connectAndExpand:', connection.name);
    setConnectingIds(prev => new Set(prev).add(connection.id));
    try {
      await connectDatabase(connection);
      console.log('[Sidebar] ✓ Connected:', connection.name);
      useConnectionStore.getState().updateConnection(connection.id, { connected: true, lastConnected: new Date() });
      setExpandedConnections(prev => {
        const next = new Set(prev);
        next.add(connection.id);
        return next;
      });
      await loadSchemaData(connection.id);
    } catch (error: any) {
      console.error('[Sidebar] ✗ Failed to connect:', connection.name, error);
      alert(`连接失败: ${error?.message || error}`);
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
    console.log(`[Sidebar] handleContextMenu: 右键菜单打开 -> ${connection?.name || connectionId}, 位置=(${e.clientX}, ${e.clientY})`);
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
                正在连接...
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
                请先连接数据库
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
    default:
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

  const isMySQL = connection.type === 'mysql';
  const supportedCategories = getSupportedCategories(connection.type);

  const handleToggleNode = async (node: TreeNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const nodeId = node.id;
    console.log('[DatabaseTree] Node clicked:', node.name, 'Type:', node.type, 'Expanded:', expandedNodes.has(nodeId));
    
    // Set selectedContext based on node type
    if (node.type === 'schema') {
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedSchemaName(node.name);
      useUIStore.getState().setSelectedContext({
        type: "schema",
        connectionId,
        schemaName: node.name,
      });
      console.log('[DatabaseTree] Selected schema:', node.name);
    } else if (node.type === 'database') {
      // For MySQL, database node click sets schema context (MySQL schema == database)
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedSchemaName(node.name);
      useUIStore.getState().setSelectedContext({
        type: "schema",
        connectionId,
        schemaName: node.name,
      });
      console.log('[DatabaseTree] Selected database (as schema):', node.name);
    } else if (['tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type)) {
      useConnectionStore.getState().setActiveConnection(connectionId);
      useUIStore.getState().setSelectedContext({
        type: "folder",
        connectionId,
        schemaName: node.schemaName || undefined,
        folderType: node.type,
      });
      console.log('[DatabaseTree] Selected folder:', node.type, 'in schema:', node.schemaName);
    }
    
    const newExpanded = new Set(expandedNodes);
    
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
      setExpandedNodes(newExpanded);
      console.log('[DatabaseTree] Collapsed node:', node.name);
    } else {
      newExpanded.add(nodeId);
      setExpandedNodes(newExpanded);
      console.log('[DatabaseTree] Expanded node:', node.name);
      
      // Load children if not loaded - support all folder types + database (for MySQL)
      if (!node.loaded && ['database', 'schema', 'tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type)) {
        console.log('[DatabaseTree] Loading children for node:', node.name);
        await loadDatabaseChildren(node);
      }
    }
  };

  // Handle table single-click - only highlight and set context (no tab opening)
  const handleTableClick = (table: TreeNode) => {
    console.log('[DatabaseTree] Table single-clicked:', table.name);
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
    console.log('[DatabaseTree] Table double-clicked:', table.name);
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
    console.log('[DatabaseTree] Object clicked:', node.name, 'Type:', node.type);
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
        // Try common column names for definition
        const def = row['definition'] || row['Definition'] || row['DEFINITION']
          || row['Create View'] || row['Create Function'] || row['Create Procedure']
          || row['Create Trigger'] || row['Create Event']
          || row['sql'] || row['SQL Original Statement']
          || Object.values(row).find((v: unknown) => typeof v === 'string' && (v as string).length > 20)
          || '';
        content += String(def);
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
      if (node.type === 'database' && isMySQL) {
        // MySQL database node: create category folders based on supported types
        console.log('[DatabaseTree] Creating MySQL category folders for database:', node.name);
        children = supportedCategories.map(cat => ({
          id: `${node.id}-${cat}`,
          type: cat,
          name: categoryNames[cat] || cat,
          connectionId: node.connectionId,
          databaseName: node.name,
          schemaName: node.name,
          children: [],
          loaded: false,
        }));
        console.log('[DatabaseTree] Created', children.length, 'MySQL category folders');
      } else if (node.type === 'schema') {
        // Schema 节点下创建分类文件夹：表、视图、函数、存储过程、触发器
        console.log('[DatabaseTree] Creating category folders for schema:', node.name);
        children = supportedCategories.map(cat => ({
          id: `${node.id}-${cat}`,
          type: cat,
          name: categoryNames[cat] || cat,
          connectionId: node.connectionId,
          databaseName: node.databaseName,
          schemaName: node.name,
          children: [],
          loaded: false,
        }));
        console.log('[DatabaseTree] Created', children.length, 'category folders');
      } else if (node.type === 'tables') {
        // 表文件夹 - 加载实际的表列表（按 schema 过滤）
        console.log('[DatabaseTree] Loading tables for schema:', node.schemaName);
        const tables = await getTables(connectionId);
        const filtered = node.schemaName
          ? tables.filter((table: any) => !table.schema || table.schema === node.schemaName)
          : tables;
        console.log('[DatabaseTree] Loaded', filtered.length, 'tables (total:', tables.length, ')');
        children = filtered.map((table: any) => ({
          id: `${connectionId}-${node.schemaName || 'default'}-table-${table.name}`,
          type: 'table',
          name: table.name,
          connectionId,
          schemaName: node.schemaName,
        }));
      } else if (node.type === 'views') {
        // 视图文件夹 - 加载实际的视图列表
        console.log('[DatabaseTree] Loading views for schema:', node.schemaName);
        try {
          const views = await getViews(connectionId, node.schemaName || undefined);
          console.log('[DatabaseTree] Loaded', views.length, 'views');
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
        console.log('[DatabaseTree] Loading functions for schema:', node.schemaName);
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
        console.log('[DatabaseTree] Loading procedures for schema:', node.schemaName);
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
        console.log('[DatabaseTree] Loading events for schema:', node.schemaName);
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
        console.log('[DatabaseTree] Loading triggers for schema:', node.schemaName);
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
      console.log('[DatabaseTree] ✓ Successfully loaded children for node:', node.name);
    } catch (error) {
      console.error('[DatabaseTree] ✗ Failed to load children:', error);
    } finally {
      const newLoading = new Set(loadingNodes);
      newLoading.delete(node.id);
      setLoadingNodes(newLoading);
    }
  };

  // Build tree nodes from schemas - different strategy for MySQL vs PG
  const dbName = connection.database || "default";
  const dbNodeId = `${connectionId}-db-${dbName}`;

  // Sync schema children into treeData and auto-expand via useEffect
  useEffect(() => {
    if (schemas.length === 0) return;

    if (isMySQL) {
      // MySQL: each schema from getSchemas is a database - no wrapping needed.
      // treeData for each database node will be loaded lazily on expand.
      // No need to pre-populate treeData here.
    } else {
      // PG/others: wrap schemas in a single database node
      const schemaChildren: TreeNode[] = schemas.map((schema) => ({
        id: `${connectionId}-schema-${schema.name}`,
        type: 'schema',
        name: schema.name,
        connectionId,
        databaseName: dbName,
        children: [],
        loaded: false,
      }));

      const currentChildren = treeData[dbNodeId];
      if (!currentChildren || currentChildren.length !== schemaChildren.length) {
        const newTreeData = { ...treeData, [dbNodeId]: schemaChildren };
        setTreeData(newTreeData);
      }

      if (!expandedNodes.has(dbNodeId)) {
        const newExpanded = new Set(expandedNodes);
        newExpanded.add(dbNodeId);
        setExpandedNodes(newExpanded);
      }
    }
  }, [schemas, dbNodeId, isMySQL]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build top-level tree nodes
  let treeNodes: TreeNode[] = [];
  if (schemas.length > 0) {
    if (isMySQL) {
      // MySQL: each schema is a database node directly
      treeNodes = schemas.map((schema) => ({
        id: `${connectionId}-db-${schema.name}`,
        type: 'database' as TreeNodeType,
        name: schema.name,
        connectionId,
        databaseName: schema.name,
        children: [],
        loaded: false,
      }));
    } else {
      // PG/others: single database wrapper node
      treeNodes = [{
        id: dbNodeId,
        type: 'database',
        name: dbName,
        connectionId,
        databaseName: dbName,
        children: [],
        loaded: true,
      }];
    }
  }

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
        return <Folder size={12} className="text-yellow-500" />;
      case 'tables':
        return <TableIcon size={12} className="text-green-500" />;
      case 'views':
        return <Eye size={12} className="text-purple-500" />;
      case 'functions':
        return <FileText size={12} className="text-orange-500" />;
      case 'procedures':
        return <Settings size={12} className="text-red-500" />;
      case 'events':
        return <Calendar size={12} className="text-pink-500" />;
      case 'triggers':
        return <Zap size={12} className="text-yellow-600" />;
      case 'table':
        return <TableIcon size={12} className="text-green-500" />;
      case 'view':
        return <Eye size={12} className="text-purple-500" />;
      case 'function':
        return <FileText size={12} className="text-orange-500" />;
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
    console.log('[ConnectionItem] Connect/Disconnect button clicked for:', connection.name, 'Current status:', connection.connected ? 'connected' : 'disconnected');
    if (connection.connected) {
      console.log('[ConnectionItem] Disconnecting...');
      try {
        await disconnectDatabase(connection.id);
        console.log('[ConnectionItem] ✓ Successfully disconnected');
      } catch (error) {
        console.error('[ConnectionItem] ✗ Failed to disconnect from backend:', error);
      }
      // Always update frontend state when user explicitly disconnects
      useConnectionStore.getState().updateConnection(connection.id, { connected: false });
      onDisconnect(connection.id);
      console.log('[ConnectionItem] Updated connection status to disconnected');
    } else {
      console.log('[ConnectionItem] Connecting...');
      setIsConnecting(true);
      try {
        await connectDatabase(connection);
        console.log('[ConnectionItem] ✓ Successfully connected');
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
    console.log('[ConnectionItem] Edit button clicked for:', connection.name);
    openConnectionDialog(connection);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[ConnectionItem] Delete button clicked for:', connection.name);
    if (confirm(`确定要删除连接 "${connection.name}" 吗？`)) {
      console.log('[ConnectionItem] Confirmed deletion of:', connection.name);
      removeConnection(connection.id);
    } else {
      console.log('[ConnectionItem] Cancelled deletion of:', connection.name);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer text-xs border-l-2 transition-colors ${
        isActive
          ? "bg-[hsl(var(--tab-active))] text-white border-[hsl(var(--tab-active))]"
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
        <button
          onClick={onToggleExpand}
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
      <span className="flex-1 truncate">{connection.name}</span>

      {/* Connection status and actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isConnecting ? (
          <Loader2 size={12} className="animate-spin text-muted-foreground" />
        ) : connection.connected ? (
          <>
            <button
              onClick={handleConnect}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="断开连接"
            >
              <Unplug size={12} className="text-green-500" />
            </button>
            <button
              onClick={handleEdit}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="编辑"
            >
              <Edit size={12} />
            </button>
            <button
              onClick={handleDelete}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="删除"
            >
              <Trash2 size={12} className="text-red-500" />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleConnect}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="连接"
            >
              <Plug size={12} className="text-muted-foreground" />
            </button>
            <button
              onClick={handleEdit}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="编辑"
            >
              <Edit size={12} />
            </button>
            <button
              onClick={handleDelete}
              className="p-0.5 hover:bg-muted rounded transition-colors"
              title="删除"
            >
              <Trash2 size={12} className="text-red-500" />
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
      <p className="text-sm font-medium mb-2">暂无连接</p>
      <p className="text-[10px] text-muted-foreground/60 mb-3">
        点击下方按钮创建新的数据库连接
      </p>
      <button
        onClick={() => openConnectionDialog()}
        className="flex items-center gap-1.5 px-4 py-2 bg-[hsl(var(--tab-active))] text-white rounded text-xs hover:opacity-90 transition-opacity"
      >
        <Plus size={14} />
        <span>新建连接</span>
      </button>
    </div>
  );
}

// ===== Context Menu =====

interface ContextMenuProps {
  x: number;
  y: number;
  connectionId: string;
  onClose: () => void;
  openConnectionDialog: (editConnection?: Connection) => void;
  expandedConnections: Set<string>;
  setExpandedConnections: React.Dispatch<React.SetStateAction<Set<string>>>;
  onCreateDatabase: (connectionId: string) => void;
}

interface TreeNodeContextMenuProps {
  x: number;
  y: number;
  node: TreeNode;
  onClose: () => void;
  onRefresh: (node: TreeNode) => Promise<void>;
  onCopyName: (name: string) => void;
  onNewQuery?: (node: TreeNode) => void;
  onDesignTable?: (node: TreeNode) => void;
  onOpenTable?: (node: TreeNode) => void;
  onDuplicateTable?: (node: TreeNode, includeData: boolean) => void;
  onDeleteTable?: (node: TreeNode) => void;
  onTruncateTable?: (node: TreeNode) => void;
}

function ContextMenu({ x, y, connectionId, onClose, openConnectionDialog, expandedConnections, setExpandedConnections, onCreateDatabase }: ContextMenuProps) {
  const { connections, removeConnection } = useConnectionStore();
  const connection = connections.find((c) => c.id === connectionId);

  if (!connection) {
    console.warn('[ContextMenu] Connection not found:', connectionId);
    return null;
  }

  console.log('[ContextMenu] Context menu opened for:', connection.name, 'Status:', connection.connected ? 'connected' : 'disconnected');

  const handleConnect = async () => {
    console.log('[ContextMenu] Connect/Disconnect clicked for:', connection.name, 'Current status:', connection.connected ? 'connected' : 'disconnected');
    if (connection.connected) {
      console.log('[ContextMenu] Disconnecting...');
      try {
        await disconnectDatabase(connection.id);
        console.log('[ContextMenu] ✓ Successfully disconnected');
      } catch (error) {
        console.error('[ContextMenu] ✗ Failed to disconnect from backend:', error);
      }
      // Always update frontend state when user explicitly disconnects
      useConnectionStore.getState().updateConnection(connection.id, { connected: false });
      console.log('[ContextMenu] Updated connection status to disconnected');
      // Collapse the connection after disconnecting
      const newExpanded = new Set(expandedConnections);
      newExpanded.delete(connection.id);
      setExpandedConnections(newExpanded);
      console.log('[ContextMenu] Collapsed connection after disconnect:', connection.name);
    } else {
      console.log('[ContextMenu] Connecting...');
      try {
        await connectDatabase(connection);
        console.log('[ContextMenu] ✓ Successfully connected');
        // Update connection status to true
        useConnectionStore.getState().updateConnection(connection.id, { connected: true });
        console.log('[ContextMenu] Updated connection status to connected');
        // Auto-expand the connection after connecting
        const newExpanded = new Set(expandedConnections);
        newExpanded.add(connection.id);
        setExpandedConnections(newExpanded);
        console.log('[ContextMenu] Auto-expanded connection:', connection.name);
      } catch (error) {
        console.error('[ContextMenu] ✗ Failed to connect:', error);
      }
    }
    onClose();
  };

  const handleEdit = () => {
    console.log('[ContextMenu] Edit clicked for:', connection.name);
    openConnectionDialog(connection);
    onClose();
  };

  const handleDelete = () => {
    console.log('[ContextMenu] Delete clicked for:', connection.name);
    if (confirm(`确定要删除连接 "${connection.name}" 吗？`)) {
      console.log('[ContextMenu] Confirmed deletion of:', connection.name);
      removeConnection(connection.id);
    } else {
      console.log('[ContextMenu] Cancelled deletion of:', connection.name);
    }
    onClose();
  };

  const handleRefresh = async () => {
    console.log('[ContextMenu] Refresh clicked for:', connection.name);
    // Refresh schema data
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[160px]"
        style={{ left: x, top: y, backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
      >
        <div className="px-3 py-1.5 text-xs font-medium border-b border-border mb-1">
          {connection.name}
        </div>
        
        {!connection.connected ? (
          <button
            onClick={handleConnect}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <Plug size={12} />
            <span>连接</span>
          </button>
        ) : (
          <>
            <button
              onClick={handleConnect}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              <Unplug size={12} />
              <span>断开连接</span>
            </button>
            <button
              onClick={handleRefresh}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              <RefreshCw size={12} />
              <span>刷新</span>
            </button>
            {connection.type !== 'sqlite' && (
              <button
                onClick={() => {
                  onCreateDatabase(connectionId);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <Database size={12} />
                <span>{t('createDb.title')}</span>
              </button>
            )}
          </>
        )}

        <button
          onClick={handleEdit}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
        >
          <Edit size={12} />
          <span>编辑</span>
        </button>

        <div className="border-t border-border my-1" />

        <button
          onClick={handleDelete}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-red-500"
        >
          <Trash2 size={12} />
          <span>删除</span>
        </button>
      </div>
    </>
  );
}

// ===== Tree Node Context Menu =====

function TreeNodeContextMenu({ x, y, node, onClose, onRefresh, onCopyName, onNewQuery, onDesignTable, onOpenTable, onDuplicateTable, onDeleteTable, onTruncateTable }: TreeNodeContextMenuProps) {
  const handleNewQueryClick = () => {
    onNewQuery?.(node);
    onClose();
  };

  const handleRefreshClick = async () => {
    await onRefresh(node);
    onClose();
  };

  const handleCopyClick = () => {
    onCopyName(node.name);
    onClose();
  };

  const handleDesignClick = () => {
    onDesignTable?.(node);
    onClose();
  };

  const handleOpenTableClick = () => {
    onOpenTable?.(node);
    onClose();
  };

  const handleDuplicateStructureClick = () => {
    onDuplicateTable?.(node, false);
    onClose();
  };

  const handleDuplicateStructureAndDataClick = () => {
    onDuplicateTable?.(node, true);
    onClose();
  };

  const handleDeleteClick = () => {
    onDeleteTable?.(node);
    onClose();
  };

  const handleTruncateClick = () => {
    onTruncateTable?.(node);
    onClose();
  };

  const isTable = node.type === 'table';
  const canRefresh = ['database', 'schema', 'tables', 'views', 'functions', 'procedures', 'events', 'triggers'].includes(node.type);
  const canNewQuery = ['database', 'schema', 'table'].includes(node.type);

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[160px]"
        style={{ left: x, top: y, backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
      >
        <div className="px-3 py-1.5 text-xs font-medium border-b border-border mb-1">
          {node.name}
        </div>

        {isTable && onDesignTable && (
          <button
            onClick={handleDesignClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <Wrench size={12} />
            <span>{t('sidebar.designTable')}</span>
          </button>
        )}

        {isTable && onOpenTable && (
          <button
            onClick={handleOpenTableClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <TableIcon size={12} />
            <span>{t('sidebar.openTable')}</span>
          </button>
        )}

        {canNewQuery && onNewQuery && (
          <button
            onClick={handleNewQueryClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <FileText size={12} />
            <span>{t('sidebar.newQuery')}</span>
          </button>
        )}

        {isTable && <div className="border-t border-border my-1" />}

        <button
          onClick={handleCopyClick}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
        >
          <FileText size={12} />
          <span>复制名称</span>
        </button>
        
        {canRefresh && (
          <button
            onClick={handleRefreshClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <RefreshCw size={12} />
            <span>刷新</span>
          </button>
        )}

        {isTable && onDuplicateTable && (
          <>
            <div className="border-t border-border my-1" />
            {/* Duplicate Table - Navicat-style hover submenu */}
            <div className="relative group/dup">
              <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted transition-colors cursor-default">
                <span className="flex items-center gap-2">
                  <Copy size={12} />
                  {t('sidebar.duplicateTable')}
                </span>
                <ChevronRight size={12} className="text-muted-foreground" />
              </div>
              {/* Submenu */}
              <div className="absolute left-full top-0 ml-0 hidden group-hover/dup:block z-[60]">
                <div
                  className="border border-border rounded-md shadow-lg py-1 min-w-[150px]"
                  style={{ backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
                >
                  <button
                    onClick={handleDuplicateStructureAndDataClick}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                  >
                    <span>{t('sidebar.structureAndData')}</span>
                  </button>
                  <button
                    onClick={handleDuplicateStructureClick}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                  >
                    <span>{t('sidebar.structureOnly')}</span>
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {isTable && (
          <>
            <div className="border-t border-border my-1" />
            <button
              onClick={handleTruncateClick}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-orange-500"
            >
              <Eraser size={12} />
              <span>{t('sidebar.truncateTable')}</span>
            </button>
            <button
              onClick={handleDeleteClick}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-destructive"
            >
              <Trash2 size={12} />
              <span>{t('sidebar.deleteTable')}</span>
            </button>
          </>
        )}

        <div className="border-t border-border my-1" />
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
          类型：{node.type}
        </div>
      </div>
    </>
  );
}

export default Sidebar;
