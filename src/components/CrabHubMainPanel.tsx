import { useState, useCallback, useEffect, useRef, memo } from "react";
import { useUIStore, useTabStore } from "@/stores/app-store";
import type { SchemaNode, Connection, ColumnInfo, TableInfo, QueryResult, TableTab } from "@/types";
import { t } from "@/lib/i18n";
import { getTableData, exportTableSql, getColumns, getTables, executeSql, insertTableRow, updateTableRows, deleteTableRows, getTableRowCount } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, exportToSQL, downloadFile, importFromCSV, importFromJSON, buildWhereConditions, generateCopyTableName, buildDuplicateTableSQL } from "@/lib/export";
import EditorPanel from "./EditorPanel";
import MainPanelTabBar from "./main-panel/MainPanelTabBar";
import ObjectListView from "./main-panel/ObjectListView";
import TableDataView from "./main-panel/TableDataView";
import TableContextMenu from "./main-panel/TableContextMenu";
import WelcomeScreen from "./WelcomeScreen";
import { log } from "@/lib/log";

interface CrabHubMainPanelProps {
  activeConnection: Connection | null;
  selectedSchemaName?: string;
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

  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const rehydrated = useTabStore((s) => s.rehydrated);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const addTab = useTabStore((s) => s.addTab);

  const currentSchemaName = propsSelectedSchemaName ?? selectedSchemaName;

  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Table data cache
  const [tableDataCache, setTableDataCache] = useState<Record<string, { data: QueryResult; ddl: string }>>({});

  // Column preview state (single-click)
  const [selectedColumns, setSelectedColumns] = useState<ColumnInfo[] | null>(null);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [previewDDL, setPreviewDDL] = useState<string>("");
  const [_ddlLoading, setDdlLoading] = useState(false);
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

  // Find active tab from store
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
  const activeTableTab = (activeTab?.type === 'table' && activeTab.tableId) ? activeTab as TableTab : null;

  // When no connection is active, clear persisted tabs and reset to objects view
  useEffect(() => {
    if (rehydrated && !activeConnection && tabs.length > 0) {
      useTabStore.setState({ tabs: [], activeTabId: null, queryResults: {}, isExecuting: {} });
    }
  }, [rehydrated, activeConnection, tabs.length]);

  // Load tables when activeConnection changes
  useEffect(() => {
    if (!activeConnection) {
      setLoadedTables([]);
      setTableMetadataMap({});
      return;
    }
    const connId = activeConnection.id;
    log.debug('[CrabHubMainPanel] Loading tables for connection:', connId);
    getTables(connId).then((result) => {
      const metaMap: Record<string, TableInfo> = {};
      const tableNodes: SchemaNode[] = result
        .filter((t) => currentSchemaName && (!t.schema || t.schema === currentSchemaName))
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
      log.debug('[CrabHubMainPanel] Loaded', tableNodes.length, 'tables with metadata');
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
        setActiveTab(detail.tabId);
      }
    };
    window.addEventListener('openQueryTab', handler);
    return () => window.removeEventListener('openQueryTab', handler);
  }, []);

