import { useCallback, useState, useRef, useEffect } from "react";
import {
  Sun, Moon, Settings, Sparkles, FilePlus, Download, Upload,
  Code2, GitCompare, Network, Globe, BarChart3, ArrowLeftRight,
  FileText, Package, Minus, Square, X,
} from 'lucide-react';
import { useAppStore, useTabStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { showMessage } from "./MessageDialog";

function Toolbar({
  onOpenConnectionDialog, onOpenSnippetPanel, onOpenSchemaDiff,
  onOpenERDiagram, onOpenQueryAnalyzer, onOpenDataMigration,
  onOpenImport, onOpenExport, connections,
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
  const { theme, toggleTheme, aiPanelOpen, toggleAIPanel, addTab, tabs, language, setLanguage, setViewModeType } = useAppStore();
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target as Node)) {
        setSettingsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNewQuery = useCallback(async () => {
    const connected = connections.filter((c: any) => c.connected);
    if (connected.length === 0) { await showMessage(t('common.noConnectionHint')); return; }
    if (connected.length > 1) { await showMessage(t('common.multipleConnectionsHint')); return; }
    const queryCount = tabs.filter((t) => t.type === "query").length + 1;
    addTab({ title: `${t('tab.query')} ${queryCount}`, titleKey: 'tab.query', titleNum: queryCount, type: "query", content: "", connectionId: connected[0].id });
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType, t]);

  const handleNewNotebook = useCallback(async () => {
    const connected = connections.filter((c: any) => c.connected);
    if (connected.length === 0) { await showMessage(t('common.noConnectionHint')); return; }
    if (connected.length > 1) { await showMessage(t('common.multipleConnectionsHint')); return; }
    const notebookCount = tabs.filter((t) => t.type === "notebook").length + 1;
    addTab({ title: `${t('tab.notebook')} ${notebookCount}`, titleKey: 'tab.notebook', titleNum: notebookCount, type: "notebook", content: "", connectionId: connected[0].id });
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType, t]);

  const handleNewQueryBuilder = useCallback(async () => {
    const connected = connections.filter((c: any) => c.connected);
    if (connected.length === 0) { await showMessage(t('common.noConnectionHint')); return; }
    if (connected.length > 1) { await showMessage(t('common.multipleConnectionsHint')); return; }
    const builderCount = tabs.filter((t) => t.type === "query-builder").length + 1;
    addTab({ title: `${t('tab.queryBuilder')} ${builderCount}`, titleKey: 'tab.queryBuilder', titleNum: builderCount, type: "query-builder", content: "", connectionId: connected[0].id });
    setViewModeType("query");
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
    }, 0);
  }, [addTab, tabs.length, connections, setViewModeType, t]);

  return (
    <div
      className="flex items-center h-9 px-2 border-b border-border select-none shrink-0 gap-0.5 relative"
      data-tauri-drag-region
    >
      {/* Logo */}
      <div className="flex items-center gap-1.5 mr-2 shrink-0">
        <CrabIcon size={16} />
        <span className="text-xs font-semibold text-foreground tracking-tight">CrabHub</span>
      </div>

      {/* Middle section: clips when window is narrow */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
        <Divider />
        <ButtonGroup>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenConnectionDialog(); }} title={t('toolbar.newConnection')}>
            <Network size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('toolbar.connection')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); handleNewQuery(); }} title={t('toolbar.newQuery')}>
            <FilePlus size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.query')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); handleNewNotebook(); }} title={t('toolbar.newNotebook')}>
            <FileText size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('toolbar.notebook')}</span>
          </ToolbarButton>
        </ButtonGroup>
        <Divider />
        <ButtonGroup>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenImport(); }} title={t('toolbar.import')}>
            <Upload size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.import')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenExport(); }} title={t('toolbar.export')}>
            <Download size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.export')}</span>
          </ToolbarButton>
        </ButtonGroup>
        <Divider />
        <ButtonGroup>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenSnippetPanel(); }} title={t('toolbar.snippet')}>
            <Code2 size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.snippetShort')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenSchemaDiff(); }} title={t('toolbar.schemaDiff')}>
            <GitCompare size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[50px]">{t('toolbar.schemaDiffShort')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenERDiagram(); }} title={t('toolbar.erDiagram')}>
            <Network size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('toolbar.erDiagramShort')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenQueryAnalyzer(); }} title={t('analyzer.performanceAnalysis')}>
            <BarChart3 size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[60px]">{t('analyzer.title')}</span>
          </ToolbarButton>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); onOpenDataMigration(); }} title={t('migration.title')}>
            <ArrowLeftRight size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[40px]">{t('migration.titleShort')}</span>
          </ToolbarButton>
        </ButtonGroup>
        <Divider />
        <ButtonGroup>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); toggleAIPanel(); }} active={aiPanelOpen} title={t('toolbar.aiAssistant')}>
            <Sparkles size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[20px]">AI</span>
          </ToolbarButton>
        </ButtonGroup>
        {/* Spacer fills remaining space */}
        <div className="flex-1 min-w-0" />
      </div>

      {/* Right section: always visible */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarButton onClick={(e) => { e.stopPropagation(); toggleTheme(); }} title={theme === "dark" ? t('toolbar.switchLightTheme') : t('toolbar.switchDarkTheme')}>
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </ToolbarButton>
        <ToolbarButton onClick={(e) => { e.stopPropagation(); setLanguage(language === 'zh' ? 'en' : 'zh'); }} title={t('toolbar.language')}>
          <Globe size={13} /><span className="text-ellipsis whitespace-nowrap overflow-hidden max-w-[30px]">{language === 'zh' ? 'EN' : 'CN'}</span>
        </ToolbarButton>
        <div className="relative" ref={settingsMenuRef}>
          <ToolbarButton onClick={(e) => { e.stopPropagation(); setSettingsMenuOpen(!settingsMenuOpen); }} title={t('toolbar.settings')}>
            <Settings size={13} />
          </ToolbarButton>
          {settingsMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-background border border-border rounded-md shadow-lg z-50">
              <button onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openPluginManager')); setSettingsMenuOpen(false); }} onMouseDown={(e) => e.stopPropagation()} className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors">
                <Package size={12} className="inline mr-2" />{t('plugin.title')}
              </button>
              <button onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openUpdateManager')); setSettingsMenuOpen(false); }} onMouseDown={(e) => e.stopPropagation()} className="w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors">
                <Download size={12} className="inline mr-2" />{t('update.title')}
              </button>
            </div>
          )}
        </div>
        <WindowControls />
      </div>
    </div>
  );
}

