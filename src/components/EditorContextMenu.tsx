import { useRef, useState, useEffect } from "react";
import { Play, Scissors, Copy, ClipboardPaste, AlignLeft, TextCursorInput, MousePointerClick } from "lucide-react";
import { t } from "@/lib/i18n";

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '⌘' : 'Ctrl+';

export interface EditorContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  onClose: () => void;
  onRunAll: () => void;
  onRunSelected: () => void;
  onFormat: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onSelectCurrentStatement: () => void;
}

export function EditorContextMenu({
  x, y, hasSelection, onClose, onRunAll, onRunSelected,
  onFormat, onCut, onCopy, onPaste, onSelectAll, onSelectCurrentStatement,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

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
      <div ref={menuRef} className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[220px]"
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
        <div className="border-t border-border my-1" />
        {item(t("contextMenu.selectCurrentStatement"), onSelectCurrentStatement, <TextCursorInput size={12} />)}
        {item(t("contextMenu.selectAll"), onSelectAll, <MousePointerClick size={12} />, `${modKey}A`)}
      </div>
    </>
  );
}
