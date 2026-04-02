import { useState, useCallback, useRef, useEffect } from "react";
import {
  Database,
  Terminal,
  Plus,
  ChevronRight,
  ChevronDown,
  Table,
  Columns,
  Eye,
  Plug,
  Unplug,
  Trash2,
  Edit,
  RefreshCw,
  Loader2,
  Clock,
} from "lucide-react";
import { useAppStore, type Connection, type SchemaNode } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import {
  connectDatabase,
  disconnectDatabase,
  getTables,
  getColumns,
  getSchemas,
  exportTableSql,
  getConnectionStatus,
} from "@/lib/tauri-commands";
import { downloadFile } from "@/lib/export";
import QueryHistory from "./QueryHistory";

interface SidebarProps {
  openConnectionDialog: (editConnection?: Connection) => void;
  onSchemaClick?: (schemaName: string, connectionId: string) => void;
  onTableClick?: (table: SchemaNode, connectionId: string) => void;
}

type SidebarView = "connections" | "history";

function Sidebar({ openConnectionDialog, onSchemaClick, onTableClick: _onTableClick }: SidebarProps) {
  const [view, setView] = useState<SidebarView>("connections");

  return (
    <div className="flex flex-col h-full bg-sidebar-bg">
      {/* Mini Toolbar: toggle between connections and history */}
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
        {view === "connections" && (
          <button
            className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={() => openConnectionDialog()}
            title={t('sidebar.newConnection')}
          >
            <Plus size={12} />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {view === "connections" ? (
          <ConnectionList openConnectionDialog={openConnectionDialog} onSchemaClick={onSchemaClick} onTableClick={_onTableClick} />
        ) : (
          <QueryHistory />
        )}
      </div>
    </div>
  );
}

// ===== Connection List =====

function ConnectionList({
  openConnectionDialog,
  onSchemaClick,
  onTableClick,
}: {
  openConnectionDialog: (editConnection?: Connection) => void;
  onSchemaClick?: (schemaName: string, connectionId: string) => void;
  onTableClick?: (table: SchemaNode, connectionId: string) => void;
}) {
  const { connections } = useAppStore();

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs px-4 text-center">
        <Database size={24} className="mb-2 opacity-30" />
        <p>{t('sidebar.noConnections')}</p>
        <p className="text-[10px] mt-1 text-muted-foreground/60">
          {t('sidebar.noConnectionsHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      {connections.map((conn) => (
        <ConnectionItem
          key={conn.id}
          connection={conn}
          openConnectionDialog={openConnectionDialog}
          onSchemaClick={onSchemaClick}
          onTableClick={onTableClick}
        />
      ))}
    </div>
  );
}

// ===== Connection Item =====