// ===== Sub-components =====

function Divider() {
  return <div className="w-px h-4 bg-border mx-1 shrink-0" />;
}

function ButtonGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5 shrink-0">{children}</div>;
}

function ToolbarButton({ children, onClick, title, active, className }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button onClick={onClick} onMouseDown={(e) => e.stopPropagation()} title={title}
      className={`flex items-center gap-1 px-2 h-7 rounded text-[11px] transition-colors whitespace-nowrap shrink-0 ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"} ${className || ""}`}>
      {children}
    </button>
  );
}

function WindowControls() {
  const act = (fn: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      (getCurrentWindow() as any)[fn]();
    }).catch(() => {});
  };
  return (
    <div className="flex items-center shrink-0 ml-1" onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={act("minimize")} onMouseDown={(e) => e.stopPropagation()} className="flex items-center justify-center w-8 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Minimize"><Minus size={12} /></button>
      <button onClick={act("toggleMaximize")} onMouseDown={(e) => e.stopPropagation()} className="flex items-center justify-center w-8 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Maximize"><Square size={11} /></button>
      <button onClick={act("close")} onMouseDown={(e) => e.stopPropagation()} className="flex items-center justify-center w-8 h-7 rounded text-muted-foreground hover:text-white hover:bg-red-500 transition-colors" title="Close"><X size={14} /></button>
    </div>
  );
}

function CrabIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="15" fill="white" />
      <g transform="translate(4,4) scale(0.9)">
        {/* Body */}
        <ellipse cx="13" cy="16" rx="8" ry="6" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" />
        {/* Eyes */}
        <circle cx="10" cy="13" r="1.8" fill="white" />
        <circle cx="16" cy="13" r="1.8" fill="white" />
        <circle cx="10" cy="12.8" r="0.9" fill="#1a1a1a" />
        <circle cx="16" cy="12.8" r="0.9" fill="#1a1a1a" />
        {/* Mouth */}
        <path d="M11 17.5 Q13 19, 15 17.5" stroke="#991B1B" strokeWidth="0.6" fill="none" />
        {/* Left claw */}
        <path d="M5 15 C5 15, -1 10, -2 6 C-3 3, 0 3, 1 6 L3 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" />
        <path d="M-2 6 C-2 6, -4 4, -3 2 C-2 0, -1 2, 0 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" />
        {/* Right claw */}
        <path d="M21 15 C21 15, 27 10, 28 6 C29 3, 26 3, 25 6 L23 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" />
        <path d="M28 6 C28 6, 30 4, 29 2 C28 0, 27 2, 26 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" />
        {/* Legs left */}
        <path d="M7 17 L2 19 L1 21" stroke="#DC2626" strokeWidth="0.7" fill="none" />
        <path d="M7 18 L3 21 L2 23" stroke="#DC2626" strokeWidth="0.7" fill="none" />
        <path d="M8 19 L4 22 L3 24" stroke="#DC2626" strokeWidth="0.7" fill="none" />
        {/* Legs right */}
        <path d="M19 17 L24 19 L25 21" stroke="#DC2626" strokeWidth="0.7" fill="none" />
        <path d="M19 18 L23 21 L24 23" stroke="#DC2626" strokeWidth="0.7" fill="none" />
        <path d="M18 19 L22 22 L23 24" stroke="#DC2626" strokeWidth="0.7" fill="none" />
      </g>
    </svg>
  );
}

export default Toolbar;
