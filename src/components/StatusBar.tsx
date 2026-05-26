import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

function StatusBar() {
  const { connections, activeConnectionId, isExecuting, queryResults, activeTabId, transactionActive, tabs } = useAppStore();
  const activeConn = connections.find(c => c.id === activeConnectionId);
  const result = activeTabId ? queryResults[activeTabId] : null;
  const isTxActive = activeConnectionId ? !!transactionActive[activeConnectionId] : false;
  const activeConnections = connections.filter(c => c.connected);
  // Only check executing state for tabs that still exist (stale entries can persist)
  const isAnyTabExecuting = Object.entries(isExecuting).some(([id, v]) => v && tabs.some(t => t.id === id));

  const typeLabels: Record<string, string> = {
    postgresql: "PostgreSQL",
    mysql: "MySQL",
    sqlite: "SQLite",
    mssql: "SQL Server",
    clickhouse: "ClickHouse",
    gaussdb: "GaussDB",
    kingbase: "Kingbase",
    vastbase: "Vastbase",
    yashandb: "YashanDB",
    oceanbase: "OceanBase",
    tidb: "TiDB",
    tdsql: "TDSQL",
    oracle: "Oracle",
    sqlserver: "SQL Server",
    dameng: "DaMeng",
    gbase: "GBase",
  };

  return (
    <div className="flex items-center justify-between h-5 px-3 bg-muted/50 text-[10px] text-muted-foreground select-none shrink-0">
      {/* Left: Connection status */}
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${activeConn?.connected ? 'bg-success' : 'bg-muted-foreground/40'}`} />
        <span>
          {activeConn
            ? `${activeConn.name} (${typeLabels[activeConn.type] || activeConn.type})`
            : t('status.notConnected')}
        </span>
        {isTxActive && (
          <span className="text-warning text-[10px]">{t('status.transactionActive')}</span>
        )}
        {activeConnections.length > 1 && (
          <span className="text-[10px] text-muted-foreground/70">
            {activeConnections.length} {t('status.connectionsActive')}
          </span>
        )}
      </div>

      {/* Center: Result info */}
      <div className="flex items-center gap-3">
        {isAnyTabExecuting && <span className="text-warning">{t('status.executing')}</span>}
        {result && !isExecuting[activeTabId!] && result.rowCount > 0 && (
          <span>{result.rowCount} {t('status.rows')} | {result.duration.toFixed(0)}ms</span>
        )}
        {result && !isExecuting[activeTabId!] && result.rowCount === 0 && (
          <span>{result.duration.toFixed(0)}ms</span>
        )}
        {!isAnyTabExecuting && !result && <span>{t('status.ready')}</span>}
      </div>

      {/* Right: Database info */}
      <div className="flex items-center gap-2">
        <span>{activeConn?.database || '-'}</span>
      </div>
    </div>
  );
}

export default StatusBar;