function ConnectionItem({
  connection,
  openConnectionDialog,
  onSchemaClick,
  onTableClick,
}: {
  connection: Connection;
  openConnectionDialog: (editConnection?: Connection) => void;
  onSchemaClick?: (schemaName: string, connectionId: string) => void;
  onTableClick?: (table: SchemaNode, connectionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<"healthy" | "unhealthy" | "unknown">("unknown");
  const contextRef = useRef<HTMLDivElement>(null);

  const {
    updateConnection,
    removeConnection,
    setActiveConnection,
    setSchemaData,
    schemaData,
    addTab,
    tabs,
  } = useAppStore();

  const typeColors: Record<string, string> = {
    postgresql: "#336791",
    mysql: "#4479A1",
    sqlite: "#44A05E",
    mssql: "#CC2927",
    clickhouse: "#FFCC00",
    gaussdb: "#1E3A5F",
  };

  const schema = schemaData[connection.id];

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    if (contextMenu) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [contextMenu]);

  // Periodic health check for connected databases
  useEffect(() => {
    if (!connection.connected) {
      setHealthStatus("unknown");
      return;
    }

    const checkHealth = async () => {
      try {
        const status = await getConnectionStatus(connection.id);
        setHealthStatus(status.healthy ? "healthy" : "unhealthy");
      } catch {
        setHealthStatus("unhealthy");
      }
    };

    // Initial check
    checkHealth();

    // Periodic check every 30s
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [connection.id, connection.connected]);

  const fetchSchema = useCallback(async () => {
    if (!connection.connected) return;
    setLoading(true);
    try {
      const schemas = await getSchemas(connection.id);
      const tables = await getTables(connection.id);

      const nodes: SchemaNode[] = [];

      // Check if tables have schema information
      const hasSchemaInfo = tables.some(t => t.schema);

      if (schemas.length > 0 || hasSchemaInfo) {
        // Multi-schema database (PostgreSQL, MySQL, etc.)
        // Get all unique schemas from tables if schemas is empty
        const allSchemas = schemas.length > 0 
          ? schemas 
          : [...new Set(tables.map(t => t.schema).filter(Boolean))] as string[];

        for (const schemaName of allSchemas) {
          const schemaTables = tables.filter((t) => t.schema === schemaName);
          const tableNodes: SchemaNode[] = [];

          for (const table of schemaTables) {
            let columns: SchemaNode[] = [];
            try {
              const cols = await getColumns(connection.id, table.name, table.schema);
              columns = cols.map((col) => ({
                id: `${connection.id}-${schemaName}-${table.name}-${col.name}`,
                name: col.name,
                type: "column" as const,
                schema: schemaName,
                icon: col.isPrimaryKey ? "key" : "column",
              }));
            } catch {
              // Skip columns on error
            }

            tableNodes.push({
              id: `${connection.id}-${schemaName}-${table.name}`,
              name: table.name,
              type: table.type,
              schema: schemaName,
              icon: table.type === "view" ? "view" : "table",
              children: columns,
            });
          }

          nodes.push({
            id: `${connection.id}-${schemaName}`,
            name: schemaName,
            type: "schema",
            children: tableNodes,
          });
        }
      } else {
        // Single-schema database (SQLite, etc.)
        const tableNodes: SchemaNode[] = [];
        for (const table of tables) {
          let columns: SchemaNode[] = [];
          try {
            const cols = await getColumns(connection.id, table.name);
            columns = cols.map((col) => ({
              id: `${connection.id}-${table.name}-${col.name}`,
              name: col.name,
              type: "column" as const,
              icon: col.isPrimaryKey ? "key" : "column",
            }));
          } catch {
            // Skip columns on error
          }

          tableNodes.push({
            id: `${connection.id}-${table.name}`,
            name: table.name,
            type: table.type,
            icon: table.type === "view" ? "view" : "table",
            children: columns,
          });
        }
        nodes.push(...tableNodes);
      }

      setSchemaData(connection.id, nodes);
    } catch (err) {
      console.error("Schema fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [connection, setSchemaData]);

  const handleConnect = useCallback(async () => {
    if (connection.connected) {
      try {
        await disconnectDatabase(connection.id);
        updateConnection(connection.id, { connected: false });
        setExpanded(false);
      } catch {
        // Ignore disconnect errors
      }
    } else {
      setLoading(true);
      try {
        await connectDatabase({
          id: connection.id,
          name: connection.name,
          type: connection.type,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          password: connection.password || "",
          database: connection.database,
          sslEnabled: connection.sslEnabled,
        });
        updateConnection(connection.id, { connected: true });
        setActiveConnection(connection.id);
        await fetchSchema();
        setExpanded(true);
      } catch {
        // Connection failed
      } finally {
        setLoading(false);
      }
    }
  }, [connection, updateConnection, setActiveConnection, fetchSchema]);

  const handleToggleExpand = useCallback(async () => {
    if (!expanded && connection.connected) {
      if (!schema) {
        await fetchSchema();
      }
      setActiveConnection(connection.id);
    }
    setExpanded(!expanded);
  }, [expanded, connection, schema, fetchSchema, setActiveConnection]);

  const handleDoubleClickTable = useCallback(
    (node: SchemaNode) => {
      const schemaPrefix = node.schema ? `${node.schema}.` : "";
      const sql = `SELECT * FROM ${schemaPrefix}${node.name} LIMIT 100;`;
      addTab({
        title: `${node.name}`,
        type: "query",
        content: sql,
        connectionId: connection.id,
        modified: false,
      });
    },
    [tabs, addTab, connection.id]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    []
  );

  const handleDelete = useCallback(() => {
    removeConnection(connection.id);
    setContextMenu(null);
  }, [connection.id, removeConnection]);

  const handleEdit = useCallback(() => {
    openConnectionDialog(connection);
    setContextMenu(null);
  }, [connection, openConnectionDialog]);

  return (
    <div ref={contextRef}>
      <div
        className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded transition-colors hover:bg-muted text-left group cursor-pointer"
        onClick={handleToggleExpand}
        onContextMenu={handleContextMenu}
      >
        {/* Expand arrow */}
        {connection.connected ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3" />
        )}

        {/* Status dot */}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            !connection.connected
              ? "bg-muted-foreground/40"
              : healthStatus === "healthy"
                ? "bg-green-500"
                : healthStatus === "unhealthy"
                  ? "bg-red-500"
                  : "bg-yellow-500"
          }`}
        />

        {/* Type icon */}
        <Database
          size={13}
          className="shrink-0"
          style={{ color: typeColors[connection.type] || connection.color }}
        />

        {/* Name */}
        <span className="truncate text-sidebar-foreground flex-1">
          {connection.name}
        </span>

        {/* Reconnect count badge */}
        {connection.health && connection.health.reconnectCount > 0 && (
          <span className="text-[8px] px-1 rounded bg-yellow-500/20 text-yellow-500 shrink-0">
            {connection.health.reconnectCount}
          </span>
        )}

        {/* Loading indicator */}
        {loading && <Loader2 size={11} className="animate-spin text-muted-foreground shrink-0" />}
      </div>

      {/* Schema Tree */}
      {expanded && connection.connected && schema && (
        <div className="ml-3 pl-2 border-l border-sidebar-border/50">
          {schema.map((node) => (
            <SchemaTreeNode
              key={node.id}
              node={node}
              depth={0}
              onDoubleClickTable={handleDoubleClickTable}
              onSchemaClick={onSchemaClick}
              onTableClick={onTableClick}
              connectionId={connection.id}
            />
          ))}
          {schema.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-muted-foreground">
              {t('sidebar.noTables')}
            </div>
          )}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-background border border-border rounded shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              handleConnect();
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
          >
            {connection.connected ? <Unplug size={12} /> : <Plug size={12} />}
            {connection.connected ? t('sidebar.disconnect') : t('sidebar.connect')}
          </button>
          <button
            onClick={handleEdit}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
          >
            <Edit size={12} />
            {t('common.edit')}
          </button>
          {connection.connected && (
            <button
              onClick={() => {
                fetchSchema();
                setContextMenu(null);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <RefreshCw size={12} />
              {t('sidebar.refreshSchema')}
            </button>
          )}
          <div className="my-1 border-t border-border" />
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 size={12} />
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

// ===== Schema Tree Node (recursive) =====

function SchemaTreeNode({
  node,
  depth,
  onDoubleClickTable,
  onSchemaClick,
  onTableClick,
  connectionId,
}: {
  node: SchemaNode;
  depth: number;
  onDoubleClickTable: (node: SchemaNode) => void;
  onSchemaClick?: (schemaName: string, connectionId: string) => void;
  onTableClick?: (table: SchemaNode, connectionId: string) => void;
  connectionId?: string;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  const hasChildren = node.children && node.children.length > 0;

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    if (contextMenu) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (node.type === "table" || node.type === "view") {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }
    },
    [node.type]
  );

  const handleExportSql = useCallback(async () => {
    if (!connectionId) return;
    try {
      const sql = await exportTableSql(connectionId, node.name, node.schema);
      const schemaPrefix = node.schema ? `${node.schema}_` : "";
      downloadFile(sql, `${schemaPrefix}${node.name}.sql`, "text/plain");
    } catch {
      // ignore
    }
    setContextMenu(null);
  }, [connectionId, node.name, node.schema]);

  const getIcon = () => {
    switch (node.type) {
      case "schema":
        return <Database size={12} className="text-muted-foreground" />;
      case "table":
        return <Table size={12} className="text-muted-foreground" />;
      case "view":
        return <Eye size={12} className="text-muted-foreground" />;
      case "column":
        return (
          <Columns
            size={11}
            className={
              node.icon === "key"
                ? "text-[hsl(var(--tab-active))]"
                : "text-muted-foreground/60"
            }
          />
        );
      default:
        return null;
    }
  };

  return (
    <div ref={contextRef}>
      <div
        className={`flex items-center gap-1.5 w-full px-1.5 py-1 text-xs rounded transition-colors hover:bg-muted text-left cursor-pointer ${
          node.type === "column" ? "ml-2" : ""
        }`}
        onClick={() => {
          if (node.type === "schema" && onSchemaClick && connectionId) {
            onSchemaClick(node.name, connectionId);
          }
          if ((node.type === "table" || node.type === "view") && onTableClick && connectionId) {
            onTableClick(node, connectionId);
          } else if (node.type === "table" || node.type === "view") {
            onDoubleClickTable(node);
          }
          if (hasChildren) {
            setExpanded(!expanded);
          }
        }}
        onDoubleClick={() => {
          if (node.type === "table" || node.type === "view") {
            onDoubleClickTable(node);
          }
        }}
        onContextMenu={handleContextMenu}
      >
        {/* Expand arrow */}
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={10} className="shrink-0 text-muted-foreground/60" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-muted-foreground/60" />
          )
        ) : (
          <span className="w-2.5" />
        )}

        {getIcon()}

        <span
          className={`truncate ${
            node.type === "column"
              ? "text-muted-foreground/70"
              : "text-sidebar-foreground"
          }`}
        >
          {node.name}
        </span>

        {node.type === "column" && node.icon === "key" && (
          <span className="text-[8px] px-0.5 rounded bg-[hsl(var(--tab-active))]/20 text-[hsl(var(--tab-active))]">
            PK
          </span>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div className="ml-2">
          {node.children!.map((child) => (
            <SchemaTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onDoubleClickTable={onDoubleClickTable}
              onSchemaClick={onSchemaClick}
              onTableClick={onTableClick}
              connectionId={connectionId}
            />
          ))}
        </div>
      )}

      {/* Context Menu for tables */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-background border border-border rounded shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              onDoubleClickTable(node);
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
          >
            <Table size={12} />
            {t('sidebar.queryData')}
          </button>
          <button
            onClick={handleExportSql}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
          >
            <Terminal size={12} />
            {t('sidebar.exportSql')}
          </button>
        </div>
      )}
    </div>
  );
}

export default Sidebar;
