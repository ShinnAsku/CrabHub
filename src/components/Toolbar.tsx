import { useState, useCallback } from "react";
import {
  Sun,
  Moon,
  Settings,
  Sparkles,
  FilePlus,
  Download,
  Upload,
  Code2,
  GitCompare,
  Network,
  ChevronDown,
  Globe,
  Table2,
  BarChart3,
  ArrowLeftRight,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

function Toolbar({
  onOpenConnectionDialog,
  onOpenSnippetPanel,
  onOpenSchemaDiff,
  onOpenERDiagram,
  onOpenTableDesigner,
  onOpenQueryAnalyzer,
  onOpenDataMigration,
}: {
  onOpenConnectionDialog: () => void;
  onOpenSnippetPanel: () => void;
  onOpenSchemaDiff: () => void;
  onOpenERDiagram: () => void;
  onOpenTableDesigner: () => void;
  onOpenQueryAnalyzer: () => void;
  onOpenDataMigration: () => void;
}) {
  const { theme, toggleTheme, aiPanelOpen, toggleAIPanel, addTab, tabs, activeConnectionId, language, setLanguage } = useAppStore();
  const [exportOpen, setExportOpen] = useState(false);

  const handleDragStart = useCallback((_e: React.MouseEvent) => {
    try {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().startDragging();
      });
    } catch {
      // Web fallback - no-op
    }
  }, []);

  const handleNewQuery = useCallback(() => {
    const queryCount = tabs.filter((t) => t.type === "query").length + 1;
    addTab({
      title: `${t('tab.query')} ${queryCount}`,
      type: "query",
      content: "",
      connectionId: activeConnectionId || undefined,
      modified: false,
    });
  }, [addTab, tabs.length, activeConnectionId]);

  const handleExport = useCallback((format: "csv" | "json" | "sql") => {
    // Dispatch custom event for EditorPanel to handle
    window.dispatchEvent(new CustomEvent("opendb:export", { detail: { format } }));
    setExportOpen(false);
  }, []);

  const handleImport = useCallback((type: "csv" | "json") => {
    window.dispatchEvent(new CustomEvent("opendb:import", { detail: { type } }));
    setExportOpen(false);
  }, []);

  return (
    <div
      className="flex items-center h-9 px-2 border-b border-border select-none shrink-0 gap-0.5 min-w-[600px]"
      onMouseDown={handleDragStart}
    >
      {/* Logo */}
      <div className="flex items-center gap-1.5 mr-2 shrink-0">
        <ButterflyIcon size={16} />
        <span className="text-xs font-semibold text-foreground tracking-tight">
          openDB
        </span>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* Group 1: Connection & Query */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenConnectionDialog();
          }}
          title={t('toolbar.newConnection')}
        >
          <Network size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('toolbar.connection')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            handleNewQuery();
          }}
          title={t('toolbar.newQuery')}
        >
          <FilePlus size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.query')}</span>
        </ToolbarButton>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* Group 2: Import / Export */}
      <div className="flex items-center gap-0.5 relative shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            handleImport("csv");
          }}
          title={t('toolbar.importCsv')}
        >
          <Upload size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.import')}</span>
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton
            onClick={(e) => {
              e.stopPropagation();
              setExportOpen(!exportOpen);
            }}
            title={t('toolbar.export')}
          >
            <Download size={13} />
            <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.export')}</span>
            <ChevronDown size={10} />
          </ToolbarButton>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setExportOpen(false); }} />
              <div className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded shadow-lg py-1 min-w-[100px]">
                <button
                  onClick={(e) => { e.stopPropagation(); handleExport("csv"); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  CSV
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleExport("json"); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  JSON
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleExport("sql"); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  SQL
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* Group 3: Tools */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenSnippetPanel();
          }}
          title={t('toolbar.snippet')}
        >
          <Code2 size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.snippetShort')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenSchemaDiff();
          }}
          title={t('toolbar.schemaDiff')}
        >
          <GitCompare size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[50px]">{t('toolbar.schemaDiffShort')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenERDiagram();
          }}
          title={t('toolbar.erDiagram')}
        >
          <Network size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.erDiagramShort')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenTableDesigner();
          }}
          title={t('toolbar.tableDesigner')}
        >
          <Table2 size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[50px]">{t('toolbar.tableDesignerShort')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenQueryAnalyzer();
          }}
          title={t('analyzer.performanceAnalysis')}
        >
          <BarChart3 size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('analyzer.title')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenDataMigration();
          }}
          title={t('migration.title')}
        >
          <ArrowLeftRight size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('migration.titleShort')}</span>
        </ToolbarButton>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* Group 4: AI */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            toggleAIPanel();
          }}
          active={aiPanelOpen}
          title={t('toolbar.aiAssistant')}
        >
          <Sparkles size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[20px]">AI</span>
        </ToolbarButton>
      </div>

      {/* Spacer */}
      <div className="flex-1 min-w-0" />

      {/* Group 5: Theme & Settings */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            toggleTheme();
          }}
          title={theme === "dark" ? t('toolbar.switchLightTheme') : t('toolbar.switchDarkTheme')}
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
          </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            setLanguage(language === 'zh' ? 'en' : 'zh');
          }}
          title={t('toolbar.language')}
        >
          <Globe size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[30px]">{language === 'zh' ? 'EN' : '中'}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
          }}
          title={t('toolbar.settings')}
        >
          <Settings size={13} />
        </ToolbarButton>
      </div>
    </div>
  );
}

// ===== Toolbar Button =====

function ToolbarButton({
  children,
  onClick,
  title,
  active,
  className,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 px-2 h-7 rounded text-[11px] transition-colors whitespace-nowrap min-w-[80px] ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      } ${className || ""}`}
    >
      {children}
    </button>
  );
}

// ===== Butterfly Icon =====

function ButterflyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-foreground"
    >
      <path d="M12 12 C8 8, 2 6, 3 10 C4 14, 10 14, 12 12" />
      <path d="M12 12 C8 16, 2 18, 3 14 C4 10, 10 10, 12 12" />
      <path d="M12 12 C16 8, 22 6, 21 10 C20 14, 14 14, 12 12" />
      <path d="M12 12 C16 16, 22 18, 21 14 C20 10, 14 10, 12 12" />
      <line x1="12" y1="6" x2="12" y2="18" />
      <path d="M12 6 C11 4, 9 3, 8 2" />
      <path d="M12 6 C13 4, 15 3, 16 2" />
    </svg>
  );
}

export default Toolbar;
