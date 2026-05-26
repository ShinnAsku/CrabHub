import {
  Edit,
  Plus,
  Trash2,
  Search,
  Eye,
  Table,
  Key,
} from "lucide-react";
import { memo } from "react";
import type { Connection, SchemaNode, ColumnInfo, TableInfo } from "@/types";
import { t } from "@/lib/i18n";

interface ObjectListViewProps {
  activeConnection: Connection | null;
  currentSchemaName?: string;
  tables: SchemaNode[];
  loadedTables: SchemaNode[];
  tableMetadataMap: Record<string, TableInfo>;
  selectedTableId: string | null;
  selectedColumns: ColumnInfo[] | null;
  columnsLoading: boolean;
  previewTableName: string | null;
  displayDDL: string;
  searchTerm: string;
  onSetSearchTerm: (term: string) => void;
  onCreateTable: () => void;
  onEditTable: () => void;
  onDeleteSelectedTable: () => void;
  onTableSelect: (table: SchemaNode) => void;
  onOpenTableTab: (table: SchemaNode) => void;
  onTableContextMenu: (e: React.MouseEvent, table: SchemaNode) => void;
}

export default memo(function ObjectListView({
  activeConnection,
  tables,
  tableMetadataMap,
  selectedTableId,
  selectedColumns,
  columnsLoading,
  previewTableName,
  displayDDL,
  searchTerm,
  onSetSearchTerm,
  onCreateTable,
  onEditTable,
  onDeleteSelectedTable,
  onTableSelect,
  onOpenTableTab,
  onTableContextMenu,
}: ObjectListViewProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
        <button
          aria-label={t("designer.editTable")}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
          title={t("designer.editTable")}
          disabled={!selectedTableId}
          onClick={onEditTable}
        >
          <Edit size={14} />
        </button>
        <button
          aria-label={t("designer.createTable")}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title={t("designer.createTable")}
          onClick={onCreateTable}
        >
          <Plus size={14} />
        </button>
        <button
          aria-label={t("sidebar.deleteTable")}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30"
          title={t("sidebar.deleteTable")}
          disabled={!selectedTableId}
          onClick={onDeleteSelectedTable}
        >
          <Trash2 size={14} />
        </button>
        <div className="flex-1 relative max-w-[150px]">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("common.search")}
            value={searchTerm}
            onChange={(e) => onSetSearchTerm(e.target.value)}
            className="w-full pl-6 pr-2 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
          />
        </div>
      </div>

      {/* Table List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-xs border-collapse border" style={{ tableLayout: "fixed" }}>
            <colgroup>
              {activeConnection?.type === "mysql" ? (
                <>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "10%" }} />
                </>
              ) : (
                <>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                </>
              )}
            </colgroup>
            <thead className="sticky top-0" style={{ backgroundColor: "hsl(var(--tab-active))" }}>
              {activeConnection?.type === "mysql" ? (
                <tr>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("common.name")}>{t("common.name")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.rows")}>{t("tableHeader.rows")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.dataLength")}>{t("tableHeader.dataLength")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.engine")}>{t("tableHeader.engine")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.createdDate")}>{t("tableHeader.createdDate")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.modifiedDate")}>{t("tableHeader.modifiedDate")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.collation")}>{t("tableHeader.collation")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.comment")}>{t("tableHeader.comment")}</th>
                </tr>
              ) : (
                <tr>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("common.name")}>{t("common.name")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.oid")}>{t("tableHeader.oid")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.owner")}>{t("tableHeader.owner")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.acl")}>{t("tableHeader.acl")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.tableType")}>{t("tableHeader.tableType")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.partitionOf")}>{t("tableHeader.partitionOf")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.rows")}>{t("tableHeader.rows")}</th>
                  <th className="text-left px-2 py-1 font-medium text-white truncate border border-white/30" title={t("tableHeader.primaryKey")}>{t("tableHeader.primaryKey")}</th>
                </tr>
              )}
            </thead>
            <tbody>
              {tables.map((table) => {
                const meta = tableMetadataMap[table.id];
                if (activeConnection?.type === "mysql") {
                  const formatDataLength = (bytes: number | null | undefined) => {
                    if (bytes == null) return "—";
                    if (bytes < 1024) return `${bytes} B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                  };
                  return (
                    <tr
                      key={table.id}
                      onClick={() => onTableSelect(table)}
                      onDoubleClick={() => onOpenTableTab(table)}
                      onContextMenu={(e) => onTableContextMenu(e, table)}
                      className={`cursor-pointer hover:bg-muted/50 border-l-2 ${
                        selectedTableId === table.id
                          ? "border-l-[hsl(var(--tab-active))] bg-[hsl(var(--tab-active))]/50"
                          : "border-l-transparent"
                      }`}
                    >
                      <td className="px-2 py-1 truncate border" title={table.name}>
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
                const tableTypeLabel = meta?.tableType === "VIEW" ? t("tableType.view")
                  : meta?.tableType === "MATERIALIZED VIEW" ? t("tableType.materializedView")
                  : meta?.tableType === "PARTITIONED TABLE" ? t("tableType.partitionedTable")
                  : meta?.tableType === "FOREIGN TABLE" ? t("tableType.foreignTable")
                  : t("tableType.regular");
                return (
                  <tr
                    key={table.id}
                    onClick={() => onTableSelect(table)}
                    onDoubleClick={() => onOpenTableTab(table)}
                    onContextMenu={(e) => onTableContextMenu(e, table)}
                    className={`cursor-pointer hover:bg-muted/50 border-l-2 ${
                      selectedTableId === table.id
                        ? "border-l-[hsl(var(--tab-active))] bg-[hsl(var(--tab-active))]/20"
                        : "border-l-transparent"
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
      </div>

      {/* Columns Section */}
      <div className="border-t border-border flex flex-col" style={{ height: "200px" }}>
        <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-muted/20">
          <span className="text-xs font-medium text-foreground">
            {t('columnHeader.columns')} {previewTableName && <span className="text-muted-foreground">- {previewTableName}</span>}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {columnsLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              <div className="w-4 h-4 border-2 border-muted-foreground border-t-[hsl(var(--tab-active))] rounded-full animate-spin"></div>
            </div>
          ) : selectedColumns && selectedColumns.length > 0 ? (
            <table className="w-full text-xs border-collapse border">
              <thead className="sticky top-0" style={{ backgroundColor: "hsl(var(--tab-active))" }}>
                <tr>
                  <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30 max-w-[150px] truncate" title={t("columnHeader.name")}>{t("columnHeader.name")}</th>
                  <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30 max-w-[120px] truncate" title={t("columnHeader.type")}>{t("columnHeader.type")}</th>
                  <th className="text-center px-1 py-0.5 font-medium text-white border border-white/30">{t("columnHeader.pk")}</th>
                  <th className="text-center px-1 py-0.5 font-medium text-white border border-white/30">{t("columnHeader.nn")}</th>
                  <th className="text-left px-2 py-0.5 font-medium text-white border border-white/30">{t("columnHeader.defaultValue")}</th>
                </tr>
              </thead>
              <tbody>
                {selectedColumns.map((col, idx) => (
                  <tr key={idx} className="hover:bg-muted/30">
                    <td className="px-2 py-0.5 border flex items-center gap-1">
                      {col.primaryKey && <Key size={10} className="text-amber-500 shrink-0" />}
                      <span className="truncate" title={col.name}>{col.name}</span>
                    </td>
                    <td className="px-2 py-0.5 text-muted-foreground border truncate max-w-[120px]" title={col.type}>{col.type}</td>
                    <td className="text-center px-1 py-0.5 border">
                      {col.primaryKey && <span className="text-amber-500 text-[11px] font-bold">PK</span>}
                    </td>
                    <td className="text-center px-1 py-0.5 border">
                      {col.notNull && <span className="text-blue-500 text-[11px] font-bold">NN</span>}
                    </td>
                    <td className="px-2 py-0.5 text-muted-foreground truncate max-w-[80px] border" title={col.defaultValue != null ? String(col.defaultValue) : ""}>
                      {col.defaultValue != null ? String(col.defaultValue) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              {t("layout.clickSchema")}
            </div>
          )}

          {displayDDL && (
            <div className="border-t border-border mt-2">
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("navicat.ddl")}</span>
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap text-blue-500 p-3 max-h-[200px] overflow-auto">
                {displayDDL}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
