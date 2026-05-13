import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

function StatusBar() {
  const { connections, activeConnectionId, isExecuting, queryResults, activeTabId, transactionActive } = useAppStore();
  const activeConn = connections.find(c => c.id === activeConnectionId);
  const result = activeTabId ? queryResults[activeTabId] : null;
  const isTxActive = activeConnectionId ? !!transactionActive[activeConnectionId] : false;
  const activeConnections = connections.filter(c => c.connected);

  const typeLabels: Record<string, string> = {
    postgresql: "PostgreSQL",
    mysql: "MySQL",
    sqlite: "SQLite",
    mssql: "MSSQL",
    clickhouse: "ClickHouse",
    gaussdb: "GaussDB",
  };

  return (
    <div className="flex items-center justify-between h-6 px-3 border-t border-border bg-muted/30 text-[11px] text-muted-foreground select-none shrink-0">
      {/* Left: Connection status */}
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${activeConn?.connected ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
        <span>
          {activeConn
            ? `${activeConn.name} (${typeLabels[activeConn.type] || activeConn.type})`
            : t('status.notConnected')}
        </span>
        {isTxActive && (
          <span className="text-yellow-500 text-[10px]">{t('status.transactionActive')}</span>
        )}
        {activeConnections.length > 1 && (
          <span className="text-[10px] text-muted-foreground/70">
            {activeConnections.length} {t('status.connectionsActive')}
          </span>
        )}
      </div>

      {/* Center: Result info */}
      <div className="flex items-center gap-3">
        {isExecuting && <span className="text-yellow-500">{t('status.executing')}</span>}
        {result && !isExecuting && result.rowCount > 0 && (
          <span>{result.rowCount} {t('status.rows')} | {result.duration.toFixed(0)}ms</span>
        )}
        {result && !isExecuting && result.rowCount === 0 && (
          <span>{result.duration.toFixed(0)}ms</span>
        )}
        {!result && !isExecuting && <span>{t('status.ready')}</span>}
      </div>

      {/* Right: Database info */}
      <div className="flex items-center gap-2">
        <span>{activeConn?.database || '-'}</span>
      </div>
    </div>
  );
}

export default StatusBar;
