import { useCallback, useState, useRef, useEffect } from "react";
import {
  Plus, Sparkles, MoreHorizontal,
  Network, Upload, Download, Code2, GitCompare,
  BarChart3, ArrowLeftRight,
  Package,
} from 'lucide-react';
import { useAppStore, useTabStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

function ToolbarActions({
  onOpenConnectionDialog, onOpenSnippetPanel, onOpenSchemaDiff,
  onOpenERDiagram, onOpenQueryAnalyzer, onOpenDataMigration,
  onOpenImport, onOpenExport,
}: {
  onOpenConnectionDialog: () => void;
  onOpenSnippetPanel: () => void;
  onOpenSchemaDiff: () => void;
  onOpenERDiagram: () => void;
  onOpenQueryAnalyzer: () => void;
  onOpenDataMigration: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
}) {
  const { aiPanelOpen, toggleAIPanel } = useAppStore();
  const { addTab, tabs } = useTabStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNewQuery = useCallback(() => {
    const queryCount = tabs.filter((t) => t.type === "query").length + 1;
    addTab({ title: `${t('tab.query')} ${queryCount}`, titleKey: 'tab.query', titleNum: queryCount, type: "query", content: "" });
  }, [addTab, tabs.length, t]);

  const ICON_SIZE = 15;
  const BTN_CLS = "h-7 w-7";

  return (
    <div className="flex items-center gap-0.5 shrink-0 px-1.5">
      {/* New Query */}
      <Button variant="ghost" size="icon" className={BTN_CLS} onClick={(e) => { e.stopPropagation(); handleNewQuery(); }} title={t('toolbar.newQuery')}>
        <Plus size={ICON_SIZE} />
      </Button>

      {/* Toggle AI Panel */}
      <Button variant="ghost" size="icon" className={BTN_CLS} onClick={(e) => { e.stopPropagation(); toggleAIPanel(); }} data-active={aiPanelOpen || undefined} title={t('toolbar.aiAssistant')}>
        <Sparkles size={ICON_SIZE} />
      </Button>

      {/* Separator */}
      <div className="w-px h-4 bg-border mx-0.5 shrink-0" />

      {/* More Actions Dropdown */}
      <div className="relative" ref={moreMenuRef}>
        <Button variant="ghost" size="icon" className={BTN_CLS} onClick={(e) => { e.stopPropagation(); setMoreOpen(!moreOpen); }} title="">
          <MoreHorizontal size={ICON_SIZE} />
        </Button>
        {moreOpen && (
          <div
            className="absolute right-0 top-full mt-1 w-52 bg-background border border-border rounded-md shadow-lg z-50 py-1 max-h-[70vh] overflow-y-auto"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenConnectionDialog(); setMoreOpen(false); }}>
              <Network size={14} className="mr-2" />{t('toolbar.newConnection')}
            </DropdownItem>
            <div className="h-px bg-border mx-2 my-1" />
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenImport(); setMoreOpen(false); }}>
              <Upload size={14} className="mr-2" />{t('toolbar.import')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenExport(); setMoreOpen(false); }}>
              <Download size={14} className="mr-2" />{t('toolbar.export')}
            </DropdownItem>
            <div className="h-px bg-border mx-2 my-1" />
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenSnippetPanel(); setMoreOpen(false); }}>
              <Code2 size={14} className="mr-2" />{t('toolbar.snippet')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenSchemaDiff(); setMoreOpen(false); }}>
              <GitCompare size={14} className="mr-2" />{t('toolbar.schemaDiff')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenERDiagram(); setMoreOpen(false); }}>
              <Network size={14} className="mr-2" />{t('toolbar.erDiagram')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenQueryAnalyzer(); setMoreOpen(false); }}>
              <BarChart3 size={14} className="mr-2" />{t('analyzer.performanceAnalysis')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenDataMigration(); setMoreOpen(false); }}>
              <ArrowLeftRight size={14} className="mr-2" />{t('migration.title')}
            </DropdownItem>
            <div className="h-px bg-border mx-2 my-1" />
            <DropdownItem onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openPluginManager')); setMoreOpen(false); }}>
              <Package size={14} className="mr-2" />{t('plugin.title')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('openUpdateManager')); setMoreOpen(false); }}>
              <Download size={14} className="mr-2" />{t('update.title')}
            </DropdownItem>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Sub-component =====

function DropdownItem({ children, onClick }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} onMouseDown={(e) => e.stopPropagation()} className="w-full justify-start px-4 py-2 h-auto text-sm font-normal rounded-none">
      {children}
    </Button>
  );
}

export default ToolbarActions;
