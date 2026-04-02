import { X, Plus } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, addTab, connections } =
    useAppStore();

  const handleAddTab = () => {
    const queryCount = tabs.filter((t) => t.type === "query").length + 1;
    addTab({
      title: `${t('tab.query')} ${queryCount}`,
      type: "query",
      content: "",
      modified: false,
    });
  };

  // Get connection color for tab
  const getConnectionColor = (connectionId?: string): string | undefined => {
    if (!connectionId) return undefined;
    const conn = connections.find((c) => c.id === connectionId);
    return conn?.color;
  };

  return (
    <div className="flex items-center h-9 bg-background border-b border-border shrink-0 overflow-x-auto">
      {/* Tabs */}
      <div className="flex items-center h-full min-w-0">
        {tabs.map((tab) => {
          const connColor = getConnectionColor(tab.connectionId);
          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap border-r border-border transition-colors shrink-0 cursor-pointer ${
                activeTabId === tab.id
                  ? "text-foreground bg-muted border-b-2 border-b-[hsl(var(--tab-active))]"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {/* Connection indicator dot */}
              {connColor && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: connColor }}
                />
              )}

              {/* Modified indicator */}
              {tab.modified && (
                <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--tab-active))] shrink-0" />
              )}

              <span className="truncate max-w-[120px]">{tab.title}</span>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add Tab Button */}
      <button
        onClick={handleAddTab}
        className="flex items-center justify-center w-8 h-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
        title={t('tab.newQuery')}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export default TabBar;
