import { useCallback, useState, useRef, useEffect } from "react";
import {
  Sun, Moon, Settings, Sparkles, FilePlus, Download, Upload,
  Code2, GitCompare, Network, Globe, BarChart3, ArrowLeftRight,
  FileText, Package,
} from 'lucide-react';
import { useAppStore, useTabStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { showMessage } from "./MessageDialog";
import { Button } from "@/components/ui/button";

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
    <div className="flex items-center h-9 px-2 border-b border-border select-none shrink-0 gap-0.5 relative">

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
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openPluginManager')); setSettingsMenuOpen(false); }} onMouseDown={(e) => e.stopPropagation()} className="w-full justify-start px-4 py-2 h-auto text-sm">
                  <Package size={12} className="mr-2" />{t('plugin.title')}
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openUpdateManager')); setSettingsMenuOpen(false); }} onMouseDown={(e) => e.stopPropagation()} className="w-full justify-start px-4 py-2 h-auto text-sm">
                  <Download size={12} className="mr-2" />{t('update.title')}
                </Button>
              </div>
          )}
        </div>
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
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={title}
      data-active={active || undefined}
      className={`h-7 text-[11px] ${active ? "bg-accent text-accent-foreground" : ""} ${className || ""}`}
    >
      {children}
    </Button>
  );
}

export default Toolbar;
