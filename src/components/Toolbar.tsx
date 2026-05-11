import { useCallback } from "react";
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
  Globe,
  BarChart3,
  ArrowLeftRight,
  FileText,
  Package,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useAppStore, useTabStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import * as dialog from "@tauri-apps/plugin-dialog";

function Toolbar({
  onOpenConnectionDialog,
  onOpenSnippetPanel,
  onOpenSchemaDiff,
  onOpenERDiagram,
  onOpenQueryAnalyzer,
  onOpenDataMigration,
  onOpenImport,
  onOpenExport,
  connections,
}: {
  onOpenConnectionDialog: () => void;
  onOpenSnippetPanel: () => void;
  onOpenSchemaDiff: () => void;
  onOpenERDiagram: () => void;
  onOpenQueryAnalyzer: () => void;
  onOpenDataMigration: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  connections: any[];
}) {
  const { theme, toggleTheme, aiPanelOpen, toggleAIPanel, addTab, tabs, activeConnectionId, language, setLanguage, setViewModeType } = useAppStore();
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target as Node)) {
        setSettingsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleDragStart = useCallback((_e: React.MouseEvent) => {
    try {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().startDragging();
      });
    } catch {
      // Web fallback - no-op
    }
  }, []);

  const handleNewQuery = useCallback(async () => {
    const connectedConnections = connections.filter(conn => conn.connected);
    
    if (connectedConnections.length === 0) {
      // No connected database
      await dialog.message('Please connect to a database before opening a query.');
      return;
    } else if (connectedConnections.length > 1) {
      // Multiple connected databases, show selection dialog
      // For Tauri v2, we'll use a simple message dialog for now
      // TODO: Implement proper selection dialog using Tauri v2 API
      await dialog.message('Multiple connections detected. Please select a connection from the sidebar.');
      return;
    } else {
      // Only one connected database
      const queryCount = tabs.filter((t) => t.type === "query").length + 1;
      addTab({
        title: `${t('tab.query')} ${queryCount}`,
        type: "query",
        content: "",
        connectionId: connectedConnections[0].id,
      });
    }
    
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType]);

  const handleNewNotebook = useCallback(async () => {
    const connectedConnections = connections.filter(conn => conn.connected);
    
    if (connectedConnections.length === 0) {
      // No connected database
      await dialog.message('Please connect to a database before opening a notebook.');
      return;
    } else if (connectedConnections.length > 1) {
      // Multiple connected databases, show selection dialog
      // For Tauri v2, we'll use a simple message dialog for now
      // TODO: Implement proper selection dialog using Tauri v2 API
      await dialog.message('Multiple connections detected. Please select a connection from the sidebar.');
      return;
    } else {
      // Only one connected database
      const notebookCount = tabs.filter((t) => t.type === "notebook").length + 1;
      addTab({
        title: `${t('tab.notebook')} ${notebookCount}`,
        type: "notebook",
        content: "",
        connectionId: connectedConnections[0].id,
      });
    }
    
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType]);

  const handleNewQueryBuilder = useCallback(async () => {
    const connectedConnections = connections.filter(conn => conn.connected);
    
    if (connectedConnections.length === 0) {
      // No connected database
      await dialog.message('Please connect to a database before opening a query builder.');
      return;
    } else if (connectedConnections.length > 1) {
      // Multiple connected databases, show selection dialog
      // For Tauri v2, we'll use a simple message dialog for now
      // TODO: Implement proper selection dialog using Tauri v2 API
      await dialog.message('Multiple connections detected. Please select a connection from the sidebar.');
      return;
    } else {
      // Only one connected database
      const builderCount = tabs.filter((t) => t.type === "query-builder").length + 1;
      addTab({
        title: `${t('tab.queryBuilder')} ${builderCount}`,
        type: "query-builder",
        content: "",
        connectionId: connectedConnections[0].id,
      });
    }
    
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType]);

  return (
    <div
      className="flex items-center h-9 px-2 border-b border-border select-none shrink-0 gap-0.5 min-w-[600px]"
      onMouseDown={handleDragStart}
    >
      {/* Logo */}
      <div className="flex items-center gap-1.5 mr-2 shrink-0">
        <ButterflyIcon size={16} />
        <span className="text-xs font-semibold text-foreground tracking-tight">
          OpenDB
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
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            handleNewNotebook();
          }}
          title={t('toolbar.newNotebook')}
        >
          <FileText size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('toolbar.notebook')}</span>
        </ToolbarButton>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* Group 2: Import / Export */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenImport();
          }}
          title={t('toolbar.import')}
        >
          <Upload size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.import')}</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenExport();
          }}
          title={t('toolbar.export')}
        >
          <Download size={13} />
          <span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.export')}</span>
        </ToolbarButton>
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
        <div className="relative" ref={settingsMenuRef}>
          <ToolbarButton
            onClick={(e) => {
              e.stopPropagation();
              setSettingsMenuOpen(!settingsMenuOpen);
            }}
            title={t('toolbar.settings')}
          >
            <Settings size={13} />
          </ToolbarButton>
          {settingsMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-background border border-border rounded-md shadow-lg z-50">
              <button
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('openPluginManager'));
                setSettingsMenuOpen(false);
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <Package size={12} className="inline mr-2" />
              {t('plugin.title')}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('openUpdateManager'));
                setSettingsMenuOpen(false);
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <Download size={12} className="inline mr-2" />
              {t('update.title')}
            </button>
          </div>
          )}
        </div>
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
