import { X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

function getTabTitle(tab: { title: string; titleKey?: string; titleNum?: number }): string {
  if (tab.titleKey) {
    const base = t(tab.titleKey);
    return tab.titleNum ? `${base} ${tab.titleNum}` : base;
  }
  return tab.title;
}

function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } =
    useAppStore();

  return (
    <div className="flex items-center flex-1 overflow-x-auto min-w-0">
      {/* Tabs */}
      <div className="flex items-center min-w-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1.5 px-3 h-8 text-xs whitespace-nowrap border-r border-border transition-colors shrink-0 cursor-pointer border-b-2 ${
              activeTabId === tab.id
                ? "text-foreground bg-muted border-b-[hsl(var(--tab-active))]"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border-b-transparent"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="truncate max-w-[120px]">{getTabTitle(tab)}</span>

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
        ))}
      </div>

    </div>
  );
}

export default TabBar;
