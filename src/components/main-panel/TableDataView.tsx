import {
  Plus,
  Save,
  X,
  Trash2,
  Download,
  Upload,
  RefreshCw,
  Loader2,
  Check,
} from "lucide-react";
import type { QueryResult, ColumnInfo, TableRow, TableTab } from "@/types";
import { t } from "@/lib/i18n";
import PaginationBar from "../PaginationBar";

interface TableDataViewProps {
  activeTableTab: TableTab;
  selectedTableData: QueryResult | null;
  loading: boolean;
  error: string | null;
  editingCell: { rowIdx: number; colName: string } | null;
  editedRows: Map<number, Record<string, any>>;
  newRows: Record<string, any>[];
  selectedRowIndices: Set<number>;
  isSaving: boolean;
  hasPendingChanges: boolean;
  dataMessage: { type: "success" | "error"; text: string } | null;
  showImportMenu: boolean;
  showExportMenu: boolean;
  paginationState: Record<string, { currentPage: number; pageSize: number }>;
  totalRowCountCache: Record<string, number>;
  setEditingCell: (cell: { rowIdx: number; colName: string } | null) => void;
  setEditedRows: React.Dispatch<React.SetStateAction<Map<number, Record<string, any>>>>;
  setNewRows: React.Dispatch<React.SetStateAction<Record<string, any>[]>>;
  setSelectedRowIndices: React.Dispatch<React.SetStateAction<Set<number>>>;
  setShowImportMenu: (v: boolean) => void;
  setShowExportMenu: (v: boolean) => void;
  formatValue: (value: unknown) => string;
  onAddRow: () => void;
  onSave: () => void;
  onCancelChanges: () => void;
  onDeleteRows: () => void;
  onImport: (format: "csv" | "json" | "sql") => void;
  onExport: (format: "csv" | "json" | "sql") => void;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export default function TableDataView({
  activeTableTab,
  selectedTableData,
  loading,
  error,
  editingCell,
  editedRows,
  newRows,
  selectedRowIndices,
  isSaving,
  hasPendingChanges,
  dataMessage,
  showImportMenu,
  showExportMenu,
  paginationState,
  totalRowCountCache,
  setEditingCell,
  setEditedRows,
  setNewRows,
  setSelectedRowIndices,
  setShowImportMenu,
  setShowExportMenu,
  formatValue,
  onAddRow,
  onSave,
  onCancelChanges,
  onDeleteRows,
  onImport,
  onExport,
  onRefresh,
  onPageChange,
  onPageSizeChange,
}: TableDataViewProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Data Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
        <button
          aria-label={t("data.addRow")}
          className="p-1 rounded hover:bg-muted text-success"
          title={t("data.addRow")}
          onClick={onAddRow}
          disabled={!selectedTableData}
        >
          <Plus size={14} />
        </button>
        <button
          aria-label={t("data.saveChanges")}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
          title={t("data.saveChanges")}
          onClick={onSave}
          disabled={!hasPendingChanges || isSaving}
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        </button>
        <button
          aria-label={t("data.cancelChanges")}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
          title={t("data.cancelChanges")}
          onClick={onCancelChanges}
          disabled={!hasPendingChanges}
        >
          <X size={14} />
        </button>
        <button
          aria-label={t("data.deleteSelected")}
          className="p-1 rounded hover:bg-muted text-destructive disabled:opacity-30"
          title={t("data.deleteSelected")}
          onClick={onDeleteRows}
          disabled={selectedRowIndices.size === 0 || isSaving}
        >
          <Trash2 size={14} />
        </button>

        <div className="w-px h-4 bg-border mx-1" />

        <div className="relative">
          <button
            aria-label={t("data.importData")}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            title={t("data.importData")}
            onClick={() => { setShowImportMenu(!showImportMenu); setShowExportMenu(false); }}
          >
            <Download size={14} />
          </button>
          {showImportMenu && (
            <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-lg z-50 min-w-[120px]">
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onImport("csv")}>{t("data.importCsv")}</button>
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onImport("json")}>{t("data.importJson")}</button>
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onImport("sql")}>{t("data.importSql")}</button>
            </div>
          )}
        </div>
        <div className="relative">
          <button
            aria-label={t("data.exportData")}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
            title={t("data.exportData")}
            onClick={() => { setShowExportMenu(!showExportMenu); setShowImportMenu(false); }}
            disabled={!selectedTableData || selectedTableData.rows.length === 0}
          >
            <Upload size={14} />
          </button>
          {showExportMenu && (
            <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-lg z-50 min-w-[120px]">
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onExport("csv")}>{t("data.exportCsv")}</button>
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onExport("json")}>{t("data.exportJson")}</button>
              <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => onExport("sql")}>{t("data.exportSql")}</button>
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-border mx-1" />

        <button
          aria-label="Refresh"
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Refresh"
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
        </button>

        <div className="flex-1" />

        {dataMessage && (
          <span className={`text-xs flex items-center gap-1 ${dataMessage.type === "error" ? "text-destructive" : "text-success"}`}>
            {dataMessage.type === "error" ? <X size={10} /> : <Check size={10} />}
            {dataMessage.text}
          </span>
        )}
        {hasPendingChanges && (
          <span className="text-xs text-warning ml-2">
            {editedRows.size > 0 && `${editedRows.size} modified`}
            {editedRows.size > 0 && newRows.length > 0 && ", "}
            {newRows.length > 0 && `${newRows.length} new`}
          </span>
        )}
      </div>

      {/* Data Grid */}
      <div
        className="flex-1 overflow-auto"
        onClick={() => { setShowImportMenu(false); setShowExportMenu(false); }}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            <div className="flex flex-col items-center">
              <div className="w-8 h-8 border-4 border-muted-foreground border-t-[hsl(var(--tab-active))] rounded-full animate-spin mb-2"></div>
              <span>{t("common.loading")}</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-destructive text-sm p-4">
            <div className="flex flex-col items-center">
              <span className="mb-2">Error:</span>
              <span>{error}</span>
            </div>
          </div>
        ) : selectedTableData ? (
          <table className="w-full text-xs border-collapse border">
            <thead className="sticky top-0 z-10" style={{ backgroundColor: "hsl(var(--tab-active))" }}>
              <tr>
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
                {selectedTableData.columns.map((col: ColumnInfo, idx: number) => (
                  <th key={idx} className="text-left px-2 py-1 font-medium text-white border border-white/30 whitespace-nowrap">
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selectedTableData.rows.map((row: TableRow, rowIdx: number) => {
                const isSelected = selectedRowIndices.has(rowIdx);
                const rowEdits = editedRows.get(rowIdx);
                return (
                  <tr
                    key={`row-${rowIdx}`}
                    className={`transition-colors ${isSelected ? "bg-blue-500/10" : "hover:bg-muted/30 even:bg-muted/20"}`}
                  >
                    <td className="px-1 py-0.5 text-center border">
                      <input
                        type="checkbox"
                        className="w-3 h-3 accent-[hsl(var(--tab-active))]"
                        checked={isSelected}
                        onChange={(e) => {
                          setSelectedRowIndices((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(rowIdx);
                            else next.delete(rowIdx);
                            return next;
                          });
                        }}
                      />
                    </td>
                    {selectedTableData.columns.map((col: ColumnInfo, colIdx: number) => {
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
                                  setEditedRows((prev) => {
                                    const next = new Map(prev);
                                    const existing = next.get(rowIdx) || {};
                                    next.set(rowIdx, { ...existing, [col.name]: normalizedNew });
                                    return next;
                                  });
                                } else {
                                  setEditedRows((prev) => {
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
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") setEditingCell(null);
                              }}
                            />
                          </td>
                        );
                      }

                      return (
                        <td
                          key={colIdx}
                          className={`px-2 py-0.5 border cursor-text whitespace-nowrap max-w-[300px] overflow-hidden text-ellipsis ${isModified ? "bg-yellow-500/10" : ""}`}
                          onDoubleClick={() => setEditingCell({ rowIdx, colName: col.name })}
                        >
                          {formatValue(value)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {newRows.map((row, nIdx) => {
                const globalIdx = selectedTableData.rows.length + nIdx;
                const isSelected = selectedRowIndices.has(globalIdx);
                return (
                  <tr
                    key={`new-${nIdx}`}
                    className={`transition-colors ${isSelected ? "bg-blue-500/10" : "bg-green-500/5 hover:bg-green-500/10"}`}
                    style={{ borderLeft: "3px solid hsl(var(--tab-active))" }}
                  >
                    <td className="px-1 py-0.5 text-center border">
                      <input
                        type="checkbox"
                        className="w-3 h-3 accent-[hsl(var(--tab-active))]"
                        checked={isSelected}
                        onChange={(e) => {
                          setSelectedRowIndices((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(globalIdx);
                            else next.delete(globalIdx);
                            return next;
                          });
                        }}
                      />
                    </td>
                    {selectedTableData.columns.map((col: ColumnInfo, colIdx: number) => {
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
                                setNewRows((prev) => prev.map((r, i) => (i === nIdx ? { ...r, [col.name]: newVal } : r)));
                                setEditingCell(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") setEditingCell(null);
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
                          {value === null || value === undefined ? "NULL" : String(value)}
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
            {t('sidebar.selectTable')}
          </div>
        )}
      </div>

      {/* Pagination Bar */}
      {selectedTableData && (
        <PaginationBar
          currentPage={paginationState[activeTableTab.tableId]?.currentPage || 1}
          totalPages={Math.max(
            1,
            Math.ceil((totalRowCountCache[activeTableTab.tableId] ?? 0) / (paginationState[activeTableTab.tableId]?.pageSize || 1000)),
          )}
          pageSize={paginationState[activeTableTab.tableId]?.pageSize || 1000}
          totalRows={totalRowCountCache[activeTableTab.tableId] ?? null}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          loading={loading}
        />
      )}
    </div>
  );
}
