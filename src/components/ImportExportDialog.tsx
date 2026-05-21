import { useState, useEffect, useCallback } from "react";
import { Upload, Download, X, Loader2, Check } from "lucide-react";
import { useConnectionStore, useUIStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { getSchemas, getTables, getTableData, exportTableSql, executeSql, insertTableRow } from "@/lib/tauri-commands";
import { exportToCSV, exportToJSON, downloadFile, importFromCSV, importFromJSON } from "@/lib/export";
import type { TableInfo } from "@/types";

interface ImportExportDialogProps {
  isOpen: boolean;
  mode: "import" | "export";
  onClose: () => void;
}

function ImportExportDialog({ isOpen, mode, onClose }: ImportExportDialogProps) {
  const { connections, activeConnectionId } = useConnectionStore();
  const { selectedSchemaName } = useUIStore();
  const connectedConns = connections.filter((c) => c.connected);

  const [selectedConnId, setSelectedConnId] = useState<string>("");
  const [schemaList, setSchemaList] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string>("");
  const [loadingSchemas, setLoadingSchemas] = useState(false);

  const [tableList, setTableList] = useState<TableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  const [format, setFormat] = useState<"sql" | "csv" | "json">("sql");
  const [executing, setExecuting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Import-specific state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTargetTable, setImportTargetTable] = useState<string>("");

  // Pre-select on open
  useEffect(() => {
    if (isOpen) {
      const initConn = activeConnectionId && connectedConns.find((c) => c.id === activeConnectionId)
        ? activeConnectionId
        : connectedConns[0]?.id || "";
      setSelectedConnId(initConn);
      setSelectedSchema("");
      setSchemaList([]);
      setTableList([]);
      setSelectedTables(new Set());
      setMessage(null);
      setImportFile(null);
      setImportTargetTable("");
      setFormat("sql");
    }
  }, [isOpen]);

  // Load schemas when connection changes
  useEffect(() => {
    if (!selectedConnId) {
      setSchemaList([]);
      setSelectedSchema("");
      return;
    }
    const conn = connectedConns.find((c) => c.id === selectedConnId);
    if (!conn) return;
    if (conn.type === "sqlite") {
      setSchemaList([]);
      setSelectedSchema("");
      return;
    }

    let cancelled = false;
    setLoadingSchemas(true);
    setTableList([]);
    setSelectedTables(new Set());
    getSchemas(selectedConnId)
      .then((schemas) => {
        if (cancelled) return;
        setSchemaList(schemas);
        if (selectedSchemaName && schemas.includes(selectedSchemaName)) {
          setSelectedSchema(selectedSchemaName);
        } else if (schemas.length > 0) {
          const pub = schemas.find((s) => s === "public");
          setSelectedSchema(pub || schemas[0] || "");
        }
      })
      .catch(() => { if (!cancelled) setSchemaList([]); })
      .finally(() => { if (!cancelled) setLoadingSchemas(false); });
    return () => { cancelled = true; };
  }, [selectedConnId]);

  // Load tables when schema changes
  useEffect(() => {
    if (!selectedConnId) {
      setTableList([]);
      return;
    }
    const conn = connectedConns.find((c) => c.id === selectedConnId);
    if (!conn) return;

    // For non-sqlite, wait for schema selection
    if (conn.type !== "sqlite" && !selectedSchema) {
      setTableList([]);
      return;
    }

    let cancelled = false;
    setLoadingTables(true);
    setSelectedTables(new Set());
    getTables(selectedConnId)
      .then((tables) => {
        if (cancelled) return;
        let filtered = tables;
        if (selectedSchema) {
          filtered = tables.filter((ti) => !ti.schema || ti.schema === selectedSchema);
        }
        setTableList(filtered);
        // Auto-select all for export
        if (mode === "export") {
          setSelectedTables(new Set(filtered.map((ti) => ti.name)));
        }
      })
      .catch(() => { if (!cancelled) setTableList([]); })
      .finally(() => { if (!cancelled) setLoadingTables(false); });
    return () => { cancelled = true; };
  }, [selectedConnId, selectedSchema]);

  const toggleTable = useCallback((name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedTables.size === tableList.length) {
      setSelectedTables(new Set());
    } else {
      setSelectedTables(new Set(tableList.map((ti) => ti.name)));
    }
  }, [selectedTables.size, tableList]);

  // Export handler
  const handleExport = useCallback(async () => {
    if (!selectedConnId || selectedTables.size === 0) return;
    setExecuting(true);
    setMessage(null);
    try {
      const schema = selectedSchema || undefined;
      if (format === "sql") {
        // Export DDL for each selected table
        const parts: string[] = [];
        for (const tableName of selectedTables) {
          const ddl = await exportTableSql(selectedConnId, tableName, schema);
          parts.push(`-- Table: ${tableName}\n${ddl}\n`);
        }
        const content = parts.join("\n");
        const dbName = selectedSchema || "database";
        await downloadFile(content, `${dbName}_export.sql`, "text/sql");
        setMessage({ type: "success", text: t('importExport.exportSuccess') });
      } else {
        // CSV/JSON: export data for each table
        for (const tableName of selectedTables) {
          const result = await getTableData(selectedConnId, tableName, 1, 100000, undefined, schema);
          if (!result.columns || result.columns.length === 0) continue;
          if (format === "csv") {
            const content = exportToCSV(result.columns, result.rows);
            await downloadFile(content, `${tableName}.csv`, "text/csv");
          } else {
            const content = exportToJSON(result.columns, result.rows);
            await downloadFile(content, `${tableName}.json`, "application/json");
          }
        }
        setMessage({ type: "success", text: t('importExport.exportSuccess') });
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: `${t('importExport.exportFailed')}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExecuting(false);
    }
  }, [selectedConnId, selectedTables, selectedSchema, format]);

  // Import handler
  const handleImport = useCallback(async () => {
    if (!selectedConnId || !importFile) return;
    setExecuting(true);
    setMessage(null);
    try {
      const schema = selectedSchema || undefined;
      const ext = importFile.name.split(".").pop()?.toLowerCase();
      const fileContent = await importFile.text();

      if (ext === "sql" || format === "sql") {
        // Execute SQL directly
        await executeSql(selectedConnId, fileContent);
        setMessage({ type: "success", text: t('importExport.importSuccess') });
      } else if (ext === "csv" || format === "csv") {
        if (!importTargetTable) {
          setMessage({ type: "error", text: t('importExport.targetTable') });
          setExecuting(false);
          return;
        }
        const parsed = await importFromCSV(importFile);
        let count = 0;
        for (const row of parsed.rows) {
          const values: [string, any][] = parsed.columns.map((col) => [col, row[col]]);
          await insertTableRow(selectedConnId, importTargetTable, values, schema);
          count++;
        }
        setMessage({ type: "success", text: `${t('importExport.importSuccess')} (${count} rows)` });
      } else if (ext === "json" || format === "json") {
        if (!importTargetTable) {
          setMessage({ type: "error", text: t('importExport.targetTable') });
          setExecuting(false);
          return;
        }
        const parsed = await importFromJSON(importFile);
        let count = 0;
        for (const row of parsed.rows) {
          const values: [string, any][] = parsed.columns.map((col) => [col, row[col]]);
          await insertTableRow(selectedConnId, importTargetTable, values, schema);
          count++;
        }
        setMessage({ type: "success", text: `${t('importExport.importSuccess')} (${count} rows)` });
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: `${t('importExport.importFailed')}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExecuting(false);
    }
  }, [selectedConnId, importFile, selectedSchema, format, importTargetTable]);

  // File picker handler
  const handleFilePick = useCallback(async () => {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (isTauri) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const filePath = await open({
          multiple: false,
          filters: [
            { name: "SQL", extensions: ["sql"] },
            { name: "CSV", extensions: ["csv"] },
            { name: "JSON", extensions: ["json"] },
            { name: "All Files", extensions: ["*"] },
          ],
        });
        if (filePath && typeof filePath === "string") {
          const content = await readTextFile(filePath);
          const name = filePath.split("/").pop() || filePath.split("\\").pop() || "file";
          const blob = new Blob([content], { type: "text/plain" });
          const file = new File([blob], name);
          setImportFile(file);
          // Auto-detect format
          const ext = name.split(".").pop()?.toLowerCase();
          if (ext === "sql") setFormat("sql");
          else if (ext === "csv") setFormat("csv");
          else if (ext === "json") setFormat("json");
        }
      } else {
        // Browser fallback
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".sql,.csv,.json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (file) {
            setImportFile(file);
            const ext = file.name.split(".").pop()?.toLowerCase();
            if (ext === "sql") setFormat("sql");
            else if (ext === "csv") setFormat("csv");
            else if (ext === "json") setFormat("json");
          }
        };
        input.click();
      }
    } catch (err) {
      console.error("File pick failed:", err);
    }
  }, []);

  if (!isOpen) return null;

  const isExport = mode === "export";
  const Icon = isExport ? Download : Upload;
  const title = isExport ? t('importExport.exportTitle') : t('importExport.importTitle');
  const connType = connectedConns.find((c) => c.id === selectedConnId)?.type;
  const showSchemaSelector = selectedConnId && connType !== "sqlite";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Icon size={14} className="text-foreground" />
            <span className="text-sm font-medium text-foreground">{title}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {connectedConns.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('er.noConnections')}
            </div>
          ) : (
            <>
              {/* Connection selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('importExport.selectConnection')}</label>
                <select
                  value={selectedConnId}
                  onChange={(e) => setSelectedConnId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                >
                  <option value="" disabled>{t('importExport.selectConnection')}</option>
                  {connectedConns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </div>

              {/* Schema/Database selector */}
              {showSchemaSelector && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t('importExport.selectSchema')}</label>
                  {loadingSchemas ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                      <Loader2 size={12} className="animate-spin" />
                      <span>{t('common.loading')}</span>
                    </div>
                  ) : (
                    <select
                      value={selectedSchema}
                      onChange={(e) => setSelectedSchema(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                      disabled={schemaList.length === 0}
                    >
                      {schemaList.length === 0 && <option value="">{t('importExport.selectSchema')}</option>}
                      {schemaList.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Export: table selection + format */}
              {isExport && (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-foreground">{t('importExport.selectTables')}</label>
                      {tableList.length > 0 && (
                        <button
                          onClick={toggleAll}
                          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {selectedTables.size === tableList.length ? t('common.cancel') : t('importExport.selectAll')}
                        </button>
                      )}
                    </div>
                    {loadingTables ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                        <Loader2 size={12} className="animate-spin" />
                        <span>{t('common.loading')}</span>
                      </div>
                    ) : tableList.length === 0 ? (
                      <div className="text-xs text-muted-foreground py-2">{t('importExport.noTables')}</div>
                    ) : (
                      <div className="border border-border rounded max-h-[200px] overflow-y-auto">
                        {tableList.map((ti) => (
                          <label
                            key={ti.name}
                            className="flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted/50 cursor-pointer transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedTables.has(ti.name)}
                              onChange={() => toggleTable(ti.name)}
                              className="rounded border-border"
                            />
                            <span className="text-foreground">{ti.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {selectedTables.size > 0 && (
                      <div className="text-[10px] text-muted-foreground">
                        {t('importExport.selectedCount').replace('{count}', String(selectedTables.size))}
                      </div>
                    )}
                  </div>

                  {/* Format selector */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">{t('importExport.selectFormat')}</label>
                    <div className="flex items-center gap-4">
                      {(["sql", "csv", "json"] as const).map((f) => (
                        <label key={f} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="radio"
                            name="export-format"
                            checked={format === f}
                            onChange={() => setFormat(f)}
                            className="text-[hsl(var(--tab-active))]"
                          />
                          <span className="text-foreground uppercase">{f}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Import: file picker + format + target table */}
              {!isExport && (
                <>
                  {/* File picker */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">{t('importExport.selectFile')}</label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleFilePick}
                        className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted transition-colors"
                      >
                        {t('importExport.selectFile')}
                      </button>
                      {importFile && (
                        <span className="text-xs text-muted-foreground truncate max-w-[250px]">
                          {importFile.name}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Format selector (auto-detected but adjustable) */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">{t('importExport.selectFormat')}</label>
                    <div className="flex items-center gap-4">
                      {(["sql", "csv", "json"] as const).map((f) => (
                        <label key={f} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="radio"
                            name="import-format"
                            checked={format === f}
                            onChange={() => setFormat(f)}
                            className="text-[hsl(var(--tab-active))]"
                          />
                          <span className="text-foreground uppercase">{f}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Target table (for CSV/JSON import) */}
                  {format !== "sql" && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-foreground">{t('importExport.targetTable')}</label>
                      {loadingTables ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                          <Loader2 size={12} className="animate-spin" />
                        </div>
                      ) : tableList.length > 0 ? (
                        <select
                          value={importTargetTable}
                          onChange={(e) => setImportTargetTable(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                        >
                          <option value="">{t('importExport.targetTable')}</option>
                          {tableList.map((ti) => (
                            <option key={ti.name} value={ti.name}>{ti.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={importTargetTable}
                          onChange={(e) => setImportTargetTable(e.target.value)}
                          placeholder={t('importExport.targetTable')}
                          className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                        />
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Message */}
              {message && (
                <div className={`flex items-center gap-2 text-xs px-2.5 py-2 rounded ${
                  message.type === "success"
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-red-500/10 text-red-600 dark:text-red-400"
                }`}>
                  {message.type === "success" && <Check size={12} />}
                  <span>{message.text}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={isExport ? handleExport : handleImport}
            disabled={
              executing ||
              !selectedConnId ||
              (isExport && selectedTables.size === 0) ||
              (!isExport && !importFile)
            }
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {executing && <Loader2 size={12} className="animate-spin" />}
            {executing
              ? (isExport ? t('importExport.exporting') : t('importExport.importing'))
              : (isExport ? t('importExport.exportTitle') : t('importExport.importTitle'))
            }
          </button>
        </div>
      </div>
    </div>
  );
}

export default ImportExportDialog;
