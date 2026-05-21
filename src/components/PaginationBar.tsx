import { useState, useCallback } from "react";
import {
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
} from "lucide-react";
import { t } from "@/lib/i18n";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalRows: number | null;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  loading?: boolean;
}

export default function PaginationBar({
  currentPage,
  totalPages,
  pageSize,
  totalRows,
  pageSizeOptions = [100, 500, 1000, 5000],
  onPageChange,
  onPageSizeChange,
  loading = false,
}: PaginationBarProps) {
  const [pageInput, setPageInput] = useState(String(currentPage));

  const handlePageInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value);
  }, []);

  const handlePageInputCommit = useCallback(() => {
    const num = parseInt(pageInput, 10);
    if (!isNaN(num) && num >= 1 && num <= totalPages) {
      onPageChange(num);
    } else {
      setPageInput(String(currentPage));
    }
  }, [pageInput, totalPages, currentPage, onPageChange]);

  const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handlePageInputCommit();
    }
  }, [handlePageInputCommit]);

  // Sync input when currentPage changes externally
  if (String(currentPage) !== pageInput && document.activeElement?.tagName !== "INPUT") {
    setPageInput(String(currentPage));
  }

  const isFirst = currentPage <= 1;
  const isLast = currentPage >= totalPages;
  const allDisabled = loading;

  const btnClass = (disabled: boolean) =>
    `p-0.5 rounded transition-colors ${
      disabled || allDisabled
        ? "text-muted-foreground/30 cursor-default"
        : "text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
    }`;

  return (
    <div className="flex items-center justify-between px-2 py-1 border-t border-border bg-muted/20 shrink-0 select-none">
      {/* Left: page navigation */}
      <div className="flex items-center gap-1">
        <button
          className={btnClass(isFirst)}
          disabled={isFirst || allDisabled}
          onClick={() => onPageChange(1)}
          title={t('pagination.first')}
        >
          <ChevronsLeft size={14} />
        </button>
        <button
          className={btnClass(isFirst)}
          disabled={isFirst || allDisabled}
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          title={t('pagination.previous')}
        >
          <ChevronLeft size={14} />
        </button>

        <span className="text-xs text-muted-foreground mx-1">{t('pagination.page')}</span>
        <input
          type="text"
          value={pageInput}
          onChange={handlePageInputChange}
          onBlur={handlePageInputCommit}
          onKeyDown={handlePageInputKeyDown}
          disabled={allDisabled}
          className="w-10 text-center text-xs px-1 py-0.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] disabled:opacity-40"
        />
        <span className="text-xs text-muted-foreground mx-0.5">/ {totalPages} {t('pagination.of')}</span>

        <button
          className={btnClass(isLast)}
          disabled={isLast || allDisabled}
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          title={t('pagination.next')}
        >
          <ChevronRight size={14} />
        </button>
        <button
          className={btnClass(isLast)}
          disabled={isLast || allDisabled}
          onClick={() => onPageChange(totalPages)}
          title={t('pagination.last')}
        >
          <ChevronsRight size={14} />
        </button>
      </div>

      {/* Right: page size + total */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('pagination.rowsPerPage')}</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          disabled={allDisabled}
          className="text-xs px-1 py-0.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] disabled:opacity-40"
        >
          {pageSizeOptions.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        <div className="w-px h-3 bg-border mx-1" />

        <span className="text-xs text-muted-foreground">
          {totalRows !== null
            ? t('pagination.totalRows').replace('{count}', totalRows.toLocaleString())
            : "—"}
        </span>
      </div>
    </div>
  );
}
