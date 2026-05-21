import { useState, useCallback, useMemo, useEffect } from "react";
import {
  Plus,
  Minus,
  Save,
  Copy,
  Loader2,
  Check,
  X,
  RefreshCw,
  KeyRound,
  FileCode,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { DATA_TYPES, getDataTypeInfo, normalizeDbType, isSequenceDefault, type DataType } from "@/lib/data-types";
import { generateCreateTable, generateAlterTable, type ColumnDef, type TableDef } from "@/lib/ddl-generator";
import { executeSql, getColumns, getSchemas, getTableIndexes, getTableForeignKeys } from "@/lib/tauri-commands";

interface TableDesignerProps {
  connectionId?: string;
  editTable?: { name: string; schema?: string };
}

type DesignerTab = 'fields' | 'indexes' | 'foreignKeys' | 'triggers' | 'checks' | 'options' | 'comment' | 'sqlPreview';

function createDefaultColumn(): ColumnDef {
  return {
    name: "",
    dataType: "integer",
    length: undefined,
    precision: undefined,
    scale: undefined,
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    defaultValue: "",
    comment: "",
    unique: false,
  };
}

function TableDesigner({ connectionId, editTable }: TableDesignerProps) {
  const { connections, activeConnectionId, addTab } = useAppStore();

  const connId = connectionId || activeConnectionId;
  const connection = connections.find((c) => c.id === connId);
  const dbType = connection?.type || "postgresql";

  const [tableName, setTableName] = useState(editTable?.name || "");
  const [schema, setSchema] = useState(editTable?.schema || "");
  const [tableComment, setTableComment] = useState("");
  const [columns, setColumns] = useState<ColumnDef[]>([createDefaultColumn()]);
  const [engine, setEngine] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [orderBy, setOrderBy] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [messages, setMessages] = useState<{ type: "success" | "error"; text: string }[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [originalColumns, setOriginalColumns] = useState<ColumnDef[]>([]);

  // New states for Navicat-style UI
  const [activeDesignerTab, setActiveDesignerTab] = useState<DesignerTab>('fields');
  const [selectedColumnIndex, setSelectedColumnIndex] = useState<number | null>(null);
  const [indexes, setIndexes] = useState<any[]>([]);
  const [foreignKeys, setForeignKeys] = useState<any[]>([]);

  // Table name dialog state (for create mode)
  const [showTableNameDialog, setShowTableNameDialog] = useState(false);
  const [dialogTableName, setDialogTableName] = useState("");

  // Load schemas
  useEffect(() => {
    if (!connId) return;
    const loadSchemas = async () => {
      try {
        const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
        if (!isTauri) return;
        const s = await getSchemas(connId);
        setSchemas(s);
      } catch { /* ignore */ }
    };
    loadSchemas();
  }, [connId]);

  // Refresh: reload columns, indexes, foreign keys from database
  const handleRefresh = useCallback(async () => {
    if (!editTable || !connId) return;
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!isTauri) return;
      console.log('[TableDesigner] Refreshing columns for:', editTable.name, 'schema:', editTable.schema);
      const cols = await getColumns(connId, editTable.name, editTable.schema);
      const columnDefs: ColumnDef[] = cols.map((c) => {
        const normalizedType = normalizeDbType(dbType, c.type);
        const isAutoInc = isSequenceDefault(c.defaultValue);
        return {
          name: c.name,
          dataType: normalizedType,
          length: c.length ?? undefined,
          precision: c.precision ?? undefined,
          scale: c.scale ?? undefined,
          nullable: !c.notNull,
          primaryKey: c.primaryKey,
          autoIncrement: isAutoInc,
          defaultValue: isAutoInc ? "" : (c.defaultValue || ""),
          comment: c.description || "",
          unique: c.unique,
        };
      });
      setColumns(columnDefs.length > 0 ? columnDefs : [createDefaultColumn()]);
      setOriginalColumns(columnDefs);
      setIsEditMode(true);

      try {
        const [idx, fk] = await Promise.all([
          getTableIndexes(connId, editTable.name, editTable.schema),
          getTableForeignKeys(connId, editTable.name, editTable.schema),
        ]);
        setIndexes(idx || []);
        setForeignKeys(fk || []);
      } catch (err) {
        console.error('[TableDesigner] Failed to load indexes/fkeys:', err);
      }
    } catch (err) {
      console.error('[TableDesigner] Failed to load columns:', err);
      setColumns([createDefaultColumn()]);
    }
  }, [editTable?.name, editTable?.schema, connId, dbType]);

  // Load existing table columns on mount
  useEffect(() => {
    handleRefresh();
  }, [handleRefresh]);

  // Generate SQL preview
  const sqlPreview = useMemo(() => {
    if (!tableName.trim() || columns.every((c) => !c.name.trim())) return "";

    if (isEditMode && editTable) {
      const changes: { type: "add" | "drop" | "modify"; column?: ColumnDef; oldName?: string }[] = [];
      for (const orig of originalColumns) {
        if (!columns.find((c) => c.name === orig.name)) {
          changes.push({ type: "drop", oldName: orig.name });
        }
      }
      for (const col of columns) {
        if (!col.name.trim()) continue;
        const orig = originalColumns.find((c) => c.name === col.name);
        if (!orig) {
          changes.push({ type: "add", column: col });
        } else {
          // Comprehensive comparison of all relevant fields
          const normalizeVal = (v: any) => (v === undefined || v === null || v === "") ? "" : String(v);
          const normalizeNum = (v: any) => (v === undefined || v === null) ? null : Number(v);
          const isModified =
            col.dataType !== orig.dataType ||
            col.nullable !== orig.nullable ||
            normalizeVal(col.defaultValue) !== normalizeVal(orig.defaultValue) ||
            normalizeVal(col.comment) !== normalizeVal(orig.comment) ||
            normalizeNum(col.length) !== normalizeNum(orig.length) ||
            normalizeNum(col.precision) !== normalizeNum(orig.precision) ||
            normalizeNum(col.scale) !== normalizeNum(orig.scale) ||
            col.primaryKey !== orig.primaryKey ||
            (col.unique || false) !== (orig.unique || false);
          if (isModified) {
            changes.push({ type: "modify", column: col });
          }
        }
      }
      if (changes.length === 0) return "-- No changes detected";
      return generateAlterTable(editTable.name, editTable.schema, changes, dbType);
    }

    const def: TableDef = {
      name: tableName,
      schema: schema || undefined,
      columns: columns.filter((c) => c.name.trim()),
      comment: tableComment || undefined,
      engine: engine || undefined,
      charset: (dbType === "mysql" ? charset : undefined) || undefined,
      orderBy: (dbType === "clickhouse" ? orderBy : undefined) || undefined,
    };
    return generateCreateTable(def, dbType);
  }, [tableName, schema, tableComment, columns, engine, charset, orderBy, dbType, isEditMode, editTable, originalColumns]);

  // Undo support
  // Column operations
  const addColumn = useCallback(() => {
    setColumns((prev) => [...prev, createDefaultColumn()]);
    setSelectedColumnIndex(columns.length);
  }, [columns.length]);

  const removeColumn = useCallback((index: number) => {
    if (columns.length <= 1) return;
    setColumns((prev) => prev.filter((_, i) => i !== index));
    setSelectedColumnIndex(null);
  }, [columns.length]);

  const updateColumn = useCallback((index: number, updates: Partial<ColumnDef>) => {
    setColumns((prev) =>
      prev.map((col, i) => (i === index ? { ...col, ...updates } : col))
    );
  }, []);

  // Execute SQL
  const handleExecute = useCallback(async () => {
    if (!connId || !sqlPreview) return;
    setIsExecuting(true);
    setMessages([]);
    try {
      await executeSql(connId, sqlPreview);
      setMessages([{ type: "success", text: t("designer.executeSuccess") }]);
      if (isEditMode) {
        setOriginalColumns([...columns]);
      }
    } catch (err) {
      setMessages([{
        type: "error",
        text: t("designer.executeFailed") + ": " + (err instanceof Error ? err.message : (typeof err === 'string' ? err : t("common.unknownError"))),
      }]);
    } finally {
      setIsExecuting(false);
    }
  }, [connId, sqlPreview, isEditMode, columns]);

  // Confirm create table from dialog
  const handleDialogConfirm = useCallback(async () => {
    if (!connId) return;
    const name = dialogTableName.trim();
    if (!name) {
      setMessages([{ type: "error", text: t("designer.tableNameRequired") }]);
      return;
    }
    setIsExecuting(true);
    setMessages([]);
    try {
      const def: TableDef = {
        name,
        schema: schema || undefined,
        columns: columns.filter((c) => c.name.trim()),
        comment: tableComment || undefined,
        engine: engine || undefined,
        charset: (dbType === "mysql" ? charset : undefined) || undefined,
        orderBy: (dbType === "clickhouse" ? orderBy : undefined) || undefined,
      };
      const sql = generateCreateTable(def, dbType);
      await executeSql(connId, sql);
      setTableName(name);
      setShowTableNameDialog(false);
      setMessages([{ type: "success", text: t("designer.executeSuccess") }]);
    } catch (err) {
      setMessages([{
        type: "error",
        text: t("designer.executeFailed") + ": " + (err instanceof Error ? err.message : (typeof err === 'string' ? err : t("common.unknownError"))),
      }]);
    } finally {
      setIsExecuting(false);
    }
  }, [connId, dialogTableName, schema, columns, tableComment, engine, charset, orderBy, dbType]);

  // Save as snippet
  const handleSaveAsSnippet = useCallback(() => {
    if (!sqlPreview) return;
    addTab({
      title: t("designer.snippetTitle", { table: tableName || "table" }),
      type: "query",
      content: sqlPreview,
      connectionId: connId || undefined,
    });
  }, [sqlPreview, tableName, connId, addTab]);

  // Copy SQL
  const handleCopy = useCallback(() => {
    if (!sqlPreview) return;
    navigator.clipboard.writeText(sqlPreview).then(() => {
      setMessages([{ type: "success", text: t("designer.copied") }]);
    });
  }, [sqlPreview]);

  // All data types for current db
  const allTypes = useMemo(() => DATA_TYPES[dbType] || [], [dbType]);

  const typeInfoForColumn = useCallback(
    (col: ColumnDef) => getDataTypeInfo(dbType, col.dataType),
    [dbType]
  );

  // Designer tab definitions
  const designerTabs: { key: DesignerTab; label: string }[] = [
    { key: 'fields', label: t('designer.fields') },
    { key: 'indexes', label: t('designer.indexes') },
    { key: 'foreignKeys', label: t('designer.foreignKeys') },
    { key: 'triggers', label: t('designer.triggers') },
    { key: 'checks', label: t('designer.checks') },
    { key: 'options', label: t('designer.options') },
    { key: 'comment', label: t('designer.comment') },
    { key: 'sqlPreview', label: t('designer.sqlPreview') },
  ];

  // Render
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 gap-2">
        <div className="flex items-center gap-1">
          {/* Save/Execute */}
          <button
            onClick={handleExecute}
            disabled={!sqlPreview || !connId || isExecuting}
            className="flex items-center gap-1 px-2 py-1 text-xs text-green-600 hover:bg-green-500/10 rounded transition-colors disabled:opacity-30"
            title={t('designer.save')}
          >
            {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          </button>
          {/* Add Column */}
          <button
            onClick={addColumn}
            className="flex items-center gap-1 px-2 py-1 text-xs text-green-600 hover:bg-green-500/10 rounded transition-colors"
            title={t('designer.addColumn')}
          >
            <Plus size={14} />
          </button>
          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={!isEditMode}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded transition-colors disabled:opacity-30"
            title={t('designer.refresh')}
          >
            <RefreshCw size={14} />
          </button>
          {/* Delete Column */}
          <button
            onClick={() => selectedColumnIndex !== null && removeColumn(selectedColumnIndex)}
            disabled={selectedColumnIndex === null || columns.length <= 1}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 rounded transition-colors disabled:opacity-30"
            title={t('designer.deleteColumn')}
          >
            <Minus size={14} />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Table Name */}
          <input
            type="text"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder={t("designer.tableNamePlaceholder")}
            className="px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground w-[180px]"
            readOnly={isEditMode}
          />

          {connection && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {connection.name}
            </span>
          )}
        </div>

        {/* Messages */}
        <div className="flex items-center gap-2">
          {messages.map((msg, i) => (
            <span
              key={i}
              className={`text-[11px] flex items-center gap-1 ${
                msg.type === "error" ? "text-destructive" : "text-green-500"
              }`}
            >
              {msg.type === "error" ? <X size={10} /> : <Check size={10} />}
              {msg.text}
            </span>
          ))}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center px-3 border-b border-border shrink-0 gap-1">
        {designerTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveDesignerTab(tab.key)}
            className={`px-3 py-1.5 text-xs transition-colors rounded-t ${
              activeDesignerTab === tab.key
                ? "text-white"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            style={activeDesignerTab === tab.key ? { backgroundColor: 'hsl(var(--tab-active))' } : undefined}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeDesignerTab === 'fields' && (
          <FieldsPanel
            columns={columns}
            selectedColumnIndex={selectedColumnIndex}
            setSelectedColumnIndex={setSelectedColumnIndex}
            updateColumn={updateColumn}
            allTypes={allTypes}
            dbType={dbType}
            typeInfoForColumn={typeInfoForColumn}
          />
        )}

        {activeDesignerTab === 'indexes' && (
          <IndexesPanel indexes={indexes} isEditMode={isEditMode} />
        )}

        {activeDesignerTab === 'foreignKeys' && (
          <ForeignKeysPanel foreignKeys={foreignKeys} isEditMode={isEditMode} />
        )}

        {activeDesignerTab === 'triggers' && (
          <PlaceholderPanel text={t('designer.comingSoon') + ' - ' + t('designer.triggers')} />
        )}

        {activeDesignerTab === 'checks' && (
          <PlaceholderPanel text={t('designer.comingSoon') + ' - ' + t('designer.checks')} />
        )}

        {activeDesignerTab === 'options' && (
          <OptionsPanel
            dbType={dbType}
            schemas={schemas}
            schema={schema}
            setSchema={setSchema}
            engine={engine}
            setEngine={setEngine}
            charset={charset}
            setCharset={setCharset}
            orderBy={orderBy}
            setOrderBy={setOrderBy}
            selectedColumnIndex={selectedColumnIndex}
            columns={columns}
            updateColumn={updateColumn}
          />
        )}

        {activeDesignerTab === 'comment' && (
          <CommentPanel tableComment={tableComment} setTableComment={setTableComment} />
        )}

        {activeDesignerTab === 'sqlPreview' && (
          <SqlPreviewPanel
            sqlPreview={sqlPreview}
            handleCopy={handleCopy}
            handleSaveAsSnippet={handleSaveAsSnippet}
          />
        )}
      </div>

      {/* Table Name Dialog (for create mode) */}
      {showTableNameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowTableNameDialog(false)} />
          <div className="relative bg-background border border-border rounded-lg shadow-xl p-5 w-[340px]">
            <h3 className="text-sm font-medium text-foreground mb-4">{t('designer.tableNameDialogTitle')}</h3>
            <div className="flex items-center gap-3 mb-5">
              <label className="text-xs text-foreground shrink-0">{t('designer.tableNameLabel')}</label>
              <input
                type="text"
                autoFocus
                value={dialogTableName}
                onChange={(e) => setDialogTableName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleDialogConfirm();
                  if (e.key === 'Escape') setShowTableNameDialog(false);
                }}
                placeholder={t('designer.tableNamePlaceholder')}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowTableNameDialog(false)}
                className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDialogConfirm}
                disabled={isExecuting}
                className="px-4 py-1.5 text-xs text-white rounded transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'hsl(var(--tab-active))' }}
              >
                {isExecuting ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Fields Panel ============
interface FieldsPanelProps {
  columns: ColumnDef[];
  selectedColumnIndex: number | null;
  setSelectedColumnIndex: (index: number | null) => void;
  updateColumn: (index: number, updates: Partial<ColumnDef>) => void;
  allTypes: DataType[];
  dbType: string;
  typeInfoForColumn: (col: ColumnDef) => DataType | undefined;
}

function FieldsPanel({ columns, selectedColumnIndex, setSelectedColumnIndex, updateColumn, allTypes, dbType, typeInfoForColumn }: FieldsPanelProps) {
  return (
    <table className="w-full text-xs border-collapse">
      <thead className="sticky top-0 z-10">
        <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
          <th className="px-2 py-1.5 text-left font-medium border border-white/30 min-w-[140px] text-white">
            {t("designer.colName")}
          </th>
          <th className="px-2 py-1.5 text-left font-medium border border-white/30 min-w-[130px] text-white">
            {t("designer.colType")}
          </th>
          <th className="px-2 py-1.5 text-left font-medium border border-white/30 w-[70px] text-white">
            {t("designer.colLength")}
          </th>
          <th className="px-2 py-1.5 text-left font-medium border border-white/30 w-[70px] text-white">
            {t("designer.colScale")}
          </th>
          <th className="px-2 py-1.5 text-center font-medium border border-white/30 w-[70px] text-white">
            {t("designer.notNull")}
          </th>
          <th className="px-2 py-1.5 text-center font-medium border border-white/30 w-[50px] text-white">
            {t("designer.virtual")}
          </th>
          <th className="px-2 py-1.5 text-center font-medium border border-white/30 w-[40px] text-white">
            {t("designer.key")}
          </th>
          <th className="px-2 py-1.5 text-left font-medium border border-white/30 min-w-[100px] text-white">
            {t("designer.colComment")}
          </th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col, index) => {
          const info = typeInfoForColumn(col);
          const isSelected = selectedColumnIndex === index;
          return (
            <tr
              key={index}
              onClick={() => setSelectedColumnIndex(index)}
              className={`border-b transition-colors cursor-pointer ${
                isSelected ? "bg-[hsl(var(--tab-active))]/10" : "hover:bg-muted/30"
              }`}
            >
              {/* Name */}
              <td className="px-1 py-0.5 border-r">
                <input
                  type="text"
                  value={col.name}
                  onChange={(e) => updateColumn(index, { name: e.target.value })}
                  placeholder="column_name"
                  className="w-full px-1.5 py-0.5 text-xs bg-transparent border border-transparent hover:border-border focus:border-[hsl(var(--tab-active))] rounded outline-none text-foreground"
                />
              </td>

              {/* Type */}
              <td className="px-1 py-0.5 border-r">
                <select
                  value={col.dataType}
                  onChange={(e) => {
                    const newType = e.target.value;
                    const newInfo = getDataTypeInfo(dbType, newType);
                    updateColumn(index, {
                      dataType: newType,
                      length: newInfo?.hasLength ? (col.length || 255) : undefined,
                      precision: newInfo?.hasPrecision ? col.precision : undefined,
                      scale: newInfo?.hasScale ? col.scale : undefined,
                    });
                  }}
                  className="w-full px-1.5 py-0.5 text-xs bg-transparent border border-transparent hover:border-border focus:border-[hsl(var(--tab-active))] rounded outline-none text-foreground"
                >
                  {!allTypes.some((dt) => dt.name.toLowerCase() === col.dataType.toLowerCase()) && col.dataType && (
                    <option value={col.dataType}>{col.dataType}</option>
                  )}
                  {allTypes.map((dt) => (
                    <option key={dt.name} value={dt.name}>{dt.name}</option>
                  ))}
                </select>
              </td>

              {/* Length */}
              <td className="px-1 py-0.5 border-r">
                {(info?.hasLength || info?.hasPrecision) ? (
                  <input
                    type="number"
                    value={info?.hasLength ? (col.length || "") : (col.precision ?? "")}
                    onChange={(e) => {
                      const val = e.target.value ? Number(e.target.value) : undefined;
                      if (info?.hasLength) {
                        updateColumn(index, { length: val });
                      } else {
                        updateColumn(index, { precision: val });
                      }
                    }}
                    placeholder={info?.hasLength ? "255" : "10"}
                    className="w-full px-1.5 py-0.5 text-xs bg-transparent border border-transparent hover:border-border focus:border-[hsl(var(--tab-active))] rounded outline-none text-foreground"
                  />
                ) : null}
              </td>

              {/* Scale (Decimal) */}
              <td className="px-1 py-0.5 border-r">
                {info?.hasScale ? (
                  <input
                    type="number"
                    value={col.scale ?? ""}
                    onChange={(e) =>
                      updateColumn(index, { scale: e.target.value ? Number(e.target.value) : undefined })
                    }
                    placeholder="2"
                    className="w-full px-1.5 py-0.5 text-xs bg-transparent border border-transparent hover:border-border focus:border-[hsl(var(--tab-active))] rounded outline-none text-foreground"
                  />
                ) : null}
              </td>

              {/* Not Null */}
              <td className="px-1 py-0.5 text-center border-r">
                <input
                  type="checkbox"
                  checked={!col.nullable}
                  onChange={(e) => updateColumn(index, { nullable: !e.target.checked })}
                  className="w-3.5 h-3.5 accent-[hsl(var(--tab-active))]"
                />
              </td>

              {/* Virtual */}
              <td className="px-1 py-0.5 text-center border-r">
                <input
                  type="checkbox"
                  checked={false}
                  disabled
                  className="w-3.5 h-3.5 opacity-30"
                />
              </td>

              {/* Key */}
              <td className="px-1 py-0.5 text-center border-r">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateColumn(index, { primaryKey: !col.primaryKey, nullable: col.primaryKey ? col.nullable : false });
                  }}
                  className="p-0.5 rounded transition-colors hover:bg-muted"
                  title={t("designer.primaryKey")}
                >
                  {col.primaryKey ? (
                    <KeyRound size={14} className="text-yellow-500" />
                  ) : (
                    <KeyRound size={14} className="text-muted-foreground/20" />
                  )}
                </button>
              </td>

              {/* Comment */}
              <td className="px-1 py-0.5">
                <input
                  type="text"
                  value={col.comment || ""}
                  onChange={(e) => updateColumn(index, { comment: e.target.value })}
                  placeholder=""
                  className="w-full px-1.5 py-0.5 text-xs bg-transparent border border-transparent hover:border-border focus:border-[hsl(var(--tab-active))] rounded outline-none text-foreground"
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============ Indexes Panel ============
function IndexesPanel({ indexes, isEditMode }: { indexes: any[]; isEditMode: boolean }) {
  if (!isEditMode) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground py-12">
        {t('designer.saveFirst')}
      </div>
    );
  }

  if (indexes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground py-12">
        {t('designer.noIndexes')}
      </div>
    );
  }

  return (
    <table className="w-full text-xs border-collapse">
      <thead className="sticky top-0 z-10">
        <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.indexName')}</th>
          <th className="px-3 py-1.5 text-center font-medium border border-white/30 w-[60px] text-white">{t('designer.isUnique')}</th>
          <th className="px-3 py-1.5 text-center font-medium border border-white/30 w-[60px] text-white">{t('designer.isPrimary')}</th>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.indexColumns')}</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((idx, i) => {
          // Normalize fields across PG/MySQL
          const name = idx.index_name || idx.Key_name || idx.name || '';
          const isUnique = idx.is_unique != null ? idx.is_unique : (idx.Non_unique === 0);
          const isPrimary = idx.is_primary != null ? idx.is_primary : (name === 'PRIMARY');
          const cols = idx.column_names || idx.Column_name || idx.columns || '';
          return (
            <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
              <td className="px-3 py-1.5 text-foreground font-mono border-r">{name}</td>
              <td className="px-3 py-1.5 text-center border-r">{isUnique ? <Check size={12} className="inline text-green-500" /> : ''}</td>
              <td className="px-3 py-1.5 text-center border-r">{isPrimary ? <KeyRound size={12} className="inline text-yellow-500" /> : ''}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{typeof cols === 'string' ? cols : JSON.stringify(cols)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============ Foreign Keys Panel ============
function ForeignKeysPanel({ foreignKeys, isEditMode }: { foreignKeys: any[]; isEditMode: boolean }) {
  if (!isEditMode) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground py-12">
        {t('designer.saveFirst')}
      </div>
    );
  }

  if (foreignKeys.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground py-12">
        {t('designer.noForeignKeys')}
      </div>
    );
  }

  return (
    <table className="w-full text-xs border-collapse">
      <thead className="sticky top-0 z-10">
        <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.constraintName')}</th>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.columnName')}</th>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.referencedTable')}</th>
          <th className="px-3 py-1.5 text-left font-medium border border-white/30 text-white">{t('designer.referencedColumn')}</th>
        </tr>
      </thead>
      <tbody>
        {foreignKeys.map((fk, i) => {
          const name = fk.constraint_name || fk.CONSTRAINT_NAME || '';
          const col = fk.column_name || fk.COLUMN_NAME || '';
          const refTable = fk.foreign_table_name || fk.REFERENCED_TABLE_NAME || '';
          const refCol = fk.foreign_column_name || fk.REFERENCED_COLUMN_NAME || '';
          return (
            <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
              <td className="px-3 py-1.5 text-foreground font-mono border-r">{name}</td>
              <td className="px-3 py-1.5 text-foreground border-r">{col}</td>
              <td className="px-3 py-1.5 text-foreground border-r">{refTable}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{refCol}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============ Options Panel ============
interface OptionsPanelProps {
  dbType: string;
  schemas: string[];
  schema: string;
  setSchema: (v: string) => void;
  engine: string;
  setEngine: (v: string) => void;
  charset: string;
  setCharset: (v: string) => void;
  orderBy: string;
  setOrderBy: (v: string) => void;
  selectedColumnIndex: number | null;
  columns: ColumnDef[];
  updateColumn: (index: number, updates: Partial<ColumnDef>) => void;
}

function OptionsPanel({ dbType, schemas, schema, setSchema, engine, setEngine, charset, setCharset, orderBy, setOrderBy, selectedColumnIndex, columns, updateColumn }: OptionsPanelProps) {
  const selectedCol = selectedColumnIndex !== null ? columns[selectedColumnIndex] : null;
  const inputClass = "px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground";

  return (
    <div className="p-4 space-y-4 max-w-lg">
      {/* Schema */}
      {schemas.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground w-20 shrink-0">{t("designer.schema")}</label>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className={inputClass}>
            <option value="">--</option>
            {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}

      {/* MySQL options */}
      {dbType === "mysql" && (
        <>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">ENGINE</label>
            <select value={engine} onChange={(e) => setEngine(e.target.value)} className={inputClass}>
              <option value="">InnoDB</option>
              <option value="MyISAM">MyISAM</option>
              <option value="MEMORY">MEMORY</option>
              <option value="CSV">CSV</option>
              <option value="ARCHIVE">ARCHIVE</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">CHARSET</label>
            <select value={charset} onChange={(e) => setCharset(e.target.value)} className={inputClass}>
              <option value="utf8mb4">utf8mb4</option>
              <option value="utf8">utf8</option>
              <option value="latin1">latin1</option>
              <option value="ascii">ascii</option>
            </select>
          </div>
        </>
      )}

      {/* ClickHouse options */}
      {dbType === "clickhouse" && (
        <>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">ENGINE</label>
            <select value={engine} onChange={(e) => setEngine(e.target.value)} className={inputClass}>
              <option value="">MergeTree()</option>
              <option value="ReplacingMergeTree()">ReplacingMergeTree()</option>
              <option value="SummingMergeTree()">SummingMergeTree()</option>
              <option value="AggregatingMergeTree()">AggregatingMergeTree()</option>
              <option value="CollapsingMergeTree()">CollapsingMergeTree()</option>
              <option value="TinyLog">TinyLog</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">ORDER BY</label>
            <input
              type="text"
              value={orderBy}
              onChange={(e) => setOrderBy(e.target.value)}
              placeholder="column_name"
              className={`${inputClass} flex-1`}
            />
          </div>
        </>
      )}

      {/* Selected column extra options */}
      {selectedCol && selectedColumnIndex !== null && (
        <>
          <div className="border-t border-border pt-4 mt-4">
            <span className="text-xs font-medium text-foreground">
              {t('designer.columns')}: {selectedCol.name || `#${selectedColumnIndex + 1}`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">{t('designer.colDefault')}</label>
            <input
              type="text"
              value={selectedCol.defaultValue || ""}
              onChange={(e) => updateColumn(selectedColumnIndex, { defaultValue: e.target.value })}
              placeholder="NULL"
              className={`${inputClass} flex-1`}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">{t('designer.unique')}</label>
            <input
              type="checkbox"
              checked={selectedCol.unique || false}
              onChange={(e) => updateColumn(selectedColumnIndex, { unique: e.target.checked })}
              className="w-3.5 h-3.5 accent-[hsl(var(--tab-active))]"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-20 shrink-0">{t('designer.autoIncrement')}</label>
            <input
              type="checkbox"
              checked={selectedCol.autoIncrement}
              onChange={(e) => updateColumn(selectedColumnIndex, { autoIncrement: e.target.checked })}
              className="w-3.5 h-3.5 accent-[hsl(var(--tab-active))]"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ============ Comment Panel ============
function CommentPanel({ tableComment, setTableComment }: { tableComment: string; setTableComment: (v: string) => void }) {
  return (
    <div className="p-4">
      <textarea
        value={tableComment}
        onChange={(e) => setTableComment(e.target.value)}
        placeholder={t("designer.commentPlaceholder")}
        className="w-full h-40 px-3 py-2 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground resize-y font-mono"
      />
    </div>
  );
}

// ============ SQL Preview Panel ============
function SqlPreviewPanel({ sqlPreview, handleCopy, handleSaveAsSnippet }: { sqlPreview: string; handleCopy: () => void; handleSaveAsSnippet: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-3">
        {sqlPreview ? (
          <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all leading-relaxed">
            {sqlPreview}
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {t("designer.startDesigning")}
          </div>
        )}
      </div>
      {sqlPreview && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border shrink-0">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            <Copy size={11} />
            {t("common.copy")}
          </button>
          <button
            onClick={handleSaveAsSnippet}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            <FileCode size={11} />
            {t("designer.saveSnippet")}
          </button>
        </div>
      )}
    </div>
  );
}

// ============ Placeholder Panel ============
function PlaceholderPanel({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-muted-foreground py-12">
      {text}
    </div>
  );
}

export default TableDesigner;
