import { useRef, useState, useEffect } from "react";
import { Play, Scissors, Copy, ClipboardPaste, AlignLeft, TextCursorInput, MousePointerClick, Repeat, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n";
import { CONVERT_TARGETS } from "@/lib/sql-convert";

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '⌘' : 'Ctrl+';

export interface EditorContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  /** Current connection's db type — the conversion source dialect. */
  sourceDialect?: string;
  onClose: () => void;
  onRunAll: () => void;
  onRunSelected: () => void;
  onFormat: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onSelectCurrentStatement: () => void;
  onConvertDialect?: (target: string) => void;
}

export function EditorContextMenu({
  x, y, hasSelection, sourceDialect, onClose, onRunAll, onRunSelected,
  onFormat, onCut, onCopy, onPaste, onSelectAll, onSelectCurrentStatement,
  onConvertDialect,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [convertOpen, setConvertOpen] = useState(false);

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let ax = x, ay = y;
      if (x + rect.width > window.innerWidth) ax = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight) ay = window.innerHeight - rect.height - 4;
      setPos({ x: ax, y: ay });
    }
  }, [x, y]);

  const item = (label: string, onClick: () => void, icon: React.ReactNode, shortcut?: string, disabled?: boolean, highlight?: boolean) => (
    <button onClick={onClick} disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${
        highlight ? "bg-[hsl(var(--tab-active))] text-white hover:opacity-90" : "hover:bg-muted"}`}>
      <span className="w-4 flex items-center justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[11px] text-muted-foreground ml-4">{shortcut}</span>}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div ref={menuRef} className="popover-panel fixed z-50 border border-border rounded-lg py-1 min-w-[220px]"
        style={{ left: pos.x, top: pos.y, backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))' }}>
        {hasSelection
          ? item(t("contextMenu.runSelected"), onRunSelected, <Play size={12} />, undefined, false, true)
          : item(t("contextMenu.run"), onRunAll, <Play size={12} />, `${modKey}Enter`, false, true)}
        <div className="border-t border-border my-1" />
        {item(t("contextMenu.cut"), onCut, <Scissors size={12} />, `${modKey}X`, !hasSelection)}
        {item(t("contextMenu.copy"), onCopy, <Copy size={12} />, `${modKey}C`, !hasSelection)}
        {item(t("contextMenu.paste"), onPaste, <ClipboardPaste size={12} />, `${modKey}V`)}
        <div className="border-t border-border my-1" />
        {item(t("contextMenu.formatSql"), onFormat, <AlignLeft size={12} />)}
        {onConvertDialect && sourceDialect && (
          <div className="relative">
            <button
              onClick={() => setConvertOpen(!convertOpen)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted"
            >
              <span className="w-4 flex items-center justify-center"><Repeat size={12} /></span>
              <span className="flex-1 text-left">{t("contextMenu.convertDialect")}</span>
              <ChevronRight size={11} className={`transition-transform ${convertOpen ? "rotate-90" : ""}`} />
            </button>
            {convertOpen && (
              <div className="pl-6">
                {CONVERT_TARGETS.filter((tgt) => tgt !== sourceDialect).map((tgt) => (
                  <button
                    key={tgt}
                    onClick={() => onConvertDialect(tgt)}
                    className="w-full px-3 py-1 text-xs text-left hover:bg-muted transition-colors"
                  >
                    → {tgt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="border-t border-border my-1" />
        {item(t("contextMenu.selectCurrentStatement"), onSelectCurrentStatement, <TextCursorInput size={12} />)}
        {item(t("contextMenu.selectAll"), onSelectAll, <MousePointerClick size={12} />, `${modKey}A`)}
      </div>
    </>
  );
}