  const tables = searchTerm
    ? loadedTables.filter((t) => t.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : loadedTables;

  const formatValue = (value: unknown): string => {
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
    log.debug('[CrabHubMainPanel] loadTableData:', table.name, 'schema:', resolvedSchema, 'page:', effectivePage, 'pageSize:', effectivePageSize);

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
        const updates: [string, unknown][] = Object.entries(changes);
        if (updates.length === 0) continue;

        const colsForWhere = (tableColumnInfoMap[activeTableTab.tableId] || selectedTableData.columns).map((c: ColumnInfo) => ({
          name: c.name,
          isPrimaryKey: c.primaryKey ?? false,
        }));
        const where = buildWhereConditions(colsForWhere, originalRow);
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
        const colsForWhere = (tableColumnInfoMap[activeTableTab.tableId] || selectedTableData.columns).map((c: ColumnInfo) => ({
          name: c.name,
          isPrimaryKey: c.primaryKey ?? false,
        }));
        const where = buildWhereConditions(colsForWhere, row);
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
    const existingTab = tabs.find((t) => t.type === 'table' && t.tableId === table.id);

    if (existingTab) {
      setActiveTab(existingTab.id);
    } else {
      addTab({
        title: table.name,
        type: "table",
        tableId: table.id,
        tableName: table.name,
        schemaName: resolvedSchema,
        connectionId: connId,
      });
      // Initialize pagination state for new tab
      setPaginationState(prev => ({
        ...prev,
        [table.id]: prev[table.id] || { currentPage: 1, pageSize: 1000 }
      }));
    }

    loadTableData(table, resolvedSchema, connId);
  }, [tabs, loadTableData, selectedContext, currentSchemaName, activeConnection, addTab, setActiveTab]);

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
    // Fetch columns and DDL in parallel — columns show immediately, DDL fills in when ready
    getColumns(connId, table.name, resolvedSchema)
      .then((columns) => { setSelectedColumns(columns); })
      .catch((err) => { console.error("Failed to load columns:", err); })
      .finally(() => { setColumnsLoading(false); });
    exportTableSql(connId, table.name, resolvedSchema)
      .then((ddl) => { setPreviewDDL(ddl); })
      .catch(() => { setPreviewDDL("-- DDL not available"); })
      .finally(() => { setDdlLoading(false); });
  }, [activeConnection, selectedContext, currentSchemaName]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tabId);
  }, [closeTab]);

  // Track previous selectedTable to avoid circular triggers
  const prevSelectedTableRef = useRef<string | null>(null);

  // When selectedTable changes (from sidebar double-click), open a tab
  useEffect(() => {
    if (selectedTable && (activeConnection || selectedContext?.connectionId)) {
      const tableKey = `${selectedTable.schema}.${selectedTable.name}`;
      if (prevSelectedTableRef.current !== tableKey || !tabs.find(t => t.type === 'table' && t.tableId === (selectedTableId || `table-${selectedTable.name}`))) {
        prevSelectedTableRef.current = tableKey;
        log.debug('[CrabHubMainPanel] selectedTable changed:', tableKey);
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
      setActiveTab(null);
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
    if (activeTabId && activeTab?.type === 'table' && activeTab.tableId) {
      const cached = tableDataCache[activeTab.tableId];
      if (cached) {
        useUIStore.getState().setSelectedTableData(cached.data);
        useUIStore.getState().setSelectedTableDDL(cached.ddl);
      }
    }
  }, [activeTabId, tableDataCache]);

  useEffect(() => {
    if (currentSchemaName && activeConnection) {
      log.debug('[CrabHubMainPanel] Schema changed:', currentSchemaName);
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
  }, [activeTabId, activeTableTab?.tableId]);

  // Determine which DDL to show
  const displayDDL = previewDDL || selectedTableDDL || "";

  // Whether we're showing the objects view (requires schema selection)
  const showObjectsView = !!currentSchemaName && activeTabId === null;

  // Whether we're showing a query editor (non-table tab active AND have a connection)
  const showQueryView = !!activeConnection && activeTabId !== null && activeTab?.type !== 'table';

  // Right-click context menu handlers for table rows
  const handleTableContextMenu = useCallback((e: React.MouseEvent, table: SchemaNode) => {
    e.preventDefault();
    e.stopPropagation();
    setTableContextMenu({ x: e.clientX, y: e.clientY, table });
  }, []);

  const handleDesignTable = useCallback((table: SchemaNode) => {
    if (!activeConnection) return;
    addTab({
      title: `${t('sidebar.designTable')} - ${table.name}`,
      type: 'designer',
      content: '',
      connectionId: activeConnection.id,
      tableName: table.name,
      schemaName: table.schemaName || currentSchemaName,
    });
  }, [activeConnection, currentSchemaName, addTab]);

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
    const queryCount = tabs.filter((tab) => tab.type === "query").length + 1;
    addTab({
      title: `${t('tab.newQuery')} ${queryCount}`,
      type: "query",
      content: "",
    });
  }, [tabs, addTab]);

  // ---- Toolbar action wrappers (extracted from inline JSX) ----
  const handleEditSelectedTable = useCallback(() => {
    if (!selectedTableId) return;
    const table = loadedTables.find((t) => t.id === selectedTableId);
    if (table) handleDesignTable(table);
  }, [selectedTableId, loadedTables, handleDesignTable]);

  const handleDeleteSelectedTable = useCallback(() => {
    if (!selectedTableId) return;
    const table = loadedTables.find((t) => t.id === selectedTableId);
    if (table) handleDeleteTableAction(table);
  }, [selectedTableId, loadedTables, handleDeleteTableAction]);

  const handleCreateNewTable = useCallback(() => {
    if (!activeConnection) return;
    addTab({
      title: t('designer.createTable'),
      type: 'designer',
      content: '',
      connectionId: activeConnection.id,
      schemaName: currentSchemaName,
    });
  }, [activeConnection, addTab, currentSchemaName]);

  return (
    <div className="flex flex-col h-full bg-background">
      <MainPanelTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSetActiveTab={setActiveTab}
        onCloseTab={handleCloseTab}
        onAddQueryTab={handleAddQueryTab}
      />

      {showQueryView ? (
        <div className="flex-1 overflow-hidden">
          <EditorPanel />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">
          {showObjectsView ? (
            <ObjectListView
              activeConnection={activeConnection}
              currentSchemaName={currentSchemaName}
              tables={tables}
              loadedTables={loadedTables}
              tableMetadataMap={tableMetadataMap}
              selectedTableId={selectedTableId}
              selectedColumns={selectedColumns}
              columnsLoading={columnsLoading}
              previewTableName={previewTableName}
              displayDDL={displayDDL}
              searchTerm={searchTerm}
              onSetSearchTerm={setSearchTerm}
              onCreateTable={handleCreateNewTable}
              onEditTable={handleEditSelectedTable}
              onDeleteSelectedTable={handleDeleteSelectedTable}
              onTableSelect={handleTableSelect}
              onOpenTableTab={(tbl) => handleOpenTableTab(tbl)}
              onTableContextMenu={handleTableContextMenu}
            />
          ) : activeTableTab ? (
            <TableDataView
              activeTableTab={activeTableTab}
              selectedTableData={selectedTableData}
              loading={loading}
              error={error}
              editingCell={editingCell}
              editedRows={editedRows}
              newRows={newRows}
              selectedRowIndices={selectedRowIndices}
              isSaving={isSaving}
              hasPendingChanges={hasPendingChanges}
              dataMessage={dataMessage}
              showImportMenu={showImportMenu}
              showExportMenu={showExportMenu}
              paginationState={paginationState}
              totalRowCountCache={totalRowCountCache}
              setEditingCell={setEditingCell}
              setEditedRows={setEditedRows}
              setNewRows={setNewRows}
              setSelectedRowIndices={setSelectedRowIndices}
              setShowImportMenu={setShowImportMenu}
              setShowExportMenu={setShowExportMenu}
              formatValue={formatValue}
              onAddRow={handleAddRow}
              onSave={handleSave}
              onCancelChanges={handleCancelChanges}
              onDeleteRows={handleDeleteRows}
              onImport={handleImport}
              onExport={handleExport}
              onRefresh={refreshCurrentTable}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          ) : (
            <WelcomeScreen />
          )}
        </div>
      )}

      {tableContextMenu && (
        <TableContextMenu
          menu={tableContextMenu}
          onClose={() => setTableContextMenu(null)}
          onOpenTable={(tbl) => handleOpenTableTab(tbl)}
          onDesignTable={handleDesignTable}
          onCopyName={(tbl) => { navigator.clipboard.writeText(tbl.name); }}
          onDuplicateTable={handleDuplicateTable}
          onTruncate={handleTruncateTableAction}
          onDeleteTable={handleDeleteTableAction}
        />
      )}
    </div>
  );
}

export default memo(CrabHubMainPanel, (prev, next) => {
  // The Connection object identity may change even when the underlying
  // connection is the same. Compare by id + a few primary fields plus the
  // selected schema name, which is what the panel actually depends on.
  const a = prev.activeConnection;
  const b = next.activeConnection;
  if (a === b) return prev.selectedSchemaName === next.selectedSchemaName;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.connected === b.connected &&
    a.database === b.database &&
    a.type === b.type &&
    prev.selectedSchemaName === next.selectedSchemaName
  );
});
