import { downloadFile, exportToCSV, exportToJSON, exportToSQL } from '@/lib/export'
import { t } from '@/lib/i18n'
import { rowsToMarkdown } from '@/lib/sql-utils'
import type { ColumnInfo, QueryResult, TableRow } from '@/types/index'
import { useVirtualizer } from '@tanstack/react-virtual'
import { BarChart3, Code2, Copy, Database, Loader2, TextCursorInput, XCircle } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
const COL_MIN_WIDTH = 120

interface TableContextMenuProps {
  x: number
  y: number
  selectedCount: number
  hasSelection: boolean
  canEdit: boolean
  onClose: () => void
  onCopyRows: () => void
  onCopyAsMarkdown: () => void
  onExportCSV: () => void
  onExportJSON: () => void
  onExportSQL: () => void
  onEditRow: () => void
  onDeleteRows: () => void
  onGenerateDeleteSQL: () => void
  onGenerateChart?: () => void
}

function TableContextMenu({
  x,
  y,
  selectedCount,
  hasSelection,
  canEdit,
  onClose,
  onCopyRows,
  onCopyAsMarkdown,
  onExportCSV,
  onExportJSON,
  onExportSQL,
  onEditRow,
  onDeleteRows,
  onGenerateDeleteSQL,
  onGenerateChart,
}: TableContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      let ax = x,
        ay = y
      if (x + rect.width > window.innerWidth) ax = window.innerWidth - rect.width - 4
      if (y + rect.height > window.innerHeight) ay = window.innerHeight - rect.height - 4
      setPos({ x: ax, y: ay })
    }
  }, [x, y])

  const item = (
    label: string,
    onClick: () => void,
    icon: React.ReactNode,
    disabled?: boolean,
    destructive?: boolean
  ) => (
    <button
      onClick={() => {
        if (!disabled) {
          onClick()
          onClose()
        }
      }}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${
        destructive ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-muted'
      }`}
    >
      <span className="w-4 flex items-center justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {selectedCount > 0 && (
        <span className="text-[11px] text-muted-foreground ml-2">{selectedCount}</span>
      )}
    </button>
  )

  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={e => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="popover-panel fixed z-50 border border-border rounded-lg py-1 min-w-[200px]"
        style={{
          left: pos.x,
          top: pos.y,
          backgroundColor: 'hsl(var(--popover))',
          color: 'hsl(var(--popover-foreground))',
        }}
      >
        {item(t('table.copyRows'), onCopyRows, <Copy size={12} />, !hasSelection)}
        {item(t('table.copyAsMarkdown'), onCopyAsMarkdown, <Copy size={12} />, !hasSelection)}
        <div className="border-t border-border my-1" />
        {item(t('table.exportCSV'), onExportCSV, <Database size={12} />, !hasSelection)}
        {item(t('table.exportJSON'), onExportJSON, <Code2 size={12} />, !hasSelection)}
        {item(t('table.exportSQL'), onExportSQL, <Database size={12} />, !hasSelection)}
        {item(
          t('table.generateChart'),
          () => onGenerateChart?.(),
          <BarChart3 size={12} />,
          !hasSelection
        )}
        <div className="border-t border-border my-1" />
        {item(
          t('table.editRow'),
          onEditRow,
          <TextCursorInput size={12} />,
          !canEdit || selectedCount !== 1
        )}
        {item(
          t('table.generateDeleteSQL'),
          onGenerateDeleteSQL,
          <Code2 size={12} />,
          !canEdit || !hasSelection
        )}
        {item(
          t('table.deleteRows'),
          onDeleteRows,
          <XCircle size={12} />,
          !canEdit || !hasSelection,
          true
        )}
      </div>
    </>
  )
}

function VirtualTableBody({
  rows,
  columns,
  virtualCount,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelectionChange,
  onModifiedCellsChange,
  onDeleteRows,
  onGenerateDeleteSQL,
  onGenerateChart,
  discardRef,
  selectedRowsRef,
  sortConfig,
  onSort,
}: {
  rows: TableRow[]
  columns: ColumnInfo[]
  virtualCount: number
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  onSelectionChange?: (indices: number[]) => void
  onModifiedCellsChange?: (count: number, getCells: () => Map<string, any>) => void
  onDeleteRows?: () => void
  onGenerateDeleteSQL?: () => void
  onGenerateChart?: () => void
  discardRef?: React.MutableRefObject<(() => void) | null>
  selectedRowsRef?: React.MutableRefObject<Set<number> | null>
  sortConfig?: { key: string; direction: 'asc' | 'desc' } | null
  onSort?: (key: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null)
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colName: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [modifiedCells, setModifiedCells] = useState<Map<string, any>>(new Map())
  const editInputRef = useRef<HTMLInputElement>(null)
  const suppressBlurRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  // Auto-focus and select input when editing starts
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingCell])

  // Reset selection and edit state when result set changes
  useEffect(() => {
    setSelectedRows(new Set())
    setLastClickedIdx(null)
    setModifiedCells(new Map())
    setEditingCell(null)
    setEditValue('')
    setContextMenu(null)
  }, [rows])

  // Notify parent of modified cells changes
  useEffect(() => {
    onModifiedCellsChange?.(modifiedCells.size, () => modifiedCells)
  }, [modifiedCells, onModifiedCellsChange])

  // Expose discard function to parent
  if (discardRef) {
    discardRef.current = () => {
      setModifiedCells(new Map())
      setEditingCell(null)
      setEditValue('')
    }
  }

  // Expose selected rows to parent for delete callbacks
  if (selectedRowsRef) {
    selectedRowsRef.current = selectedRows
  }

  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 15,
  })

  // Trigger load-more when last items come into view
  useEffect(() => {
    const items = virtualizer.getVirtualItems()
    const lastItem = items[items.length - 1]
    if (!lastItem) return
    const lastIdx = lastItem.index
    if (lastIdx >= rows.length - 5 && hasMore && !isLoadingMore) {
      onLoadMore()
    }
  }, [virtualizer.getVirtualItems(), rows.length, hasMore, isLoadingMore, onLoadMore])

  // Notify parent of selection changes
  useEffect(() => {
    onSelectionChange?.(Array.from(selectedRows))
  }, [selectedRows, onSelectionChange])

  // Close context menu on Escape key
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [contextMenu])

  const toggleRow = useCallback(
    (idx: number, ctrl: boolean, shift: boolean) => {
      setSelectedRows(prev => {
        const next = new Set(prev)
        if (shift && lastClickedIdx !== null && lastClickedIdx !== idx) {
          const from = Math.min(lastClickedIdx, idx)
          const to = Math.max(lastClickedIdx, idx)
          for (let i = from; i <= to; i++) next.add(i)
        } else if (ctrl) {
          if (next.has(idx)) {
            next.delete(idx)
          } else {
            next.add(idx)
          }
        } else {
          next.clear()
          next.add(idx)
        }
        return next
      })
      setLastClickedIdx(idx)
    },
    [lastClickedIdx]
  )

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const firstItem = virtualItems[0]
  const lastItem = virtualItems[virtualItems.length - 1]
  const beforeHeight = firstItem ? firstItem.start : 0
  const afterHeight = totalSize - (lastItem ? lastItem.end : 0)

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <table
        className="text-xs border-collapse border"
        style={{
          tableLayout: 'fixed',
          width: '100%',
          minWidth: 36 + columns.length * COL_MIN_WIDTH,
        }}
      >
        <thead className="sticky top-0 z-10">
          <tr>
            <th
              className="px-1.5 py-1.5 text-center font-medium text-white/50 border border-white/30"
              style={{ backgroundColor: 'hsl(var(--tab-active))', width: 36, minWidth: 36 }}
            >
              #
            </th>
            {columns.map((col: any) => (
              <th
                key={col.name}
                className="px-3 py-1.5 text-left font-medium text-white border border-white/30 cursor-pointer hover:bg-white/10 transition-colors select-none"
                style={{ backgroundColor: 'hsl(var(--tab-active))', minWidth: COL_MIN_WIDTH }}
                onClick={() => onSort?.(col.name)}
              >
                <div className="flex items-center gap-1 overflow-hidden">
                  <span className="truncate">{col.name}</span>
                  {sortConfig && sortConfig.key === col.name && (
                    <span className="text-white shrink-0">
                      {sortConfig.direction === 'asc' ? '▲' : '▼'}
                    </span>
                  )}
                  {col.isPrimaryKey && (
                    <span className="text-[11px] px-0.5 rounded bg-white/20 text-white shrink-0">
                      PK
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Top spacer row for virtual scroll offset */}
          {beforeHeight > 0 && (
            <tr style={{ height: beforeHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
          {virtualItems.map(virtualRow => {
            if (virtualRow.index >= rows.length) {
              return (
                <tr key="sentinel" style={{ height: 28 }}>
                  <td colSpan={columns.length + 1} className="border">
                    <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                      {isLoadingMore && <Loader2 size={12} className="animate-spin" />}
                      {isLoadingMore ? 'Loading...' : 'Scroll for more...'}
                    </div>
                  </td>
                </tr>
              )
            }
            const row = rows[virtualRow.index]
            const rowIdx = virtualRow.index
            // virtualizer can briefly request indices past the data tail during
            // load-more transitions; guard so noUncheckedIndexedAccess narrows.
            if (!row) return null
            const isSelected = selectedRows.has(rowIdx)
            return (
              <tr
                key={virtualRow.key}
                className={`hover:bg-accent transition-colors even:bg-muted/60 ${isSelected ? 'ring-1 ring-inset ring-blue-400' : ''}`}
                style={{
                  height: 28,
                  backgroundColor: isSelected ? 'hsl(var(--accent))' : undefined,
                }}
                onClick={e => {
                  e.preventDefault()
                  toggleRow(rowIdx, e.ctrlKey || e.metaKey, e.shiftKey)
                }}
                onContextMenu={e => {
                  e.preventDefault()
                  if (!selectedRows.has(rowIdx)) {
                    setSelectedRows(new Set([rowIdx]))
                    setLastClickedIdx(rowIdx)
                  }
                  setContextMenu({ x: e.clientX, y: e.clientY })
                }}
              >
                <td
                  className="px-1.5 py-1 text-center border text-muted-foreground select-none"
                  style={{ width: 36, minWidth: 36, fontSize: 10, cursor: 'pointer' }}
                >
                  {rowIdx + 1}
                </td>
                {columns.map((col: any) => {
                  const cellKey = `${rowIdx}:${col.name}`
                  const isEditing =
                    editingCell?.rowIdx === rowIdx && editingCell?.colName === col.name
                  const modifiedValue = modifiedCells.get(cellKey)
                  const displayValue = modifiedValue !== undefined ? modifiedValue : row[col.name]
                  const isModified = modifiedCells.has(cellKey)

                  if (isEditing) {
                    return (
                      <td
                        key={col.name}
                        className="px-0 py-0 border border-orange-400"
                        style={{ minWidth: COL_MIN_WIDTH, boxShadow: 'inset 0 0 0 1px #f97316' }}
                      >
                        <input
                          ref={editInputRef}
                          className="w-full h-full px-3 py-1 text-xs bg-orange-50 dark:bg-orange-950/40 text-foreground outline-none"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              const originalVal = row[col.name]
                              if (editValue !== String(originalVal ?? '')) {
                                setModifiedCells(prev => {
                                  const next = new Map(prev)
                                  next.set(cellKey, editValue === 'NULL' ? null : editValue)
                                  return next
                                })
                              }
                              suppressBlurRef.current = true
                              setEditingCell(null)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              suppressBlurRef.current = true
                              setEditingCell(null)
                            } else if (e.key === 'Tab') {
                              e.preventDefault()
                              const originalVal = row[col.name]
                              if (editValue !== String(originalVal ?? '')) {
                                setModifiedCells(prev => {
                                  const next = new Map(prev)
                                  next.set(cellKey, editValue === 'NULL' ? null : editValue)
                                  return next
                                })
                              }
                              setEditingCell(null)
                              const colIdx = columns.findIndex(
                                (c: ColumnInfo) => c.name === col.name
                              )
                              if (e.shiftKey) {
                                if (colIdx > 0) {
                                  const prevCol = columns[colIdx - 1]
                                  if (prevCol) {
                                    setTimeout(() => {
                                      setEditingCell({ rowIdx, colName: prevCol.name })
                                      setEditValue(
                                        String(
                                          modifiedCells.get(`${rowIdx}:${prevCol.name}`) ??
                                            row[prevCol.name] ??
                                            ''
                                        )
                                      )
                                    }, 0)
                                  }
                                }
                              } else {
                                if (colIdx < columns.length - 1) {
                                  const nextCol = columns[colIdx + 1]
                                  if (nextCol) {
                                    setTimeout(() => {
                                      setEditingCell({ rowIdx, colName: nextCol.name })
                                      setEditValue(
                                        String(
                                          modifiedCells.get(`${rowIdx}:${nextCol.name}`) ??
                                            row[nextCol.name] ??
                                            ''
                                        )
                                      )
                                    }, 0)
                                  }
                                }
                              }
                            }
                          }}
                          onBlur={() => {
                            if (suppressBlurRef.current) {
                              suppressBlurRef.current = false
                              setEditingCell(null)
                              return
                            }
                            const originalVal = row[col.name]
                            if (editValue !== String(originalVal ?? '')) {
                              setModifiedCells(prev => {
                                const next = new Map(prev)
                                next.set(cellKey, editValue === 'NULL' ? null : editValue)
                                return next
                              })
                            }
                            setEditingCell(null)
                          }}
                        />
                      </td>
                    )
                  }

                  return (
                    <td
                      key={col.name}
                      className={`px-3 py-1 whitespace-nowrap truncate border transition-colors ${isModified ? 'bg-orange-500/25 dark:bg-orange-500/20 ring-1 ring-inset ring-orange-500/70 shadow-[inset_3px_0_0_0_#f97316]' : 'hover:bg-muted/50'}`}
                      style={{ minWidth: COL_MIN_WIDTH, cursor: 'cell' }}
                      onDoubleClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        const currentVal = modifiedCells.get(cellKey)
                        const val = currentVal !== undefined ? currentVal : row[col.name]
                        setEditValue(val === null ? '' : String(val))
                        setEditingCell({ rowIdx, colName: col.name })
                      }}
                    >
                      <span
                        className={
                          displayValue === null
                            ? 'text-muted-foreground/40 italic'
                            : 'text-foreground'
                        }
                      >
                        {displayValue === null ? 'NULL' : String(displayValue)}
                      </span>
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {/* Bottom spacer row for virtual scroll offset */}
          {afterHeight > 0 && (
            <tr style={{ height: afterHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
      {contextMenu && (
        <TableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedCount={selectedRows.size}
          hasSelection={selectedRows.size > 0}
          canEdit={onSelectionChange != null}
          onClose={() => setContextMenu(null)}
          onCopyRows={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i])
              .filter((r): r is TableRow => r !== undefined)
            const text = selectedData
              .map(row => columns.map((c: ColumnInfo) => String(row[c.name] ?? '')).join('\t'))
              .join('\n')
            navigator.clipboard.writeText(text)
          }}
          onCopyAsMarkdown={async () => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i])
              .filter((r): r is TableRow => r !== undefined)
            const md = rowsToMarkdown(columns, selectedData)
            await navigator.clipboard.writeText(md)
          }}
          onExportCSV={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i])
              .filter((r): r is TableRow => r !== undefined)
            const csv = exportToCSV(columns, selectedData)
            downloadFile(csv, 'selected_export.csv', 'text/csv')
          }}
          onExportJSON={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i])
              .filter((r): r is TableRow => r !== undefined)
            const json = exportToJSON(columns, selectedData)
            downloadFile(json, 'selected_export.json', 'application/json')
          }}
          onExportSQL={() => {
            const selectedData = Array.from(selectedRows)
              .filter(i => i < rows.length)
              .sort((a, b) => a - b)
              .map(i => rows[i])
              .filter((r): r is TableRow => r !== undefined)
            const sql = exportToSQL(columns, selectedData, 'selected_data')
            downloadFile(sql, 'selected_export.sql', 'text/plain')
          }}
          onEditRow={() => {
            const idx = Array.from(selectedRows).sort((a, b) => a - b)[0]
            if (idx !== undefined && idx < rows.length && columns.length > 0) {
              const col = columns[0]
              const targetRow = rows[idx]
              if (col && targetRow) {
                const val = targetRow[col.name]
                setEditValue(val === null ? '' : String(val))
                setEditingCell({ rowIdx: idx, colName: col.name })
              }
            }
          }}
          onDeleteRows={() => {
            onDeleteRows?.()
          }}
          onGenerateDeleteSQL={() => {
            onGenerateDeleteSQL?.()
          }}
          onGenerateChart={() => {
            onGenerateChart?.()
          }}
        />
      )}
    </div>
  )
}

interface ResultTableProps {
  result?: QueryResult
  importPreview?: { columns: string[]; rows: TableRow[] } | null
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  onApplyChanges?: (
    modifiedCells: Map<string, unknown>,
    columns: ColumnInfo[],
    rows: TableRow[]
  ) => void
  onDeleteRows?: (rowIndices: number[]) => void
  onGenerateDeleteSQL?: (rowIndices: number[]) => void
  onGenerateChart?: () => void
}

function ResultTable({
  result,
  importPreview,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onApplyChanges,
  onDeleteRows,
  onGenerateDeleteSQL,
  onGenerateChart,
}: ResultTableProps) {
  const [modifiedCount, setModifiedCount] = useState(0)
  const modifiedCellsRef = useRef<() => Map<string, any>>(() => new Map())
  const discardRef = useRef<(() => void) | null>(null)
  const selectedRowsRef = useRef<Set<number> | null>(new Set())
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(
    null
  )

  const handleModifiedCellsChange = useCallback(
    (count: number, getCells: () => Map<string, any>) => {
      setModifiedCount(count)
      modifiedCellsRef.current = getCells
    },
    []
  )
  if (importPreview) {
    const { columns, rows } = importPreview
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-xs border-collapse border">
          <thead className="sticky top-0 z-10">
            <tr style={{ backgroundColor: 'hsl(var(--tab-active))' }}>
              {columns.map((col: any) => (
                <th
                  key={col}
                  className="px-3 py-1.5 text-left font-medium text-white border border-white/30"
                  style={{ minWidth: 120, maxWidth: 300 }}
                >
                  <span className="truncate block">{col}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any, rowIdx: number) => (
              <tr key={rowIdx} className="hover:bg-accent transition-colors even:bg-muted/60">
                {columns.map((col: any) => (
                  <td
                    key={col}
                    className="px-3 py-1 whitespace-nowrap max-w-[300px] truncate border"
                  >
                    <span className="text-foreground">
                      {row[col] === null || row[col] === undefined ? 'NULL' : String(row[col])}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (!result || result.columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {t('editor.clickToExecute')}
      </div>
    )
  }

  const { columns, rows: unsortedRows } = result
  const rows = sortConfig
    ? [...unsortedRows].sort((a, b) => {
        const aVal = a[sortConfig.key]
        const bVal = b[sortConfig.key]
        if (aVal === null || aVal === undefined) return 1
        if (bVal === null || bVal === undefined) return -1
        if (typeof aVal === 'number' && typeof bVal === 'number')
          return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal
        const aStr = String(aVal)
        const bStr = String(bVal)
        return sortConfig.direction === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
      })
    : unsortedRows
  const virtualCount = rows.length + (hasMore ? 1 : 0)

  return (
    <div className="flex flex-col h-full" data-testid="result-table">
      <VirtualTableBody
        rows={rows}
        columns={columns}
        virtualCount={virtualCount}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={onLoadMore}
        onModifiedCellsChange={handleModifiedCellsChange}
        onDeleteRows={() => onDeleteRows?.(Array.from(selectedRowsRef.current ?? new Set()))}
        onGenerateDeleteSQL={() =>
          onGenerateDeleteSQL?.(Array.from(selectedRowsRef.current ?? new Set()))
        }
        onGenerateChart={onGenerateChart}
        discardRef={discardRef}
        selectedRowsRef={selectedRowsRef}
        sortConfig={sortConfig}
        onSort={key =>
          setSortConfig(prev =>
            prev?.key === key && prev.direction === 'asc'
              ? { key, direction: 'desc' }
              : prev?.key === key
                ? null
                : { key, direction: 'asc' }
          )
        }
      />
      {/* Apply Changes toolbar */}
      {modifiedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border shrink-0 bg-orange-500/10">
          <span className="text-xs text-muted-foreground">
            {t('table.changesPending', { count: String(modifiedCount) })}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => discardRef.current?.()}
            className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('table.discardChanges')}
          </button>
          <button
            onClick={() => onApplyChanges?.(modifiedCellsRef.current(), columns, rows)}
            className="px-3 py-0.5 text-xs text-white rounded transition-colors"
            style={{ backgroundColor: 'hsl(var(--tab-active))' }}
          >
            {t('table.applyChanges')}
          </button>
        </div>
      )}
      {/* Bottom status bar */}
      <div className="flex items-center px-3 py-1 border-t border-border shrink-0 bg-muted/20 text-xs text-muted-foreground gap-2">
        {rows.length > 0 && (
          <span>
            {hasMore
              ? `${t('scroll.rowsLoaded', { count: String(rows.length) })} — ${t('scroll.scrollForMore')}`
              : t('scroll.allLoaded', { count: String(rows.length) })}
          </span>
        )}
        {rows.length >= 10000 && !hasMore && (
          <span className="text-warning">({t('scroll.rowLimitReached')})</span>
        )}
      </div>
    </div>
  )
}
export { ResultTable }
