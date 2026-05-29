// Context menus for the sidebar: connection-level (right-click on a connection)
// and tree-node-level (right-click on a database / table / view / etc.).
import {
  Plug,
  Unplug,
  Trash2,
  Edit,
  Table as TableIcon,
  FileText,
  RefreshCw,
  Wrench,
  Eraser,
  Copy,
  Database,
  ChevronRight,
} from "lucide-react";
import { useConnectionStore } from "@/stores/app-store";
import type { Connection } from "@/types";
import { t } from "@/lib/i18n";
import { connectDatabase, disconnectDatabase } from "@/lib/tauri-commands";
import { log } from "@/lib/log";
import type { TreeNode } from "./types";
import { createPortal } from "react-dom";

// ===== Connection Context Menu =====

export interface ContextMenuProps {
  x: number;
  y: number;
  connectionId: string;
  onClose: () => void;
  openConnectionDialog: (editConnection?: Connection) => void;
  expandedConnections: Set<string>;
  setExpandedConnections: React.Dispatch<React.SetStateAction<Set<string>>>;
  onCreateDatabase: (connectionId: string) => void;
}

export function ContextMenu({
  x,
  y,
  connectionId,
  onClose,
  openConnectionDialog,
  expandedConnections,
  setExpandedConnections,
  onCreateDatabase,
}: ContextMenuProps) {
  const { connections, removeConnection } = useConnectionStore();
  const connection = connections.find((c) => c.id === connectionId);

  if (!connection) {
    console.warn("[ContextMenu] Connection not found:", connectionId);
    return null;
  }

  log.debug(
    "ContextMenu",
    "opened for:",
    connection.name,
    "Status:",
    connection.connected ? "connected" : "disconnected",
  );

  const handleConnect = async () => {
    if (connection.connected) {
      // Update frontend immediately — don't wait for backend disconnect.
      useConnectionStore.getState().updateConnection(connection.id, { connected: false });
      const newExpanded = new Set(expandedConnections);
      newExpanded.delete(connection.id);
      setExpandedConnections(newExpanded);
      onClose();
      disconnectDatabase(connection.id).catch((error) => {
        console.error("[ContextMenu] Failed to disconnect:", error);
      });
    } else {
      try {
        await connectDatabase(connection);
        useConnectionStore.getState().updateConnection(connection.id, { connected: true });
        const newExpanded = new Set(expandedConnections);
        newExpanded.add(connection.id);
        setExpandedConnections(newExpanded);
      } catch (error) {
        console.error("[ContextMenu] Failed to connect:", error);
      }
    }
    onClose();
  };

  const handleEdit = () => {
    openConnectionDialog(connection);
    onClose();
  };

  const handleDelete = () => {
    if (confirm(t("sidebar.confirmDeleteConnection", { name: connection.name }))) {
      removeConnection(connection.id);
    }
    onClose();
  };

  const handleRefresh = async () => {
    // Trigger schema reload by re-setting active connection
    const { setActiveConnection } = useConnectionStore.getState();
    setActiveConnection(connectionId);
    onClose();
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[160px]"
        style={{
          left: x,
          top: y,
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
        role="menu"
        aria-label={t("sidebar.connectionMenu")}
      >
        <div className="px-3 py-1.5 text-xs font-medium border-b border-border mb-1">
          {connection.name}
        </div>

        {!connection.connected ? (
          <button
            onClick={handleConnect}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            role="menuitem"
          >
            <Plug size={12} />
            <span>{t("sidebar.connect")}</span>
          </button>
        ) : (
          <>
            <button
              onClick={handleConnect}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              role="menuitem"
            >
              <Unplug size={12} />
              <span>{t("sidebar.disconnect")}</span>
            </button>
            <button
              onClick={handleRefresh}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              role="menuitem"
            >
              <RefreshCw size={12} />
              <span>{t("sidebar.refresh")}</span>
            </button>
            {connection.type !== "sqlite" && (
              <button
                onClick={() => {
                  onCreateDatabase(connectionId);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                role="menuitem"
              >
                <Database size={12} />
                <span>{t("createDb.title")}</span>
              </button>
            )}
          </>
        )}

        <button
          onClick={handleEdit}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          role="menuitem"
        >
          <Edit size={12} />
          <span>{t("sidebar.edit")}</span>
        </button>

        <div className="border-t border-border my-1" />

        <button
          onClick={handleDelete}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-destructive"
          role="menuitem"
        >
          <Trash2 size={12} />
          <span>{t("sidebar.delete")}</span>
        </button>
      </div>
    </>,
    document.body,
  );
}

// ===== Tree Node Context Menu =====

export interface TreeNodeContextMenuProps {
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

export function TreeNodeContextMenu({
  x,
  y,
  node,
  onClose,
  onRefresh,
  onCopyName,
  onNewQuery,
  onDesignTable,
  onOpenTable,
  onDuplicateTable,
  onDeleteTable,
  onTruncateTable,
}: TreeNodeContextMenuProps) {
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

  const isTable = node.type === "table";
  const canRefresh = [
    "database",
    "schema",
    "tables",
    "views",
    "functions",
    "procedures",
    "events",
    "triggers",
  ].includes(node.type);
  const canNewQuery = ["database", "schema", "table"].includes(node.type);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[160px]"
        style={{
          left: x,
          top: y,
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
        role="menu"
        aria-label={t("sidebar.nodeMenu")}
      >
        <div className="px-3 py-1.5 text-xs font-medium border-b border-border mb-1">
          {node.name}
        </div>

        {isTable && onDesignTable && (
          <button
            onClick={handleDesignClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            role="menuitem"
          >
            <Wrench size={12} />
            <span>{t("sidebar.designTable")}</span>
          </button>
        )}

        {isTable && onOpenTable && (
          <button
            onClick={handleOpenTableClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            role="menuitem"
          >
            <TableIcon size={12} />
            <span>{t("sidebar.openTable")}</span>
          </button>
        )}

        {canNewQuery && onNewQuery && (
          <button
            onClick={handleNewQueryClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            role="menuitem"
          >
            <FileText size={12} />
            <span>{t("sidebar.newQuery")}</span>
          </button>
        )}

        {isTable && <div className="border-t border-border my-1" />}

        <button
          onClick={handleCopyClick}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          role="menuitem"
        >
          <FileText size={12} />
          <span>{t("sidebar.copyName")}</span>
        </button>

        {canRefresh && (
          <button
            onClick={handleRefreshClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            role="menuitem"
          >
            <RefreshCw size={12} />
            <span>{t("sidebar.refresh")}</span>
          </button>
        )}

        {isTable && onDuplicateTable && (
          <>
            <div className="border-t border-border my-1" />
            {/* Duplicate Table - Navicat-style hover submenu */}
            <div className="relative group/dup">
              <div
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted transition-colors cursor-default"
                role="menuitem"
                aria-haspopup="menu"
              >
                <span className="flex items-center gap-2">
                  <Copy size={12} />
                  {t("sidebar.duplicateTable")}
                </span>
                <ChevronRight size={12} className="text-muted-foreground" />
              </div>
              <div className="absolute left-full top-0 ml-0 hidden group-hover/dup:block z-[60]">
                <div
                  className="border border-border rounded-md shadow-lg py-1 min-w-[150px]"
                  style={{
                    backgroundColor: "hsl(var(--popover))",
                    color: "hsl(var(--popover-foreground))",
                  }}
                  role="menu"
                >
                  <button
                    onClick={handleDuplicateStructureAndDataClick}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <span>{t("sidebar.structureAndData")}</span>
                  </button>
                  <button
                    onClick={handleDuplicateStructureClick}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <span>{t("sidebar.structureOnly")}</span>
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-warning"
              role="menuitem"
            >
              <Eraser size={12} />
              <span>{t("sidebar.truncateTable")}</span>
            </button>
            <button
              onClick={handleDeleteClick}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-destructive"
              role="menuitem"
            >
              <Trash2 size={12} />
              <span>{t("sidebar.deleteTable")}</span>
            </button>
          </>
        )}

        <div className="border-t border-border my-1" />
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
          {t("sidebar.nodeType")}: {node.type}
        </div>
      </div>
    </>,
    document.body,
  );
}
