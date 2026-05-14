import { useState, useCallback, useEffect, useRef } from "react";
import {
  Table,
  Eye,
  Database,
  Folder,
  Search,
  RefreshCw,
  Plus,
  Edit,
  Trash2,
  FileText,
  X,
  Info,
  List,
  Grid3X3,
  Code2,
  Key,
  Wrench,
  Eraser,
  Save,
  Download,
  Upload,
  Loader2,
  Check,
  Copy,
  ChevronRight,
} from "lucide-react";
import { useUIStore, useTabStore } from "@/stores/app-store";
import type { SchemaNode, Connection, ColumnInfo, TableInfo } from "@/types";
import { t } from "@/lib/i18n";
import { getTableData, exportTableSql, getColumns, getTables, executeSql, insertTableRow, updateTableRows, deleteTableRows, getTableRowCount } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, exportToSQL, downloadFile, importFromCSV, importFromJSON, buildWhereClause, generateCopyTableName, buildDuplicateTableSQL } from "@/lib/export";
import EditorPanel from "./EditorPanel";
import PaginationBar from "./PaginationBar";

interface CrabHubMainPanelProps {
  activeConnection: Connection | null;
  selectedSchemaName?: string;
}

interface OpenTab {
  id: string;
  type: "table";
  tableId: string;
  tableName: string;
  schemaName?: string;
  connectionId: string;
}

