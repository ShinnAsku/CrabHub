import { useState, useRef, useEffect, useCallback } from "react";
import {
  Sparkles, MoreHorizontal,
  Network, Upload, Download, Code2, GitCompare,
  ArrowLeftRight,
  Package, NotebookText, Palette, Check,
} from 'lucide-react';
import { useAppStore, useTabStore } from "@/stores/app-store";
import { THEMES } from "@/stores/modules/ui";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

function ToolbarActions({
  onOpenConnectionDialog, onOpenSnippetPanel, onOpenSchemaDiff,
  onOpenERDiagram, onOpenDataMigration,
  onOpenImport, onOpenExport,
}: {
  onOpenConnectionDialog: () => void;
  onOpenSnippetPanel: () => void;
  onOpenSchemaDiff: () => void;
  onOpenERDiagram: () => void;
  onOpenDataMigration: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
}) {
  const { aiPanelOpen, toggleAIPanel, theme, setTheme } = useAppStore();
  const { addTab } = useTabStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNewNotebook = useCallback(() => {
    const notebookCount = useTabStore.getState().tabs.filter(t => t.type === "notebook").length + 1;
    addTab({ title: `Notebook ${notebookCount}`, type: "notebook", content: "" });
    setMoreOpen(false);
  }, [addTab]);

  const ICON_SIZE = 15;
  const BTN_CLS = "h-7 w-7";

  return (
    <div className="flex items-center gap-0.5 shrink-0 px-1.5">
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
            className="popover-panel absolute right-0 top-full mt-1 w-52 bg-background/95 border border-border rounded-lg z-50 py-1 max-h-[70vh] overflow-y-auto"
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
            <DropdownItem onClick={(e) => { e.stopPropagation(); onOpenDataMigration(); setMoreOpen(false); }}>
              <ArrowLeftRight size={14} className="mr-2" />{t('migration.title')}
            </DropdownItem>
            <DropdownItem onClick={(e) => { e.stopPropagation(); handleNewNotebook(); }}>
              <NotebookText size={14} className="mr-2" />{t('notebook.title')}
            </DropdownItem>
            <div className="h-px bg-border mx-2 my-1" />
            {/* Theme picker: header toggles an inline swatch list */}
            <DropdownItem onClick={(e) => { e.stopPropagation(); setThemeOpen(!themeOpen); }}>
              <Palette size={14} className="mr-2" />{t('theme.title')}
              <span className="ml-auto flex items-center gap-1">
                <span
                  className="w-3 h-3 rounded-full border border-border"
                  style={{ backgroundColor: THEMES.find((th) => th.id === theme)?.swatch }}
                />
              </span>
            </DropdownItem>
            {themeOpen && (
              <div className="pl-4">
                {THEMES.map((th) => (
                  <DropdownItem
                    key={th.id}
                    onClick={(e) => { e.stopPropagation(); setTheme(th.id); }}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-border mr-2 shrink-0"
                      style={{ backgroundColor: th.swatch }}
                    />
                    {t(th.labelKey)}
                    {theme === th.id && <Check size={13} className="ml-auto text-[hsl(var(--tab-active))]" />}
                  </DropdownItem>
                ))}
              </div>
            )}
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
