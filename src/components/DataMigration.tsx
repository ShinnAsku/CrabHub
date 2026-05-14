import { useState, useCallback, useRef, useEffect } from "react";
import {
  X,
  ArrowRight,
  ChevronRight,
  ChevronLeft,
  Play,
  Square,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Database,
  Table2,
  Settings2,
  Eye,
  RefreshCw,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import {
  loadSourceTables,
  getTableRowCount,
  generateAllDDL,
  migrateData,
  type MigrationConfig,
  type MigrationProgress,
  type TableMigrationInfo,
} from "@/lib/migration";
import { getSchemas } from "@/lib/tauri-commands";

// ===== Step type =====
type Step = 1 | 2 | 3 | 4;

// ===== Props =====
interface DataMigrationProps {
  isOpen: boolean;
  onClose: () => void;
}

// ===== Component =====
function DataMigration({ isOpen, onClose }: DataMigrationProps) {
  const { connections } = useAppStore();

  // Step state
  const [step, setStep] = useState<Step>(1);

  // Step 1: Source & Target
  const [sourceConnectionId, setSourceConnectionId] = useState<string>("");
  const [targetConnectionId, setTargetConnectionId] = useState<string>("");
  const [sourceSchema, setSourceSchema] = useState<string>("");
  const [targetSchema, setTargetSchema] = useState<string>("");
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([]);
  const [targetSchemas, setTargetSchemas] = useState<string[]>([]);

  // Step 2: Tables
  const [tables, setTables] = useState<TableMigrationInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingRowCounts, setLoadingRowCounts] = useState(false);

  // Step 3: Options
  const [mode, setMode] = useState<'structure' | 'data' | 'both'>('both');
  const [dropExisting, setDropExisting] = useState(false);
  const [batchSize, setBatchSize] = useState(1000);
  const [stopOnError, setStopOnError] = useState(true);

  // Step 4: Preview & Execute
  const [ddlPreview, setDdlPreview] = useState<Map<string, string>>(new Map());
  const [ddlWarnings, setDdlWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationDone, setMigrationDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state on open/close
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setSourceConnectionId("");
      setTargetConnectionId("");
      setSourceSchema("");
      setTargetSchema("");
      setSourceSchemas([]);
      setTargetSchemas([]);
      setTables([]);
      setMode("both");
      setDropExisting(false);
      setBatchSize(1000);
      setStopOnError(true);
      setDdlPreview(new Map());
      setDdlWarnings([]);
      setProgress(null);
      setIsMigrating(false);
      setMigrationDone(false);
      abortRef.current = null;
    }
  }, [isOpen]);

  // Load schemas when connection changes
  const loadSchemasForConnection = useCallback(async (connId: string, target: 'source' | 'target') => {
    if (!connId) return;
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;

    // Only load schemas for databases that support them
    if (['postgresql', 'gaussdb', 'opengauss', 'mssql'].includes(conn.type)) {
      try {
        const schemas = await getSchemas(connId);
        if (target === 'source') {
          setSourceSchemas(schemas);
          setSourceSchema(schemas[0] ?? '');
        } else {
          setTargetSchemas(schemas);
          setTargetSchema(schemas[0] ?? '');
        }
      } catch {
        // Ignore schema loading errors
      }
    } else {
      if (target === 'source') {
        setSourceSchemas([]);
        setSourceSchema('');
      } else {
        setTargetSchemas([]);
        setTargetSchema('');
      }
    }
  }, [connections]);

  // Load schemas when source connection changes
  useEffect(() => {
    if (sourceConnectionId) {
      loadSchemasForConnection(sourceConnectionId, 'source');
    }
  }, [sourceConnectionId, loadSchemasForConnection]);

  // Load schemas when target connection changes
  useEffect(() => {
    if (targetConnectionId) {
      loadSchemasForConnection(targetConnectionId, 'target');
    }
  }, [targetConnectionId, loadSchemasForConnection]);

  // Load tables
  const handleLoadTables = useCallback(async () => {
    if (!sourceConnectionId) return;
    setLoadingTables(true);
    try {
      const loaded = await loadSourceTables(sourceConnectionId, sourceSchema || undefined);
      setTables(loaded);
    } catch (err) {
      setTables([]);
    }
    setLoadingTables(false);
  }, [sourceConnectionId, sourceSchema]);

  // Load row counts
  const handleLoadRowCounts = useCallback(async () => {
    const sourceConn = connections.find((c) => c.id === sourceConnectionId);
    if (!sourceConn) return;
    setLoadingRowCounts(true);
    const updated = await Promise.all(
      tables.map(async (tbl) => {
        const count = await getTableRowCount(
          sourceConnectionId,
          tbl.name,
          tbl.schema,
          sourceConn.type
        );
        return { ...tbl, rowCount: count };
      })
    );
    setTables(updated);
    setLoadingRowCounts(false);
  }, [tables, sourceConnectionId, sourceSchema, connections]);

  // Select / Deselect all
  const handleSelectAll = useCallback(() => {
    setTables((prev) => prev.map((t) => ({ ...t, selected: true })));
  }, []);

  const handleDeselectAll = useCallback(() => {
    setTables((prev) => prev.map((t) => ({ ...t, selected: false })));
  }, []);

  const handleToggleTable = useCallback((name: string) => {
    setTables((prev) =>
      prev.map((t) => (t.name === name ? { ...t, selected: !t.selected } : t))
    );
  }, []);

  // Generate DDL preview
  const handleGeneratePreview = useCallback(async () => {
    const sourceConn = connections.find((c) => c.id === sourceConnectionId);
    const targetConn = connections.find((c) => c.id === targetConnectionId);
    if (!sourceConn || !targetConn) return;

    const selectedTables = tables.filter((t) => t.selected);
    const config: MigrationConfig = {
      sourceConnectionId,
      targetConnectionId,
      sourceSchema: sourceSchema || undefined,
      targetSchema: targetSchema || undefined,
      tables: selectedTables.map((t) => t.name),
      mode,
      dropExisting,
      batchSize,
      stopOnError,
    };

    try {
      const { ddls, warnings } = await generateAllDDL(config, sourceConn, targetConn, selectedTables);
      setDdlPreview(ddls);
      setDdlWarnings(warnings);
    } catch (err) {
      setDdlPreview(new Map());
      setDdlWarnings([String(err)]);
    }
  }, [connections, sourceConnectionId, targetConnectionId, sourceSchema, targetSchema, tables, mode, dropExisting, batchSize, stopOnError]);

  // Run migration
  const handleStartMigration = useCallback(async () => {
    const sourceConn = connections.find((c) => c.id === sourceConnectionId);
    const targetConn = connections.find((c) => c.id === targetConnectionId);
    if (!sourceConn || !targetConn) return;

    const selectedTables = tables.filter((t) => t.selected);
    const config: MigrationConfig = {
      sourceConnectionId,
      targetConnectionId,
      sourceSchema: sourceSchema || undefined,
      targetSchema: targetSchema || undefined,
      tables: selectedTables.map((t) => t.name),
      mode,
      dropExisting,
      batchSize,
      stopOnError,
    };

    setIsMigrating(true);
    setMigrationDone(false);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      await migrateData(config, sourceConn, targetConn, setProgress, abortController.signal);
    } catch {
      // Error handled in progress
    }

    setIsMigrating(false);
    setMigrationDone(true);
  }, [connections, sourceConnectionId, targetConnectionId, sourceSchema, targetSchema, tables, mode, dropExisting, batchSize, stopOnError]);

  // Cancel migration
  const handleCancelMigration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Can go next?
  const canGoNext = (): boolean => {
    switch (step) {
      case 1:
        return sourceConnectionId !== '' && targetConnectionId !== '' && sourceConnectionId !== targetConnectionId;
      case 2:
        return tables.some((t) => t.selected);
      case 3:
        return true;
      case 4:
        return false;
    }
  };

  // Go next
  const handleNext = useCallback(() => {
    if (step === 2) {
      // Generate preview when entering step 4
      // We'll do it lazily in step 4
    }
    if (step < 4) {
      setStep((step + 1) as Step);
    }
  }, [step]);

  // Go back
  const handleBack = useCallback(() => {
    if (step > 1) {
      setStep((step - 1) as Step);
    }
  }, [step]);

  // Auto-generate preview when entering step 4
  useEffect(() => {
    if (step === 4 && ddlPreview.size === 0 && !isMigrating && !migrationDone) {
      handleGeneratePreview();
    }
  }, [step, ddlPreview.size, isMigrating, migrationDone, handleGeneratePreview]);

  if (!isOpen) return null;

  const sourceConn = connections.find((c) => c.id === sourceConnectionId);
  const targetConn = connections.find((c) => c.id === targetConnectionId);
  const selectedTables = tables.filter((t) => t.selected);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[800px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-foreground" />
            <span className="text-sm font-semibold text-foreground">
              {t('migration.title')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 bg-muted/30">
          {[
            { num: 1, icon: Database, label: t('migration.step1') },
            { num: 2, icon: Table2, label: t('migration.step2') },
            { num: 3, icon: Settings2, label: t('migration.step3') },
            { num: 4, icon: Eye, label: t('migration.step4') },
          ].map((s, idx) => {
            const Icon = s.icon;
            const isActive = step === s.num;
            const isDone = step > s.num;
            return (
              <div key={s.num} className="flex items-center gap-1 flex-1">
                <div
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors ${
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : isDone
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  <Icon size={12} />
                  <span>{s.label}</span>
                  {isDone && <CheckCircle2 size={10} className="text-green-500" />}
                </div>
                {idx < 3 && (
                  <ChevronRight size={12} className="text-muted-foreground mx-0.5" />
                )}
              </div>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Step 1: Source & Target */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {/* Source */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">
                    {t('migration.source')}
                  </label>
                  <select
                    value={sourceConnectionId}
                    onChange={(e) => setSourceConnectionId(e.target.value)}
                    className="w-full h-8 px-2 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="">{t('migration.selectConnection')}</option>
                    {connections
                      .filter((c) => c.connected)
                      .map((c) => (
                        <option key={c.id} value={c.id} disabled={c.id === targetConnectionId}>
                          {c.name} ({c.type})
                        </option>
                      ))}
                  </select>
                  {sourceSchemas.length > 0 && (
                    <select
                      value={sourceSchema}
                      onChange={(e) => setSourceSchema(e.target.value)}
                      className="w-full h-8 px-2 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="">{t('migration.allSchemas')}</option>
                      {sourceSchemas.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Target */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">
                    {t('migration.target')}
                  </label>
                  <select
                    value={targetConnectionId}
                    onChange={(e) => setTargetConnectionId(e.target.value)}
                    className="w-full h-8 px-2 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="">{t('migration.selectConnection')}</option>
                    {connections
                      .filter((c) => c.connected)
                      .map((c) => (
                        <option key={c.id} value={c.id} disabled={c.id === sourceConnectionId}>
                          {c.name} ({c.type})
                        </option>
                      ))}
                  </select>
                  {targetSchemas.length > 0 && (
                    <select
                      value={targetSchema}
                      onChange={(e) => setTargetSchema(e.target.value)}
                      className="w-full h-8 px-2 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="">{t('migration.defaultSchema')}</option>
                      {targetSchemas.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Connection info */}
              {sourceConn && targetConn && (
                <div className="flex items-center gap-2 p-3 bg-muted/50 rounded text-xs text-foreground">
                  <span className="font-medium">{sourceConn.name}</span>
                  <span className="text-muted-foreground">({sourceConn.type})</span>
                  <ArrowRight size={12} className="text-muted-foreground" />
                  <span className="font-medium">{targetConn.name}</span>
                  <span className="text-muted-foreground">({targetConn.type})</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Table Selection */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('migration.tableCount', { count: String(tables.length) })}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleSelectAll}
                    className="px-2 py-1 text-[11px] text-foreground hover:bg-muted rounded transition-colors"
                  >
                    {t('migration.selectAll')}
                  </button>
                  <button
                    onClick={handleDeselectAll}
                    className="px-2 py-1 text-[11px] text-foreground hover:bg-muted rounded transition-colors"
                  >
                    {t('migration.deselectAll')}
                  </button>
                  <button
                    onClick={handleLoadTables}
                    disabled={loadingTables}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-foreground hover:bg-muted rounded transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={10} className={loadingTables ? 'animate-spin' : ''} />
                    {t('migration.refreshTables')}
                  </button>
                  <button
                    onClick={handleLoadRowCounts}
                    disabled={loadingRowCounts}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-foreground hover:bg-muted rounded transition-colors disabled:opacity-50"
                  >
                    {loadingRowCounts ? <Loader2 size={10} className="animate-spin" /> : null}
                    {t('migration.loadRowCounts')}
                  </button>
                </div>
              </div>

              {tables.length === 0 && !loadingTables && (
                <div className="text-center py-8 text-xs text-muted-foreground">
                  {t('migration.noTables')}
                </div>
              )}

              {loadingTables && (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
                  <Loader2 size={12} className="animate-spin" />
                  {t('common.loading')}
                </div>
              )}

              <div className="border border-border rounded overflow-hidden max-h-[350px] overflow-y-auto">
                <table className="w-full text-xs border-collapse border">
                  <thead className="sticky top-0" style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-white border border-white/30 w-8">
                        <input
                          type="checkbox"
                          checked={tables.length > 0 && tables.every((t) => t.selected)}
                          onChange={(e) => {
                            if (e.target.checked) handleSelectAll();
                            else handleDeselectAll();
                          }}
                          className="rounded"
                        />
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-white border border-white/30">
                        {t('migration.tableName')}
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-white border border-white/30">
                        {t('migration.schema')}
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-white border border-white/30">
                        {t('migration.rowCount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((tbl) => (
                      <tr
                        key={tbl.name}
                        className="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors even:bg-muted/40"
                        onClick={() => handleToggleTable(tbl.name)}
                      >
                        <td className="px-3 py-1.5 border">
                          <input
                            type="checkbox"
                            checked={tbl.selected}
                            onChange={() => handleToggleTable(tbl.name)}
                            className="rounded"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-foreground border">{tbl.name}</td>
                        <td className="px-3 py-1.5 text-muted-foreground border">{tbl.schema || '-'}</td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground border">
                          {tbl.rowCount !== undefined ? tbl.rowCount.toLocaleString() : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="text-xs text-muted-foreground">
                {t('migration.selectedCount', { count: String(selectedTables.length) })}
              </div>
            </div>
          )}

          {/* Step 3: Migration Options */}
          {step === 3 && (
            <div className="space-y-4">
              {/* Mode selection */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground">
                  {t('migration.migrationMode')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'structure' as const, label: t('migration.structureOnly') },
                    { value: 'data' as const, label: t('migration.dataOnly') },
                    { value: 'both' as const, label: t('migration.structureAndData') },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setMode(opt.value)}
                      className={`px-3 py-2 text-xs rounded border transition-colors ${
                        mode === opt.value
                          ? 'border-accent bg-accent/10 text-accent-foreground'
                          : 'border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Drop existing */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="drop-existing"
                  checked={dropExisting}
                  onChange={(e) => setDropExisting(e.target.checked)}
                  className="rounded"
                />
                <label htmlFor="drop-existing" className="text-xs text-foreground flex items-center gap-1">
                  {t('migration.dropExisting')}
                  {dropExisting && (
                    <AlertTriangle size={12} className="text-yellow-500" />
                  )}
                </label>
              </div>

              {/* Batch size */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  {t('migration.batchSize')}
                </label>
                <input
                  type="number"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                  min={1}
                  max={100000}
                  className="w-32 h-8 px-2 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {/* Stop on error */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="stop-on-error"
                  checked={stopOnError}
                  onChange={(e) => setStopOnError(e.target.checked)}
                  className="rounded"
                />
                <label htmlFor="stop-on-error" className="text-xs text-foreground">
                  {t('migration.stopOnError')}
                </label>
              </div>

              {/* Summary */}
              <div className="p-3 bg-muted/50 rounded text-xs space-y-1">
                <div className="font-medium text-foreground">{t('migration.summary')}</div>
                <div className="text-muted-foreground">
                  {sourceConn?.name} ({sourceConn?.type}) {t('migration.to')} {targetConn?.name} ({targetConn?.type})
                </div>
                <div className="text-muted-foreground">
                  {t('migration.tablesToMigrate')}: {selectedTables.length}
                </div>
                <div className="text-muted-foreground">
                  {t('migration.mode')}: {mode === 'structure' ? t('migration.structureOnly') : mode === 'data' ? t('migration.dataOnly') : t('migration.structureAndData')}
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Preview & Execute */}
          {step === 4 && (
            <div className="space-y-3">
              {/* DDL Preview */}
              {!isMigrating && !migrationDone && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      {t('migration.ddlPreview')}
                    </span>
                    <button
                      onClick={handleGeneratePreview}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] text-foreground hover:bg-muted rounded transition-colors"
                    >
                      <RefreshCw size={10} />
                      {t('migration.regenerate')}
                    </button>
                  </div>

                  {ddlWarnings.length > 0 && (
                    <div className="p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-600 dark:text-yellow-400 space-y-0.5">
                      {ddlWarnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-1">
                          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="border border-border rounded overflow-hidden max-h-[200px] overflow-y-auto">
                    <pre className="p-3 text-[11px] font-mono text-foreground bg-muted/30 whitespace-pre-wrap">
                      {ddlPreview.size > 0
                        ? Array.from(ddlPreview.entries())
                            .map(([name, ddl]) => `-- Table: ${name}\n${ddl}`)
                            .join('\n\n')
                        : t('migration.noDdlPreview')}
                    </pre>
                  </div>
                </div>
              )}

              {/* Progress */}
              {(isMigrating || migrationDone) && progress && (
                <div className="space-y-3">
                  {/* Progress bar */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-foreground">
                        {progress.currentTable
                          ? `${t('migration.migratingTable')}: ${progress.currentTable}`
                          : migrationDone
                          ? t('migration.completed')
                          : t('migration.preparing')}
                      </span>
                      <span className="text-muted-foreground">
                        {progress.tablesCompleted}/{progress.totalTables} {t('migration.tables')}
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-300"
                        style={{
                          width: progress.totalTables > 0
                            ? `${(progress.tablesCompleted / progress.totalTables) * 100}%`
                            : '0%',
                        }}
                      />
                    </div>
                    {progress.currentStep === 'copying' && progress.totalRows > 0 && (
                      <div className="text-[11px] text-muted-foreground">
                        {t('migration.rowsProgress', {
                          copied: String(progress.rowsCopied),
                          total: String(progress.totalRows),
                        })}
                      </div>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-4 gap-2">
                    <div className="p-2 bg-muted/50 rounded text-center">
                      <div className="text-[11px] text-muted-foreground">{t('migration.tables')}</div>
                      <div className="text-sm font-semibold text-foreground">{progress.tablesCompleted}/{progress.totalTables}</div>
                    </div>
                    <div className="p-2 bg-muted/50 rounded text-center">
                      <div className="text-[11px] text-muted-foreground">{t('migration.rows')}</div>
                      <div className="text-sm font-semibold text-foreground">{progress.rowsCopied.toLocaleString()}</div>
                    </div>
                    <div className="p-2 bg-muted/50 rounded text-center">
                      <div className="text-[11px] text-muted-foreground">{t('migration.errors')}</div>
                      <div className={`text-sm font-semibold ${progress.errors.length > 0 ? 'text-red-500' : 'text-green-500'}`}>
                        {progress.errors.length}
                      </div>
                    </div>
                    <div className="p-2 bg-muted/50 rounded text-center">
                      <div className="text-[11px] text-muted-foreground">{t('migration.elapsed')}</div>
                      <div className="text-sm font-semibold text-foreground">
                        {((Date.now() - progress.startTime) / 1000).toFixed(1)}s
                      </div>
                    </div>
                  </div>

                  {/* Log */}
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-foreground">{t('migration.log')}</span>
                    <div className="border border-border rounded overflow-hidden max-h-[180px] overflow-y-auto bg-muted/20">
                      <pre className="p-2 text-[11px] font-mono text-foreground whitespace-pre-wrap">
                        {progress.logs.join('\n')}
                      </pre>
                    </div>
                  </div>

                  {/* Errors */}
                  {progress.errors.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-red-500">{t('migration.errorDetails')}</span>
                      <div className="border border-red-500/20 rounded overflow-hidden max-h-[120px] overflow-y-auto bg-red-500/5">
                        <pre className="p-2 text-[11px] font-mono text-red-500 whitespace-pre-wrap">
                          {progress.errors.join('\n')}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <div>
            {step > 1 && !isMigrating && (
              <button
                onClick={handleBack}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded transition-colors"
              >
                <ChevronLeft size={12} />
                {t('migration.back')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {step < 4 && (
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded transition-colors"
              >
                {t('common.cancel')}
              </button>
            )}

            {step < 4 && (
              <button
                onClick={handleNext}
                disabled={!canGoNext()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('migration.next')}
                <ChevronRight size={12} />
              </button>
            )}

            {step === 4 && !isMigrating && !migrationDone && (
              <>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleStartMigration}
                  disabled={selectedTables.length === 0}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50"
                >
                  <Play size={12} />
                  {t('migration.startMigration')}
                </button>
              </>
            )}

            {step === 4 && isMigrating && (
              <button
                onClick={handleCancelMigration}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              >
                <Square size={12} />
                {t('migration.cancelMigration')}
              </button>
            )}

            {step === 4 && migrationDone && (
              <button
                onClick={onClose}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:bg-accent/80 transition-colors"
              >
                {t('common.close')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DataMigration;