function CrabHubMainPanel({ activeConnection, selectedSchemaName: propsSelectedSchemaName }: CrabHubMainPanelProps) {
  const {
    selectedSchemaName,
    selectedTable,
    selectedTableId,
    selectedTableData,
    selectedTableDDL,
    selectedContext,
  } = useUIStore();

  const globalTabs = useTabStore((s) => s.tabs);
  const globalActiveTabId = useTabStore((s) => s.activeTabId);
  const setGlobalActiveTab = useTabStore((s) => s.setActiveTab);
  const closeGlobalTab = useTabStore((s) => s.closeTab);
  const addGlobalTab = useTabStore((s) => s.addTab);
  
  const currentSchemaName = propsSelectedSchemaName ?? selectedSchemaName;

  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [loading, setLoading] = useState(false);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  // activeView: "objects" | local table tab id | "query:<globalTabId>"
  const [activeView, setActiveView] = useState<string>("objects");
  const [error, setError] = useState<string | null>(null);
  
  // Table data cache
  const [tableDataCache, setTableDataCache] = useState<Record<string, { data: any; ddl: string }>>({});

  // Column preview state (single-click)
  const [selectedColumns, setSelectedColumns] = useState<ColumnInfo[] | null>(null);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [previewDDL, setPreviewDDL] = useState<string>("");
  const [ddlLoading, setDdlLoading] = useState(false);
  const [previewTableName, setPreviewTableName] = useState<string | null>(null);

  // Directly loaded tables from API (not from schemaData which lacks children)
  const [loadedTables, setLoadedTables] = useState<SchemaNode[]>([]);
  // Table metadata map: SchemaNode.id -> TableInfo (for rendering OID, owner, ACL, etc.)
  const [tableMetadataMap, setTableMetadataMap] = useState<Record<string, TableInfo>>({});

  // Context menu state for table rows in object list
  const [tableContextMenu, setTableContextMenu] = useState<{ x: number; y: number; table: SchemaNode } | null>(null);

  // CRUD state
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colName: string } | null>(null);
  const [editedRows, setEditedRows] = useState<Map<number, Record<string, any>>>(new Map());
  const [newRows, setNewRows] = useState<Record<string, any>[]>([]);
  const [selectedRowIndices, setSelectedRowIndices] = useState<Set<number>>(new Set());
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [dataMessage, setDataMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [tableColumnInfoMap, setTableColumnInfoMap] = useState<Record<string, ColumnInfo[]>>({});

  // Pagination state per table tab (keyed by tableId)
  const [paginationState, setPaginationState] = useState<Record<string, { currentPage: number; pageSize: number }>>({});
  const [totalRowCountCache, setTotalRowCountCache] = useState<Record<string, number>>({});

  const hasPendingChanges = editedRows.size > 0 || newRows.length > 0;

  // Find active table tab (if any) - defined early so callbacks can use it
  const activeTableTab = (activeView !== "objects" && !activeView.startsWith("query:"))
    ? openTabs.find((t) => t.id === activeView)
    : null;

  // Load tables when activeConnection changes
  useEffect(() => {
    if (!activeConnection) {
      setLoadedTables([]);
      setTableMetadataMap({});
      return;
    }
    const connId = activeConnection.id;
    console.log('[CrabHubMainPanel] Loading tables for connection:', connId);
    getTables(connId).then((result) => {
      const metaMap: Record<string, TableInfo> = {};
      const tableNodes: SchemaNode[] = result
        .filter((t) => !currentSchemaName || !t.schema || t.schema === currentSchemaName)
        .map((t) => {
          const nodeId = `${connId}-${t.schema || 'default'}-table-${t.name}`;
          metaMap[nodeId] = t;
          return {
            id: nodeId,
            name: t.name,
            type: 'table' as const,
            schemaName: t.schema || currentSchemaName || 'public',
          };
        });
      setLoadedTables(tableNodes);
      setTableMetadataMap(metaMap);
      console.log('[CrabHubMainPanel] Loaded', tableNodes.length, 'tables with metadata');
    }).catch((err) => {
      console.error('[CrabHubMainPanel] Failed to load tables:', err);
      setLoadedTables([]);
      setTableMetadataMap({});
    });
  }, [activeConnection, currentSchemaName]);

  // Listen for openQueryTab events from Sidebar
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId) {
        setActiveView(`query:${detail.tabId}`);
      }
    };
    window.addEventListener('openQueryTab', handler);
    return () => window.removeEventListener('openQueryTab', handler);
  }, []);

  const tables = searchTerm
    ? loadedTables.filter((t) => t.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : loadedTables;

  const formatValue = (value: any): string => {
    if (value === null || value === undefined || value === "") {
      return "NULL";
    }
    if (value instanceof Date) {
      return value.toLocaleString();
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return String(value);
  };

  const loadTableData = useCallback(async (table: SchemaNode, schemaName?: string, connectionId?: string, page?: number, pageSizeOverride?: number) => {
    const connId = connectionId || selectedContext?.connectionId || activeConnection?.id;
    if (!connId) return;

    setError(null);
    
    const resolvedSchema = schemaName || table.schemaName || selectedContext?.schemaName || currentSchemaName || "public";
    const pgState = paginationState[table.id];
    const effectivePage = page ?? pgState?.currentPage ?? 1;
    const effectivePageSize = pageSizeOverride ?? pgState?.pageSize ?? 1000;
    console.log('[CrabHubMainPanel] loadTableData:', table.name, 'schema:', resolvedSchema, 'page:', effectivePage, 'pageSize:', effectivePageSize);

    setLoading(true);
    try {
      const [result, rowCount] = await Promise.all([
        getTableData(connId, table.name, effectivePage, effectivePageSize, undefined, resolvedSchema),
        getTableRowCount(connId, table.name, resolvedSchema).catch(() => null),
      ]);

      // If page has no rows but we're not on page 1, auto-navigate to page 1
      if (result.rows.length === 0 && effectivePage > 1) {
        setPaginationState(prev => ({ ...prev, [table.id]: { currentPage: 1, pageSize: effectivePageSize } }));
        setLoading(false);
        loadTableData(table, schemaName, connectionId, 1, effectivePageSize);
        return;
      }
      
      let ddl = "-- DDL not available";
      // Only load DDL if not already cached
      const existingCache = tableDataCache[table.id];
      if (existingCache?.ddl && existingCache.ddl !== "-- DDL not available") {
        ddl = existingCache.ddl;
      } else {
        try {
          ddl = await exportTableSql(connId, table.name, resolvedSchema);
        } catch (ddlErr) {
          console.error("[CrabHubMainPanel] Failed to load table DDL:", ddlErr);
        }
      }
      
      setTableDataCache(prev => ({
        ...prev,
        [table.id]: { data: result, ddl }
      }));
      
      useUIStore.getState().setSelectedTableData(result);
      useUIStore.getState().setSelectedTableDDL(ddl);

      // Cache total row count
      if (rowCount !== null) {
        setTotalRowCountCache(prev => ({ ...prev, [table.id]: rowCount }));
      }

      // Load column info for WHERE clause building
      try {
        const cols = await getColumns(connId, table.name, resolvedSchema);
        setTableColumnInfoMap(prev => ({ ...prev, [table.id]: cols }));
      } catch { /* ignore */ }
    } catch (err) {
      console.error("[CrabHubMainPanel] Failed to load table data:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [activeConnection, tableDataCache, selectedContext, currentSchemaName, paginationState]);

  // Clear CRUD state when switching tables
  const clearCrudState = useCallback(() => {
    setEditingCell(null);
    setEditedRows(new Map());
    setNewRows([]);
    setSelectedRowIndices(new Set());
    setDataMessage(null);
  }, []);

  // Refresh current table data (clear cache + reload)
  const refreshCurrentTable = useCallback(() => {
    if (!activeTableTab) return;
    clearCrudState();
    setTableDataCache(prev => {
      const next = { ...prev };
      delete next[activeTableTab.tableId];
      return next;
    });
    const tableNode: SchemaNode = {
      id: activeTableTab.tableId,
      name: activeTableTab.tableName,
      type: "table",
      schemaName: activeTableTab.schemaName,
    };
    loadTableData(tableNode, activeTableTab.schemaName, activeTableTab.connectionId);
  }, [activeTableTab, loadTableData, clearCrudState]);

  // Add new row
  const handleAddRow = useCallback(() => {
    if (!selectedTableData) return;
    const emptyRow: Record<string, any> = {};
    for (const col of selectedTableData.columns) {
      emptyRow[col.name] = null;
    }
    setNewRows(prev => [...prev, emptyRow]);
  }, [selectedTableData]);

  // Save all pending changes
  const handleSave = useCallback(async () => {
    if (!activeTableTab || !selectedTableData) return;
    const connId = activeTableTab.connectionId;
    const tableName = activeTableTab.tableName;
    const schema = activeTableTab.schemaName;
    setIsSaving(true);
    setDataMessage(null);

    try {
      let totalAffected = 0;

      // Process updates
      for (const [rowIdx, changes] of editedRows.entries()) {
        const originalRow = selectedTableData.rows[rowIdx];
        if (!originalRow) continue;
        const updates: [string, any][] = Object.entries(changes);
        if (updates.length === 0) continue;

        const colsForWhere = (tableColumnInfoMap[activeTableTab.tableId] || selectedTableData.columns).map((c: any) => ({
          name: c.name,
          isPrimaryKey: c.isPrimaryKey ?? c.primaryKey ?? false,
        }));
        const where = buildWhereClause(colsForWhere, originalRow);
        await updateTableRows(connId, tableName, updates, where, schema);
        totalAffected++;
      }

      // Process inserts
      for (const row of newRows) {
        const values: [string, any][] = Object.entries(row).filter(([_, v]) => v !== null && v !== undefined && v !== "");
        if (values.length === 0) continue;
        await insertTableRow(connId, tableName, values, schema);
        totalAffected++;
      }

      setDataMessage({ type: "success", text: t('data.saveSuccess') });
      refreshCurrentTable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDataMessage({ type: "error", text: `${t('data.saveFailed')}: ${msg}` });
    } finally {
      setIsSaving(false);
    }
  }, [activeTableTab, selectedTableData, editedRows, newRows, tableColumnInfoMap, refreshCurrentTable]);

  // Delete selected rows
  const handleDeleteRows = useCallback(async () => {
    if (!activeTableTab || !selectedTableData) return;
    const count = selectedRowIndices.size;
    if (count === 0) return;

    const confirmMsg = t('data.confirmDelete').replace('{count}', String(count));
    if (!window.confirm(confirmMsg)) return;

    const connId = activeTableTab.connectionId;
    const tableName = activeTableTab.tableName;
    const schema = activeTableTab.schemaName;
    const totalOriginalRows = selectedTableData.rows.length;

    setIsSaving(true);
    setDataMessage(null);

    try {
      // Separate new rows vs existing rows
      const newRowIndicesToRemove: number[] = [];
      const existingRowIndices: number[] = [];

      for (const idx of selectedRowIndices) {
        if (idx >= totalOriginalRows) {
          newRowIndicesToRemove.push(idx - totalOriginalRows);
        } else {
          existingRowIndices.push(idx);
        }
      }

      // Remove new rows from state
      if (newRowIndicesToRemove.length > 0) {
        const removeSet = new Set(newRowIndicesToRemove);
        setNewRows(prev => prev.filter((_, i) => !removeSet.has(i)));
      }

      // Delete existing rows from database
      for (const rowIdx of existingRowIndices) {
        const row = selectedTableData.rows[rowIdx];
        if (!row) continue;
        const colsForWhere = (tableColumnInfoMap[activeTableTab.tableId] || selectedTableData.columns).map((c: any) => ({
          name: c.name,
          isPrimaryKey: c.isPrimaryKey ?? c.primaryKey ?? false,
        }));
        const where = buildWhereClause(colsForWhere, row);
        await deleteTableRows(connId, tableName, where, schema);
      }

      setDataMessage({ type: "success", text: t('data.saveSuccess') });
      setSelectedRowIndices(new Set());
      if (existingRowIndices.length > 0) {
        refreshCurrentTable();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDataMessage({ type: "error", text: `${t('data.saveFailed')}: ${msg}` });
    } finally {
      setIsSaving(false);
    }
  }, [activeTableTab, selectedTableData, selectedRowIndices, tableColumnInfoMap, refreshCurrentTable]);

  // Cancel all pending changes
  const handleCancelChanges = useCallback(() => {
    clearCrudState();
  }, [clearCrudState]);

  // Pagination handlers
  const handlePageChange = useCallback((page: number) => {
    if (!activeTableTab) return;
    if (hasPendingChanges && !window.confirm(t('pagination.unsavedWarning'))) return;
    clearCrudState();
    const tableId = activeTableTab.tableId;
    const currentPageSize = paginationState[tableId]?.pageSize || 1000;
    setPaginationState(prev => ({
      ...prev,
      [tableId]: { currentPage: page, pageSize: currentPageSize }
    }));
    setTableDataCache(prev => { const next = { ...prev }; delete next[tableId]; return next; });
    const tableNode: SchemaNode = { id: tableId, name: activeTableTab.tableName, type: "table", schemaName: activeTableTab.schemaName };
    loadTableData(tableNode, activeTableTab.schemaName, activeTableTab.connectionId, page, currentPageSize);
  }, [activeTableTab, hasPendingChanges, clearCrudState, loadTableData, paginationState]);

  const handlePageSizeChange = useCallback((pageSize: number) => {
    if (!activeTableTab) return;
    if (hasPendingChanges && !window.confirm(t('pagination.unsavedWarning'))) return;
    clearCrudState();
    const tableId = activeTableTab.tableId;
    setPaginationState(prev => ({
      ...prev,
      [tableId]: { currentPage: 1, pageSize }
    }));
    setTableDataCache(prev => { const next = { ...prev }; delete next[tableId]; return next; });
    const tableNode: SchemaNode = { id: tableId, name: activeTableTab.tableName, type: "table", schemaName: activeTableTab.schemaName };
    loadTableData(tableNode, activeTableTab.schemaName, activeTableTab.connectionId, 1, pageSize);
  }, [activeTableTab, hasPendingChanges, clearCrudState, loadTableData]);

  // Export data
  const handleExport = useCallback(async (format: 'csv' | 'json' | 'sql') => {
    if (!selectedTableData || !activeTableTab) return;
    setShowExportMenu(false);
    try {
      const cols = selectedTableData.columns;
      const rows = selectedTableData.rows;
      const name = activeTableTab.tableName;
      let content: string;
      let filename: string;
      let mime: string;

      switch (format) {
        case 'csv':
          content = exportToCSV(cols, rows);
          filename = `${name}.csv`;
          mime = 'text/csv';
          break;
        case 'json':
          content = exportToJSON(cols, rows);
          filename = `${name}.json`;
          mime = 'application/json';
          break;
        case 'sql':
          content = exportToSQL(cols, rows, name);
          filename = `${name}.sql`;
          mime = 'text/plain';
          break;
      }
      await downloadFile(content, filename, mime);
      setDataMessage({ type: "success", text: t('data.exportSuccess') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDataMessage({ type: "error", text: msg });
    }
  }, [selectedTableData, activeTableTab]);

  // Import data
  const handleImport = useCallback(async (format: 'csv' | 'json' | 'sql') => {
    if (!activeTableTab) return;
    setShowImportMenu(false);
    const connId = activeTableTab.connectionId;
    const tableName = activeTableTab.tableName;
    const schema = activeTableTab.schemaName;

    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      let fileContent: string | null = null;

      if (isTauri) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const extensions = format === 'csv' ? ['csv'] : format === 'json' ? ['json'] : ['sql'];
        const filePath = await open({
          multiple: false,
          filters: [{ name: format.toUpperCase(), extensions }],
        });
        if (!filePath) return;
        const path = typeof filePath === 'string' ? filePath : (filePath as any).path ?? String(filePath);
        fileContent = await readTextFile(path);
      } else {
        // Browser fallback
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = format === 'csv' ? '.csv' : format === 'json' ? '.json' : '.sql';
        const file = await new Promise<File | null>((resolve) => {
          input.onchange = () => resolve(input.files?.[0] || null);
          input.click();
        });
        if (!file) return;
        fileContent = await file.text();
      }

      if (!fileContent) return;
      setDataMessage({ type: "success", text: t('data.importing') });

      if (format === 'sql') {
        await executeSql(connId, fileContent);
        setDataMessage({ type: "success", text: t('data.importSuccess').replace('{count}', '?') });
      } else {
        // Parse CSV/JSON
        const blob = new Blob([fileContent], { type: 'text/plain' });
        const file = new File([blob], `import.${format}`);
        const parsed = format === 'csv' ? await importFromCSV(file) : await importFromJSON(file);

        let imported = 0;
        for (const row of parsed.rows) {
          const values: [string, any][] = parsed.columns
            .map((colName) => [colName, row[colName] ?? null] as [string, any])
            .filter(([_, v]) => v !== null && v !== undefined && v !== "");
          if (values.length > 0) {
            await insertTableRow(connId, tableName, values, schema);
            imported++;
          }
        }
        setDataMessage({ type: "success", text: t('data.importSuccess').replace('{count}', String(imported)) });
      }

      refreshCurrentTable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDataMessage({ type: "error", text: `${t('data.importFailed')}: ${msg}` });
    }
  }, [activeTableTab, refreshCurrentTable]);

  // Open a tab for a table (triggered by double-click)
  const handleOpenTableTab = useCallback((table: SchemaNode, connectionId?: string) => {
    const connId = connectionId || selectedContext?.connectionId || activeConnection?.id;
    if (!connId) return;
    
    const resolvedSchema = table.schemaName || selectedContext?.schemaName || currentSchemaName || "public";
    const existingTab = openTabs.find((t) => t.tableId === table.id);

    if (existingTab) {
      setActiveView(existingTab.id);
    } else {
      const newTab: OpenTab = {
        id: `table-tab-${Date.now()}`,
        type: "table",
        tableId: table.id,
        tableName: table.name,
        schemaName: resolvedSchema,
        connectionId: connId,
      };
      setOpenTabs((prev) => [...prev, newTab]);
      setActiveView(newTab.id);
      // Initialize pagination state for new tab
      setPaginationState(prev => ({
        ...prev,
        [table.id]: prev[table.id] || { currentPage: 1, pageSize: 1000 }
      }));
    }
    
    loadTableData(table, resolvedSchema, connId);
  }, [openTabs, loadTableData, selectedContext, currentSchemaName, activeConnection]);

  // Select a table (triggered by single-click) — load columns + DDL preview
  const handleTableSelect = useCallback(async (table: SchemaNode) => {
    const connId = selectedContext?.connectionId || activeConnection?.id;
    if (!connId) return;
    const resolvedSchema = table.schemaName || selectedContext?.schemaName || currentSchemaName || "public";
    
    useUIStore.getState().setSelectedTableId(table.id);
    useUIStore.getState().setSelectedContext({
      type: "table",
      connectionId: connId,
      schemaName: resolvedSchema,
      tableName: table.name,
    });
    setPreviewTableName(table.name);
    
    setColumnsLoading(true);
    setDdlLoading(true);
    try {
      const [columns, ddl] = await Promise.all([
        getColumns(connId, table.name, resolvedSchema),
        exportTableSql(connId, table.name, resolvedSchema).catch(() => "-- DDL not available"),
      ]);
      setSelectedColumns(columns);
      setPreviewDDL(ddl);
    } catch (err) {
      console.error("Failed to load columns/DDL:", err);
    } finally {
      setColumnsLoading(false);
      setDdlLoading(false);
    }
  }, [activeConnection, selectedContext, currentSchemaName]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeView === tabId) {
        if (newTabs.length > 0) {
          const lastTab = newTabs[newTabs.length - 1];
          setActiveView(lastTab ? lastTab.id : "objects");
        } else {
          setActiveView("objects");
        }
      }
      return newTabs;
    });
  }, [activeView]);

  // Track previous selectedTable to avoid circular triggers
  const prevSelectedTableRef = useRef<string | null>(null);

  // When selectedTable changes (from sidebar double-click), open a tab
  useEffect(() => {
    if (selectedTable && (activeConnection || selectedContext?.connectionId)) {
      const tableKey = `${selectedTable.schema}.${selectedTable.name}`;
      if (prevSelectedTableRef.current !== tableKey) {
        prevSelectedTableRef.current = tableKey;
        console.log('[CrabHubMainPanel] selectedTable changed:', tableKey);
        const tableNode: SchemaNode = {
          id: selectedTableId || `table-${selectedTable.name}`,
          name: selectedTable.name,
          type: "table",
          schemaName: selectedTable.schema,
        };
        handleOpenTableTab(tableNode, selectedContext?.connectionId);
      }
    }
  }, [selectedTable, activeConnection, selectedContext?.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When clicking a folder or schema node in sidebar, switch to objects view
  useEffect(() => {
    if (selectedContext?.type === "folder" || selectedContext?.type === "schema") {
      setActiveView("objects");
    }
  }, [selectedContext]);  // When selectedContext changes from sidebar single-click, load columns + DDL
  const prevContextRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedContext?.type === "table" && selectedContext.tableName && selectedContext.connectionId) {
      const contextKey = `${selectedContext.connectionId}.${selectedContext.schemaName}.${selectedContext.tableName}`;
      if (prevContextRef.current !== contextKey) {
        prevContextRef.current = contextKey;
        const connId = selectedContext.connectionId;
        const schema = selectedContext.schemaName || currentSchemaName || "public";
        setColumnsLoading(true);
        setDdlLoading(true);
        setPreviewTableName(selectedContext.tableName);
        Promise.all([
          getColumns(connId, selectedContext.tableName, schema),
          exportTableSql(connId, selectedContext.tableName, schema).catch(() => "-- DDL not available"),
        ]).then(([columns, ddl]) => {
          setSelectedColumns(columns);
          setPreviewDDL(ddl);
        }).catch((err) => {
          console.error("Failed to load columns/DDL from sidebar click:", err);
        }).finally(() => {
          setColumnsLoading(false);
          setDdlLoading(false);
        });
      }
    }
  }, [selectedContext, currentSchemaName]);

  // When switching tabs, restore data from cache
  useEffect(() => {
    if (activeView !== "objects" && !activeView.startsWith("query:")) {
      const tab = openTabs.find(t => t.id === activeView);
      if (tab) {
        const cached = tableDataCache[tab.tableId];
        if (cached) {
          useUIStore.getState().setSelectedTableData(cached.data);
          useUIStore.getState().setSelectedTableDDL(cached.ddl);
        }
      }
    }
  }, [activeView, openTabs, tableDataCache]);

  // Sync global activeTabId when switching to a query tab
  useEffect(() => {
    if (activeView.startsWith("query:")) {
      const globalId = activeView.replace("query:", "");
      if (globalActiveTabId !== globalId) {
        setGlobalActiveTab(globalId);
      }
    }
  }, [activeView, globalActiveTabId, setGlobalActiveTab]);

  useEffect(() => {
    if (currentSchemaName && activeConnection) {
      console.log('[CrabHubMainPanel] Schema changed:', currentSchemaName);
    }
  }, [currentSchemaName, activeConnection]);

  // When switching table tabs, restore data from cache
  useEffect(() => {
    if (!activeTableTab) return;
    const cached = tableDataCache[activeTableTab.tableId];
    if (cached) {
      useUIStore.getState().setSelectedTableData(cached.data);
      useUIStore.getState().setSelectedTableDDL(cached.ddl);
    } else {
      // Not in cache, trigger load
      const tableNode: SchemaNode = {
        id: activeTableTab.tableId,
        name: activeTableTab.tableName,
        type: "table",
        schemaName: activeTableTab.schemaName,
      };
      loadTableData(tableNode, activeTableTab.schemaName, activeTableTab.connectionId);
    }
  }, [activeView, activeTableTab?.tableId]);

  // Determine which DDL to show
  const displayDDL = previewDDL || selectedTableDDL || "";

  // Whether we're showing the objects view
  const showObjectsView = activeView === "objects";

  // Whether we're showing a query editor
  const showQueryView = activeView.startsWith("query:");

  // Right-click context menu handlers for table rows
  const handleTableContextMenu = useCallback((e: React.MouseEvent, table: SchemaNode) => {
    e.preventDefault();
    e.stopPropagation();
    setTableContextMenu({ x: e.clientX, y: e.clientY, table });
  }, []);

  const handleDesignTable = useCallback((table: SchemaNode) => {
    if (!activeConnection) return;
    const connId = activeConnection.id;
    const addTab = useTabStore.getState().addTab;
    addTab({
      title: `${t('sidebar.designTable')} - ${table.name}`,
      type: 'designer',
      content: '',
      connectionId: connId,
      tableName: table.name,
      schemaName: table.schemaName || currentSchemaName,
    });
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [activeConnection, currentSchemaName]);

  const handleDeleteTableAction = useCallback(async (table: SchemaNode) => {
    if (!activeConnection) return;
    const msg = t('sidebar.confirmDeleteTable', { name: table.name });
    if (!window.confirm(msg)) return;
    try {
      const dbType = activeConnection.type;
      const schema = table.schemaName || currentSchemaName;
      let fullName = table.name;
      if (schema && !['mysql', 'sqlite'].includes(dbType)) {
        fullName = `"${schema}"."${table.name}"`;
      } else if (dbType === 'mysql') {
        fullName = `\`${table.name}\``;
      } else if (dbType === 'mssql') {
        fullName = schema ? `[${schema}].[${table.name}]` : `[${table.name}]`;
      } else {
        fullName = `"${table.name}"`;
      }
      await executeSql(activeConnection.id, `DROP TABLE ${fullName}`);
      // Refresh tables
      getTables(activeConnection.id).then((result) => {
        const metaMap: Record<string, TableInfo> = {};
        const tableNodes: SchemaNode[] = result
          .filter((ti) => !currentSchemaName || !ti.schema || ti.schema === currentSchemaName)
          .map((ti) => {
            const id = `${ti.schema || ''}.${ti.name}`;
            metaMap[id] = ti;
            return { id, name: ti.name, type: (ti.tableType === 'VIEW' ? 'view' : 'table') as SchemaNode['type'], schemaName: ti.schema };
          });
        setLoadedTables(tableNodes);
        setTableMetadataMap(metaMap);
      });
    } catch (error) {
      alert(String(error));
    }
  }, [activeConnection, currentSchemaName]);

  const handleTruncateTableAction = useCallback(async (table: SchemaNode) => {
    if (!activeConnection) return;
    const msg = t('sidebar.confirmTruncateTable', { name: table.name });
    if (!window.confirm(msg)) return;
    try {
      const dbType = activeConnection.type;
      const schema = table.schemaName || currentSchemaName;
      let fullName = table.name;
      if (schema && !['mysql', 'sqlite'].includes(dbType)) {
        fullName = `"${schema}"."${table.name}"`;
      } else if (dbType === 'mysql') {
        fullName = `\`${table.name}\``;
      } else if (dbType === 'mssql') {
        fullName = schema ? `[${schema}].[${table.name}]` : `[${table.name}]`;
      } else {
        fullName = `"${table.name}"`;
      }
      const sql = dbType === 'sqlite' ? `DELETE FROM ${fullName}` : `TRUNCATE TABLE ${fullName}`;
      await executeSql(activeConnection.id, sql);
    } catch (error) {
      alert(String(error));
    }
  }, [activeConnection, currentSchemaName]);

  // Handle duplicate table
  const handleDuplicateTable = useCallback(async (table: SchemaNode, includeData: boolean) => {
    if (!activeConnection) return;

    try {
      const dbType = activeConnection.type;
      const schema = table.schemaName || currentSchemaName;
      const connId = activeConnection.id;

      // Auto-generate copy name: table_copy1, table_copy2, ...
      const existingNames = loadedTables.map(t => t.name);
      const newName = generateCopyTableName(table.name, existingNames);

      // For DDL-based databases, fetch DDL first
      let ddl: string | undefined;
      const needsDDL = (dbType === 'sqlite' && !includeData)
        || (dbType === 'mssql' && !includeData)
        || (!['postgresql', 'gaussdb', 'opengauss', 'mysql', 'sqlite', 'mssql'].includes(dbType));
      if (needsDDL) {
        ddl = await exportTableSql(connId, table.name, schema);
      }

      const sqls = buildDuplicateTableSQL(dbType, table.name, newName, schema, includeData, ddl);

      for (const sql of sqls) {
        await executeSql(connId, sql);
      }

      // Refresh table list
      const result = await getTables(connId);
      const metaMap: Record<string, TableInfo> = {};
      const tableNodes: SchemaNode[] = result
        .filter((ti) => !currentSchemaName || !ti.schema || ti.schema === currentSchemaName)
        .map((ti) => {
          const id = `${connId}-${ti.schema || 'default'}-table-${ti.name}`;
          metaMap[id] = ti;
          return { id, name: ti.name, type: (ti.tableType === 'VIEW' ? 'view' : 'table') as SchemaNode['type'], schemaName: ti.schema || currentSchemaName || 'public' };
        });
      setLoadedTables(tableNodes);
      setTableMetadataMap(metaMap);
    } catch (error) {
      alert(`${t('sidebar.duplicateFailed')}: ${String(error)}`);
    }
  }, [activeConnection, currentSchemaName, loadedTables]);

  // Handle adding a new query tab
  const handleAddQueryTab = useCallback(() => {
    const queryCount = globalTabs.filter((tab) => tab.type === "query").length + 1;
    addGlobalTab({
      title: `${t('tab.newQuery')} ${queryCount}`,
      type: "query",
      content: "",
    });
    // addGlobalTab sets the new tab as active, read it from store
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        setActiveView(`query:${newActiveId}`);
      }
    }, 0);
  }, [globalTabs, addGlobalTab]);

  // Handle closing a query tab
  const handleCloseQueryTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeGlobalTab(tabId);
    if (activeView === `query:${tabId}`) {
      const remainingQueryTabs = globalTabs.filter(qt => qt.id !== tabId);
      const lastQueryTab = remainingQueryTabs[remainingQueryTabs.length - 1];
      const lastOpenTab = openTabs[openTabs.length - 1];
      if (lastQueryTab) {
        setActiveView(`query:${lastQueryTab.id}`);
      } else if (lastOpenTab) {
        setActiveView(lastOpenTab.id);
      } else {
        setActiveView("objects");
      }
    }
  }, [activeView, globalTabs, openTabs, closeGlobalTab]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Unified Tab Bar: 对象 + table tabs + query tabs + add button */}
      <div className="flex items-center border-b border-border px-1 bg-muted/30 min-h-[30px] overflow-x-auto">
        {/* 对象 tab */}
        <button
          onClick={() => setActiveView("objects")}
          className={`flex items-center gap-1 px-2 py-1 text-xs border-t-2 transition-colors shrink-0 ${
            showObjectsView
              ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          <Database size={14} />
          <span>对象</span>
        </button>

        {/* Table tabs */}
        {openTabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            className={`group flex items-center gap-1 px-3 py-1 text-xs border-t-2 cursor-pointer transition-colors shrink-0 ${
              activeView === tab.id
                ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Table size={14} />
            <span>
              {tab.schemaName ? `${tab.schemaName}.` : ""}
              {tab.tableName}
            </span>
            <button
              onClick={(e) => handleCloseTab(tab.id, e)}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        {/* Divider between table tabs and query tabs */}
        {(openTabs.length > 0 && globalTabs.length > 0) && (
          <div className="w-px h-4 bg-border mx-1 shrink-0" />
        )}

        {/* Query tabs from global store */}
        {globalTabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveView(`query:${tab.id}`)}
            className={`group flex items-center gap-1 px-3 py-1 text-xs border-t-2 cursor-pointer transition-colors shrink-0 ${
              activeView === `query:${tab.id}`
                ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Code2 size={14} />
            <span className="truncate max-w-[120px]">{tab.title}</span>
            <button
              onClick={(e) => handleCloseQueryTab(tab.id, e)}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        <div className="flex-1" />

        {/* Add query tab button */}
        <button
          onClick={handleAddQueryTab}
          className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 rounded"
          title={t('tab.newQuery')}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Content area */}
      {showQueryView ? (
        /* Query Editor - full area */
        <div className="flex-1 overflow-hidden">
          <EditorPanel />
        </div>
      ) : (
        /* Navicat mode: two panels (Main Content | DDL) */
        <div className="flex-1 overflow-hidden flex flex-col">
              {showObjectsView ? (
                /* Objects View */
                <div className="h-full flex flex-col">

                  {/* Toolbar: tabs + actions + search in one row */}
                  <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
                    {/* Inline query tabs (same as TabBar but compact) */}
                    {globalTabs.map((tab) => (
                      <div key={tab.id}
                        className={`flex items-center gap-1 px-2 h-6 rounded text-[11px] whitespace-nowrap shrink-0 cursor-pointer border border-border transition-colors ${
                          globalActiveTabId === tab.id
                            ? "bg-blue-600 text-white border-blue-600"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        }`}
                        onClick={() => { setGlobalActiveTab(tab.id); setActiveView(`query:${tab.id}`); }}>
                        <span className="truncate max-w-[80px]">{tab.title}</span>
                        <button onClick={(e) => { e.stopPropagation(); closeGlobalTab(tab.id); }}
                          className="p-0.5 rounded hover:bg-white/20 transition-colors">
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    {globalTabs.length > 0 && <div className="w-px h-4 bg-border mx-1" />}
                    <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="Create New Schema">
                      <Folder size={14} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title={t('designer.editTable')}
                      disabled={!selectedTableId}
                      onClick={() => {
                        if (!selectedTableId) return;
                        const table = loadedTables.find(t => t.id === selectedTableId);
                        if (table) handleDesignTable(table);
                      }}
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                      title={t('designer.createTable')}
                      onClick={() => {
                        if (!activeConnection) return;
                        addGlobalTab({
                          title: t('designer.createTable'),
                          type: 'designer',
                          content: '',
                          connectionId: activeConnection.id,
                          schemaName: currentSchemaName,
                        });
                        setTimeout(() => {
                          const newActiveId = useTabStore.getState().activeTabId;
                          if (newActiveId) {
                            window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
                          }
                        }, 0);
                      }}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title={t('sidebar.deleteTable')}
                      disabled={!selectedTableId}
                      onClick={() => {
                        if (!selectedTableId) return;
                        const table = loadedTables.find(t => t.id === selectedTableId);
                        if (table) handleDeleteTableAction(table);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                    <div className="w-1/2" />
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => setViewMode("list")}
                        className={`p-1 rounded ${viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        title="List View"
                      >
                        <List size={14} />
                      </button>
                      <button
                        onClick={() => setViewMode("grid")}
                        className={`p-1 rounded ${viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        title="Grid View"
                      >
                        <Grid3X3 size={14} />
                      </button>
                    </div>
                    <div className="w-1/2" />
                    <div className="flex-1 relative max-w-[150px]">
                      <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="text"
                        placeholder={t('common.search')}
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-6 pr-2 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                      />
                    </div>
                  </div>

                  {/* Table List */}
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {viewMode === "list" ? (
                      <table className="w-full text-xs border-collapse border" style={{ tableLayout: 'fixed' }}>
                        <colgroup>
                          {activeConnection?.type === 'mysql' ? (
                            <>
                              <col style={{ width: '22%' }} />
                              <col style={{ width: '8%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '14%' }} />
                              <col style={{ width: '14%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '10%' }} />
                            </>
                          ) : (
                            <>
                              <col style={{ width: '22%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                            </>
                          )}
                        </colgroup>
                        <thead className="sticky top-0" style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
                          {activeConnection?.type === 'mysql' ? (
                            <tr>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">{t('common.name')}</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">行</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">数据长度</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">引擎</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">创建日期</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">修改日期</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">排序规则</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">注释</th>
                            </tr>
                          ) : (
                            <tr>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">{t('common.name')}</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">OID</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">所有者</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">ACL</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">表类型</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">分区属于</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">行</th>
                              <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30">主键</th>
                            </tr>
                          )}
                        </thead>
                        <tbody>
                          {tables.map((table) => {
                            const meta = tableMetadataMap[table.id];
                            if (activeConnection?.type === 'mysql') {
                              const formatDataLength = (bytes: number | null | undefined) => {
                                if (bytes == null) return "—";
                                if (bytes < 1024) return `${bytes} B`;
                                if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                              };
                              return (
                                <tr
                                  key={table.id}
                                  onClick={() => handleTableSelect(table)}
                                  onDoubleClick={() => handleOpenTableTab(table)}
                                  onContextMenu={(e) => handleTableContextMenu(e, table)}
                                  className={`cursor-pointer hover:bg-muted/50 ${
                                    selectedTableId === table.id ? "bg-[hsl(var(--tab-active))]/10" : ""
                                  }`}
                                >
                                  <td className="px-2 py-1 truncate border">
                                    <span className="inline-flex items-center gap-1">
                                      {table.type === "view" ? <Eye size={12} className="shrink-0" /> : <Table size={12} className="shrink-0" />}
                                      <span className="truncate">{table.name}</span>
                                    </span>
                                  </td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.rowCount != null ? meta.rowCount : "—"}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{formatDataLength(meta?.dataLength)}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.engine ?? "—"}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.createTime ?? "—"}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.updateTime ?? "—"}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.collation ?? "—"}</td>
                                  <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.description || "—"}</td>
                                </tr>
                              );
                            }
                            const tableTypeLabel = meta?.tableType === "VIEW" ? "视图"
                              : meta?.tableType === "MATERIALIZED VIEW" ? "物化视图"
                              : meta?.tableType === "PARTITIONED TABLE" ? "分区表"
                              : meta?.tableType === "FOREIGN TABLE" ? "外部表"
                              : "常规";
                            return (
                            <tr
                              key={table.id}
                              onClick={() => handleTableSelect(table)}
                              onDoubleClick={() => handleOpenTableTab(table)}
                              onContextMenu={(e) => handleTableContextMenu(e, table)}
                              className={`cursor-pointer hover:bg-muted/50 ${
                                selectedTableId === table.id ? "bg-[hsl(var(--tab-active))]/10" : ""
                              }`}
                            >
                              <td className="px-2 py-1 truncate border">
                                <span className="inline-flex items-center gap-1">
                                  {table.type === "view" ? <Eye size={12} className="shrink-0" /> : <Table size={12} className="shrink-0" />}
                                  <span className="truncate">{table.name}</span>
                                </span>
                              </td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.oid ?? "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.owner ?? "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.acl ?? "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{tableTypeLabel}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.partitionOf ?? "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.rowCount != null ? meta.rowCount : "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground truncate border">{meta?.primaryKey ?? "—"}</td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 p-2">
                        {tables.map((table) => (
                          <div
                            key={table.id}
                            onClick={() => handleTableSelect(table)}
                            onDoubleClick={() => handleOpenTableTab(table)}
                            onContextMenu={(e) => handleTableContextMenu(e, table)}
                            className={`flex flex-col items-center p-2 rounded cursor-pointer hover:bg-muted/50 ${
                              selectedTableId === table.id ? "bg-[hsl(var(--tab-active))]/10" : ""
                            }`}
                          >
                            {table.type === "view" ? <Eye size={24} className="mb-1" /> : <Table size={24} className="mb-1" />}
                            <span className="text-xs text-center truncate w-full">{table.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Columns Section */}
                  <div className="border-t border-border flex flex-col" style={{ height: "200px" }}>
                    <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-muted/20">
                      <span className="text-xs font-medium text-foreground">
                        列 {previewTableName && <span className="text-muted-foreground">- {previewTableName}</span>}
                      </span>
                    </div>
                    <div className="flex-1 overflow-auto">
                      {columnsLoading ? (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                          <div className="w-4 h-4 border-2 border-muted-foreground border-t-[hsl(var(--tab-active))] rounded-full animate-spin"></div>
                        </div>
                      ) : selectedColumns && selectedColumns.length > 0 ? (
                        <table className="w-full text-xs border-collapse border">
                          <thead className="sticky top-0" style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
                            <tr>
                              <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30">名称</th>
                              <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30">类型</th>
                              <th className="text-center px-1 py-0.5 font-medium text-white border border-white/30">PK</th>
                              <th className="text-center px-1 py-0.5 font-medium text-white border border-white/30">NN</th>
                              <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30">默认值</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedColumns.map((col, idx) => (
                              <tr key={idx} className="hover:bg-muted/30">
                                <td className="px-2 py-0.5 border flex items-center gap-1">
                                  {col.primaryKey && <Key size={10} className="text-amber-500 shrink-0" />}
                                  <span className="truncate">{col.name}</span>
                                </td>
                                <td className="px-2 py-0.5 text-muted-foreground border">{col.type}</td>
                                <td className="text-center px-1 py-0.5 border">
                                  {col.primaryKey && <span className="text-amber-500 text-[10px] font-bold">PK</span>}
                                </td>
                                <td className="text-center px-1 py-0.5 border">
                                  {col.notNull && <span className="text-blue-500 text-[10px] font-bold">NN</span>}
                                </td>
                                <td className="px-2 py-0.5 text-muted-foreground truncate max-w-[80px] border">
                                  {col.defaultValue != null ? String(col.defaultValue) : ""}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                          {t('layout.clickSchema')}
                        </div>
                      )}

                      {/* DDL Preview */}
                      {displayDDL && (
                        <div className="border-t border-border mt-2">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
                            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('navicat.ddl')}</span>
                          </div>
                          <pre className="text-xs font-mono whitespace-pre-wrap text-blue-500 p-3 max-h-[200px] overflow-auto">
                            {displayDDL}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : activeTableTab ? (
                /* Table Data View */
                <div className="h-full flex flex-col">
                  {/* Data Toolbar */}
                  <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
                    {/* Add Row */}
                    <button
                      className="p-1 rounded hover:bg-muted text-green-600 hover:text-green-500"
                      title={t('data.addRow')}
                      onClick={handleAddRow}
                      disabled={!selectedTableData}
                    >
                      <Plus size={14} />
                    </button>
                    {/* Save */}
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title={t('data.saveChanges')}
                      onClick={handleSave}
                      disabled={!hasPendingChanges || isSaving}
                    >
                      {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    </button>
                    {/* Cancel */}
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title={t('data.cancelChanges')}
                      onClick={handleCancelChanges}
                      disabled={!hasPendingChanges}
                    >
                      <X size={14} />
                    </button>
                    {/* Delete */}
                    <button
                      className="p-1 rounded hover:bg-muted text-red-500 hover:text-red-400 disabled:opacity-30"
                      title={t('data.deleteSelected')}
                      onClick={handleDeleteRows}
                      disabled={selectedRowIndices.size === 0 || isSaving}
                    >
                      <Trash2 size={14} />
                    </button>

                    <div className="w-px h-4 bg-border mx-1" />

                    {/* Import */}
                    <div className="relative">
                      <button
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title={t('data.importData')}
                        onClick={() => { setShowImportMenu(!showImportMenu); setShowExportMenu(false); }}
                      >
                        <Download size={14} />
                      </button>
                      {showImportMenu && (
                        <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-lg z-50 min-w-[120px]">
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleImport('csv')}>{t('data.importCsv')}</button>
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleImport('json')}>{t('data.importJson')}</button>
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleImport('sql')}>{t('data.importSql')}</button>
                        </div>
                      )}
                    </div>
                    {/* Export */}
                    <div className="relative">
                      <button
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t('data.exportData')}
                        onClick={() => { setShowExportMenu(!showExportMenu); setShowImportMenu(false); }}
                        disabled={!selectedTableData || selectedTableData.rows.length === 0}
                      >
                        <Upload size={14} />
                      </button>
                      {showExportMenu && (
                        <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-lg z-50 min-w-[120px]">
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleExport('csv')}>{t('data.exportCsv')}</button>
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleExport('json')}>{t('data.exportJson')}</button>
                          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => handleExport('sql')}>{t('data.exportSql')}</button>
                        </div>
                      )}
                    </div>

                    <div className="w-px h-4 bg-border mx-1" />

                    {/* Refresh */}
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                      title="Refresh"
                      onClick={refreshCurrentTable}
                    >
                      <RefreshCw size={14} />
                    </button>

                    <div className="flex-1" />

                    {/* Messages */}
                    {dataMessage && (
                      <span className={`text-[11px] flex items-center gap-1 ${dataMessage.type === 'error' ? 'text-destructive' : 'text-green-500'}`}>
                        {dataMessage.type === 'error' ? <X size={10} /> : <Check size={10} />}
                        {dataMessage.text}
                      </span>
                    )}
                    {hasPendingChanges && (
                      <span className="text-[11px] text-yellow-500 ml-2">
                        {editedRows.size > 0 && `${editedRows.size} modified`}
                        {editedRows.size > 0 && newRows.length > 0 && ', '}
                        {newRows.length > 0 && `${newRows.length} new`}
                      </span>
                    )}
                  </div>

                  {/* Data Grid */}
                  <div className="flex-1 overflow-auto" onClick={() => { setShowImportMenu(false); setShowExportMenu(false); }}>
                    {loading ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        <div className="flex flex-col items-center">
                          <div className="w-8 h-8 border-4 border-muted-foreground border-t-[hsl(var(--tab-active))] rounded-full animate-spin mb-2"></div>
                          <span>{t('common.loading')}</span>
                        </div>
                      </div>
                    ) : error ? (
                      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
                        <div className="flex flex-col items-center">
                          <span className="mb-2">Error:</span>
                          <span>{error}</span>
                        </div>
                      </div>
                    ) : selectedTableData ? (
                      <table className="w-full text-xs border-collapse border">
                        <thead className="sticky top-0 z-10" style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
                          <tr>
                            {/* Select All checkbox */}
                            <th className="px-1 py-1 text-center border border-white/30 w-[30px]">
                              <input
                                type="checkbox"
                                className="w-3 h-3 accent-white"
                                checked={selectedRowIndices.size > 0 && selectedRowIndices.size === selectedTableData.rows.length + newRows.length}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    const all = new Set<number>();
                                    for (let i = 0; i < selectedTableData.rows.length + newRows.length; i++) all.add(i);
                                    setSelectedRowIndices(all);
                                  } else {
                                    setSelectedRowIndices(new Set());
                                  }
                                }}
                              />
                            </th>
                            {selectedTableData.columns.map((col: any, idx: number) => (
                              <th key={idx} className="text-left px-2 py-1 font-medium text-white border border-white/30 whitespace-nowrap">
                                {col.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {/* Existing rows */}
                          {selectedTableData.rows.map((row: any, rowIdx: number) => {
                            const isSelected = selectedRowIndices.has(rowIdx);
                            const rowEdits = editedRows.get(rowIdx);
                            return (
                              <tr
                                key={`row-${rowIdx}`}
                                className={`transition-colors ${isSelected ? 'bg-blue-500/10' : 'hover:bg-muted/30 even:bg-muted/20'}`}
                              >
                                <td className="px-1 py-0.5 text-center border">
                                  <input
                                    type="checkbox"
                                    className="w-3 h-3 accent-[hsl(var(--tab-active))]"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      setSelectedRowIndices(prev => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(rowIdx); else next.delete(rowIdx);
                                        return next;
                                      });
                                    }}
                                  />
                                </td>
                                {selectedTableData.columns.map((col: any, colIdx: number) => {
                                  const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.colName === col.name;
                                  const isModified = rowEdits && col.name in rowEdits;
                                  let value = rowEdits?.[col.name] ?? row[col.name];
                                  if (value === undefined) {
                                    const key = Object.keys(row).find((k) => k.toLowerCase() === col.name.toLowerCase());
                                    if (key) value = rowEdits?.[col.name] ?? row[key];
                                  }

                                  if (isEditing) {
                                    return (
                                      <td key={colIdx} className="px-0 py-0 border">
                                        <input
                                          type="text"
                                          autoFocus
                                          defaultValue={value === null || value === undefined ? "" : String(value)}
                                          className="w-full px-2 py-0.5 text-xs bg-background outline-none border-2 border-[hsl(var(--tab-active))]"
                                          onBlur={(e) => {
                                            const newVal = e.target.value;
                                            const origVal = row[col.name];
                                            const normalizedNew = newVal === "" ? null : newVal;
                                            const normalizedOrig = origVal === undefined ? null : origVal;
                                            if (String(normalizedNew ?? "") !== String(normalizedOrig ?? "")) {
                                              setEditedRows(prev => {
                                                const next = new Map(prev);
                                                const existing = next.get(rowIdx) || {};
                                                next.set(rowIdx, { ...existing, [col.name]: normalizedNew });
                                                return next;
                                              });
                                            } else {
                                              // Reverted to original — remove from edits
                                              setEditedRows(prev => {
                                                const next = new Map(prev);
                                                const existing = { ...(next.get(rowIdx) || {}) };
                                                delete existing[col.name];
                                                if (Object.keys(existing).length === 0) next.delete(rowIdx);
                                                else next.set(rowIdx, existing);
                                                return next;
                                              });
                                            }
                                            setEditingCell(null);
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                            if (e.key === 'Escape') { setEditingCell(null); }
                                          }}
                                        />
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={colIdx}
                                      className={`px-2 py-0.5 border cursor-text whitespace-nowrap max-w-[300px] overflow-hidden text-ellipsis ${isModified ? 'bg-yellow-500/10' : ''}`}
                                      onDoubleClick={() => setEditingCell({ rowIdx, colName: col.name })}
                                    >
                                      {formatValue(value)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                          {/* New rows */}
                          {newRows.map((row, nIdx) => {
                            const globalIdx = selectedTableData.rows.length + nIdx;
                            const isSelected = selectedRowIndices.has(globalIdx);
                            return (
                              <tr
                                key={`new-${nIdx}`}
                                className={`transition-colors ${isSelected ? 'bg-blue-500/10' : 'bg-green-500/5 hover:bg-green-500/10'}`}
                                style={{ borderLeft: '3px solid hsl(var(--tab-active))' }}
                              >
                                <td className="px-1 py-0.5 text-center border">
                                  <input
                                    type="checkbox"
                                    className="w-3 h-3 accent-[hsl(var(--tab-active))]"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      setSelectedRowIndices(prev => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(globalIdx); else next.delete(globalIdx);
                                        return next;
                                      });
                                    }}
                                  />
                                </td>
                                {selectedTableData.columns.map((col: any, colIdx: number) => {
                                  const isEditing = editingCell?.rowIdx === globalIdx && editingCell?.colName === col.name;
                                  const value = row[col.name];

                                  if (isEditing) {
                                    return (
                                      <td key={colIdx} className="px-0 py-0 border">
                                        <input
                                          type="text"
                                          autoFocus
                                          defaultValue={value === null || value === undefined ? "" : String(value)}
                                          className="w-full px-2 py-0.5 text-xs bg-background outline-none border-2 border-[hsl(var(--tab-active))]"
                                          onBlur={(e) => {
                                            const newVal = e.target.value === "" ? null : e.target.value;
                                            setNewRows(prev => prev.map((r, i) => i === nIdx ? { ...r, [col.name]: newVal } : r));
                                            setEditingCell(null);
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                            if (e.key === 'Escape') setEditingCell(null);
                                          }}
                                        />
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={colIdx}
                                      className="px-2 py-0.5 border cursor-text whitespace-nowrap text-muted-foreground italic"
                                      onClick={() => setEditingCell({ rowIdx: globalIdx, colName: col.name })}
                                    >
                                      {value === null || value === undefined ? 'NULL' : String(value)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        选择一个表查看数据
                      </div>
                    )}
                  </div>

                  {/* Pagination Bar */}
                  {selectedTableData && activeTableTab && (
                    <PaginationBar
                      currentPage={paginationState[activeTableTab.tableId]?.currentPage || 1}
                      totalPages={Math.max(1, Math.ceil((totalRowCountCache[activeTableTab.tableId] ?? 0) / (paginationState[activeTableTab.tableId]?.pageSize || 1000)))}
                      pageSize={paginationState[activeTableTab.tableId]?.pageSize || 1000}
                      totalRows={totalRowCountCache[activeTableTab.tableId] ?? null}
                      onPageChange={handlePageChange}
                      onPageSizeChange={handlePageSizeChange}
                      loading={loading}
                    />
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                  {currentSchemaName
                    ? `选择 ${currentSchemaName} 中的一个表`
                    : "点击左侧的 schema 或表"}
                </div>
              )}
        </div>
      )}

      {/* Table Context Menu */}
      {tableContextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setTableContextMenu(null)} />
          <div
            className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[180px]"
            style={{ left: tableContextMenu.x, top: tableContextMenu.y, backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}
          >
            <button
              onClick={() => { handleOpenTableTab(tableContextMenu.table); setTableContextMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              <Table size={12} />
              <span>{t('sidebar.openTable')}</span>
            </button>
            {tableContextMenu.table.type === 'table' && (
              <button
                onClick={() => { handleDesignTable(tableContextMenu.table); setTableContextMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <Wrench size={12} />
                <span>{t('sidebar.designTable')}</span>
              </button>
            )}
            {tableContextMenu.table.type === 'table' && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  onClick={() => { navigator.clipboard.writeText(tableContextMenu.table.name); setTableContextMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                >
                  <FileText size={12} />
                  <span>复制名称</span>
                </button>
              </>
            )}
            {tableContextMenu.table.type === 'table' && (
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
                        onClick={() => { handleDuplicateTable(tableContextMenu.table, true); setTableContextMenu(null); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                      >
                        <span>{t('sidebar.structureAndData')}</span>
                      </button>
                      <button
                        onClick={() => { handleDuplicateTable(tableContextMenu.table, false); setTableContextMenu(null); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                      >
                        <span>{t('sidebar.structureOnly')}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
            {tableContextMenu.table.type === 'table' && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  onClick={() => { handleTruncateTableAction(tableContextMenu.table); setTableContextMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-orange-500"
                >
                  <Eraser size={12} />
                  <span>{t('sidebar.truncateTable')}</span>
                </button>
                <button
                  onClick={() => { handleDeleteTableAction(tableContextMenu.table); setTableContextMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-destructive"
                >
                  <Trash2 size={12} />
                  <span>{t('sidebar.deleteTable')}</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default CrabHubMainPanel;
