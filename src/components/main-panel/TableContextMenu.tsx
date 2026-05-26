import {
  Table,
  Wrench,
  FileText,
  Copy,
  ChevronRight,
  Eraser,
  Trash2,
} from "lucide-react";
import type { SchemaNode } from "@/types";
import { t } from "@/lib/i18n";

interface TableContextMenuState {
  x: number;
  y: number;
  table: SchemaNode;
}

interface TableContextMenuProps {
  menu: TableContextMenuState;
  onClose: () => void;
  onOpenTable: (table: SchemaNode) => void;
  onDesignTable: (table: SchemaNode) => void;
  onCopyName: (table: SchemaNode) => void;
  onDuplicateTable: (table: SchemaNode, includeData: boolean) => void;
  onTruncate: (table: SchemaNode) => void;
  onDeleteTable: (table: SchemaNode) => void;
}

export default function TableContextMenu({
  menu,
  onClose,
  onOpenTable,
  onDesignTable,
  onCopyName,
  onDuplicateTable,
  onTruncate,
  onDeleteTable,
}: TableContextMenuProps) {
  const isTable = menu.table.type === "table";
  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        className="fixed z-50 border border-border rounded-md shadow-lg py-1 min-w-[180px]"
        style={{
          left: menu.x,
          top: menu.y,
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
      >
        <button
          onClick={() => { onOpenTable(menu.table); onClose(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
        >
          <Table size={12} />
          <span>{t("sidebar.openTable")}</span>
        </button>
        {isTable && (
          <button
            onClick={() => { onDesignTable(menu.table); onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            <Wrench size={12} />
            <span>{t("sidebar.designTable")}</span>
          </button>
        )}
        {isTable && (
          <>
            <div className="border-t border-border my-1" />
            <button
              onClick={() => { onCopyName(menu.table); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              <FileText size={12} />
              <span>{t('sidebar.copyName')}</span>
            </button>
          </>
        )}
        {isTable && (
          <>
            <div className="border-t border-border my-1" />
            <div className="relative group/dup">
              <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted transition-colors cursor-default">
                <span className="flex items-center gap-2">
                  <Copy size={12} />
                  {t("sidebar.duplicateTable")}
                </span>
                <ChevronRight size={12} className="text-muted-foreground" />
              </div>
              <div className="absolute left-full top-0 ml-0 hidden group-hover/dup:block z-[60]">
                <div
                  className="border border-border rounded-md shadow-lg py-1 min-w-[150px]"
                  style={{
                    backgroundColor: "hsl(var(--popover))",
                    color: "hsl(var(--popover-foreground))",
                  }}
                >
                  <button
                    onClick={() => { onDuplicateTable(menu.table, true); onClose(); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                  >
                    <span>{t("sidebar.structureAndData")}</span>
                  </button>
                  <button
                    onClick={() => { onDuplicateTable(menu.table, false); onClose(); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                  >
                    <span>{t("sidebar.structureOnly")}</span>
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        {isTable && (
          <>
            <div className="border-t border-border my-1" />
            <button
              onClick={() => { onTruncate(menu.table); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-warning"
            >
              <Eraser size={12} />
              <span>{t("sidebar.truncateTable")}</span>
            </button>
            <button
              onClick={() => { onDeleteTable(menu.table); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-destructive"
            >
              <Trash2 size={12} />
              <span>{t("sidebar.deleteTable")}</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

export type { TableContextMenuState };
