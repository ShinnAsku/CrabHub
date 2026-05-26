import { Database, Table, Code2, X, Plus, GitBranch, PenTool, Brain, NotebookText } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Tab } from "@/types";

interface MainPanelTabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSetActiveTab: (id: string | null) => void;
  onCloseTab: (tabId: string, e: React.MouseEvent) => void;
  onAddQueryTab: () => void;
}

function tabIcon(type: Tab["type"]) {
  switch (type) {
    case "query": return <Code2 size={14} />;
    case "er": return <GitBranch size={14} />;
    case "notebook": return <NotebookText size={14} />;
    case "query-builder": return <Table size={14} />;
    case "analyzer": return <Brain size={14} />;
    default: return <Code2 size={14} />;
  }
}

function TabLabel({ tab }: { tab: Tab }) {
  if (tab.type === "table") {
    return <span>{tab.schemaName ? `${tab.schemaName}.` : ""}{tab.tableName || tab.title}</span>;
  }
  return <span className="truncate max-w-[120px]">{tab.title}</span>;
}

export default function MainPanelTabBar({
  tabs,
  activeTabId,
  onSetActiveTab,
  onCloseTab,
  onAddQueryTab,
}: MainPanelTabBarProps) {
  const tableTabs = tabs.filter(t => t.type === "table");
  const designerTabs = tabs.filter(t => t.type === "designer");
  const editorTabs = tabs.filter(t => t.type !== "table" && t.type !== "designer");
  const showObjectsView = activeTabId === null;

  const tabClass = (id: string) =>
    `group flex items-center gap-1 px-3 py-1 text-xs border-t-2 cursor-pointer transition-colors shrink-0 ${
      activeTabId === id
        ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`;

  return (
    <div className="flex flex-col shrink-0">
      {/* Top: Editor tabs (query, designer, ER, notebook, etc.) */}
      {editorTabs.length > 0 && (
        <div className="flex items-center border-b border-border px-1 bg-muted/30 min-h-[30px] overflow-x-auto">
          {editorTabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => onSetActiveTab(tab.id)}
              className={tabClass(tab.id)}
            >
              {tabIcon(tab.type)}
              <TabLabel tab={tab} />
              <button
                onClick={(e) => onCloseTab(tab.id, e)}
                className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50"
              >
                <X size={10} />
              </button>
            </div>
          ))}
          <div className="flex-1" />
          <button
            aria-label={t("tab.newQuery")}
            onClick={onAddQueryTab}
            className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 rounded"
            title={t("tab.newQuery")}
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      {/* Bottom: Objects tab + Table data tabs */}
      <div className="flex items-center border-b border-border px-1 bg-muted/30 min-h-[30px] overflow-x-auto">
        <button
          onClick={() => onSetActiveTab(null)}
          className={`flex items-center gap-1 px-2 py-1 text-xs border-t-2 transition-colors shrink-0 ${
            showObjectsView
              ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          <Database size={14} />
          <span>{t('navicat.objects')}</span>
        </button>

        {tableTabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSetActiveTab(tab.id)}
            className={tabClass(tab.id)}
          >
            <Table size={14} />
            <TabLabel tab={tab} />
            <button
              onClick={(e) => onCloseTab(tab.id, e)}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        {tableTabs.length > 0 && designerTabs.length > 0 && (
          <div className="w-px h-4 bg-border mx-1 shrink-0" />
        )}

        {designerTabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSetActiveTab(tab.id)}
            className={tabClass(tab.id)}
          >
            <PenTool size={14} />
            <TabLabel tab={tab} />
            <button
              onClick={(e) => onCloseTab(tab.id, e)}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        {/* + button when no editor tabs exist */}
        {editorTabs.length === 0 && (
          <>
            <div className="flex-1" />
            <button
              aria-label={t("tab.newQuery")}
              onClick={onAddQueryTab}
              className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 rounded"
              title={t("tab.newQuery")}
            >
              <Plus size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
