import { useState, useEffect } from "react";
import { Database, Table, Code2, X, Plus, GitBranch, PenTool, Brain, NotebookText, Pin } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Tab } from "@/types";

/**
 * Unified single-row tab bar (DataGrip / Navicat 16 model).
 *
 * The pinned "Objects" home tab sits first and cannot be closed; every other
 * open item (queries, table data, designers, ER, notebooks) lives in the same
 * strip, differentiated by a type-colored icon. This replaces the previous
 * two-row layout whose stacked strips read as overlapping panels.
 */

interface MainPanelTabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSetActiveTab: (id: string | null) => void;
  onCloseTab: (tabId: string, e: React.MouseEvent) => void;
  onAddQueryTab: () => void;
}

/** Type-colored icon: reuses the sidebar tree palette so colors mean the same everywhere. */
function tabIcon(type: Tab["type"]) {
  switch (type) {
    case "query": return <Code2 size={13} style={{ color: "hsl(var(--tree-view))" }} />;
    case "table": return <Table size={13} style={{ color: "hsl(var(--tree-table))" }} />;
    case "designer": return <PenTool size={13} style={{ color: "hsl(var(--tree-function))" }} />;
    case "er": return <GitBranch size={13} style={{ color: "hsl(var(--tree-schema))" }} />;
    case "notebook": return <NotebookText size={13} style={{ color: "hsl(var(--tree-trigger))" }} />;
    case "query-builder": return <Table size={13} style={{ color: "hsl(var(--tree-procedure))" }} />;
    case "analyzer": return <Brain size={13} style={{ color: "hsl(var(--tree-procedure))" }} />;
    default: return <Code2 size={13} />;
  }
}

function TabLabel({ tab }: { tab: Tab }) {
  if (tab.type === "table") {
    return <span className="truncate max-w-[140px]">{tab.schemaName ? `${tab.schemaName}.` : ""}{tab.tableName || tab.title}</span>;
  }
  return <span className="truncate max-w-[140px]">{tab.title}</span>;
}

export default function MainPanelTabBar({
  tabs,
  activeTabId,
  onSetActiveTab,
  onCloseTab,
  onAddQueryTab,
}: MainPanelTabBarProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  const closeOthers = (keepId: string) => {
    tabs.filter((tb) => tb.id !== keepId).forEach((tb) => onCloseTab(tb.id, new MouseEvent("click") as unknown as React.MouseEvent));
    setCtxMenu(null);
  };
  const closeRight = (fromId: string) => {
    const idx = tabs.findIndex((tb) => tb.id === fromId);
    tabs.slice(idx + 1).forEach((tb) => onCloseTab(tb.id, new MouseEvent("click") as unknown as React.MouseEvent));
    setCtxMenu(null);
  };
  const closeAll = () => {
    tabs.forEach((tb) => onCloseTab(tb.id, new MouseEvent("click") as unknown as React.MouseEvent));
    setCtxMenu(null);
  };

  const baseTab =
    "group relative flex items-center gap-1.5 px-3 h-[30px] text-xs cursor-pointer select-none shrink-0 transition-colors";
  const activeCls = "bg-background text-foreground";
  const inactiveCls = "text-muted-foreground hover:text-foreground hover:bg-muted/50";
  /** Active tabs get a 2px brand underline — modern, unambiguous. */
  const indicator = (active: boolean) =>
    active && (
      <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-t bg-[hsl(var(--tab-active))]" />
    );

  return (
    <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto overflow-y-hidden">
      {/* Pinned Objects home tab */}
      <button
        onClick={() => onSetActiveTab(null)}
        className={`${baseTab} ${activeTabId === null ? activeCls : inactiveCls} border-r border-border/60`}
        title={t("navicat.objects")}
      >
        <Database size={13} className="text-[hsl(var(--tab-active))]" />
        <span>{t("navicat.objects")}</span>
        <Pin size={9} className="opacity-40 -rotate-45" />
        {indicator(activeTabId === null)}
      </button>

      {/* All open tabs, one strip, original order */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => onSetActiveTab(tab.id)}
          onAuxClick={(e) => { if (e.button === 1) onCloseTab(tab.id, e); }}
          onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
          className={`${baseTab} ${activeTabId === tab.id ? activeCls : inactiveCls}`}
        >
          {tabIcon(tab.type)}
          <TabLabel tab={tab} />
          <button
            aria-label={t("tab.close")}
            onClick={(e) => onCloseTab(tab.id, e)}
            className={`ml-0.5 p-0.5 rounded hover:bg-muted ${
              activeTabId === tab.id ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <X size={11} />
          </button>
          {indicator(activeTabId === tab.id)}
        </div>
      ))}

      <div className="flex-1 min-w-2" />
      <button
        aria-label={t("tab.newQuery")}
        onClick={onAddQueryTab}
        className="flex items-center justify-center w-7 h-7 mr-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 rounded-md"
        title={t("tab.newQuery")}
      >
        <Plus size={14} />
      </button>

      {/* Tab context menu */}
      {ctxMenu && (
        <div
          className="popover-panel fixed z-50 border border-border rounded-lg py-1 min-w-[140px] bg-popover text-popover-foreground"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={(e) => { onCloseTab(ctxMenu.tabId, e); setCtxMenu(null); }}>
            {t("tab.close")}
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => closeOthers(ctxMenu.tabId)}>
            {t("tab.closeOthers")}
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={() => closeRight(ctxMenu.tabId)}>
            {t("tab.closeRight")}
          </button>
          <div className="h-px bg-border mx-2 my-1" />
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted" onClick={closeAll}>
            {t("tab.closeAll")}
          </button>
        </div>
      )}
    </div>
  );
}
