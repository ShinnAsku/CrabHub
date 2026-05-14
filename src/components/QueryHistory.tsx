import { useState } from "react";
import { Clock, Trash2, CheckCircle2, XCircle, Search } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { QueryHistoryEntry } from "@/types";
import { t } from "@/lib/i18n";

function QueryHistory() {
  const { queryHistory, clearQueryHistory, addTab, setActiveTab, tabs, language } = useAppStore();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = searchTerm
    ? queryHistory.filter(
        (h) =>
          h.sql.toLowerCase().includes(searchTerm.toLowerCase()) ||
          h.connectionId.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : queryHistory;

  const handleLoadQuery = (entry: QueryHistoryEntry) => {
    // Check if there's already a tab with this SQL
    const existingTab = tabs.find((t) => t.content?.trim() === entry.sql.trim());
    if (existingTab) {
      setActiveTab(existingTab.id);
      return;
    }
    // Create a new tab with the SQL
    addTab({
      title: entry.sql.split("\n")[0]?.trim().slice(0, 30) || t('history.title'),
      type: "query",
      content: entry.sql,
    });
  };

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    return d.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" }) + " " +
      d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  };

  const truncateSql = (sql: string, maxLen: number = 50) => {
    const firstLine = sql.split("\n")[0]?.trim() || sql;
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen) + "...";
  };

  if (queryHistory.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs px-4 text-center">
        <Clock size={24} className="mb-2 opacity-30" />
        <p>{t('history.noHistory')}</p>
        <p className="text-[10px] mt-1 text-muted-foreground/60">
          {t('history.noHistoryHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-2 py-1.5 border-b border-sidebar-border shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded">
          <Search size={11} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('history.searchPlaceholder')}
            className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      {/* History List */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-1 py-1">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => handleLoadQuery(entry)}
              className="flex flex-col items-start gap-0.5 w-full px-2 py-1.5 text-xs rounded transition-colors hover:bg-muted text-left group"
            >
              <div className="flex items-center gap-1.5 w-full">
                {!entry.error ? (
                  <CheckCircle2 size={10} className="text-success shrink-0" />
                ) : (
                  <XCircle size={10} className="text-destructive shrink-0" />
                )}
                <span className="truncate text-sidebar-foreground flex-1 text-[11px]">
                  {truncateSql(entry.sql)}
                </span>
                <span className="text-[9px] text-muted-foreground/60 shrink-0">
                  {entry.duration.toFixed(0)} ms
                </span>
              </div>
              <div className="flex items-center gap-2 pl-4 text-[9px] text-muted-foreground/60">
                <span>{entry.connectionId}</span>
                <span>{formatTime(new Date(entry.timestamp).getTime())}</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && searchTerm && (
            <div className="px-2 py-3 text-[10px] text-muted-foreground text-center">
              {t('history.noResults')}
            </div>
          )}
        </div>
      </div>

      {/* Clear button */}
      <div className="border-t border-sidebar-border p-2 shrink-0">
        <button
          onClick={clearQueryHistory}
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
        >
          <Trash2 size={12} />
          {t('history.clearHistory')}
        </button>
      </div>
    </div>
  );
}

export default QueryHistory;
