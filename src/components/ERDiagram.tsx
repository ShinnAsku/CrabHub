import { useState, useEffect, useMemo } from "react";
import { X, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { getTables, getColumns, getTableForeignKeys } from "@/lib/tauri-commands";

interface ERDiagramProps {
  isOpen?: boolean;
  onClose?: () => void;
  connectionId?: string;
  schemaName?: string;
  embedded?: boolean;
}

interface TableColumn {
  name: string;
  isPK: boolean;
  isFK: boolean;
  type: string;
}

interface TableRect {
  name: string;
  schema?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: TableColumn[];
}

interface FKConnection {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  constraintName: string;
}

interface ConnectionLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sourceTable: string;
  targetTable: string;
}

// Normalize FK fields across different DB types (PG/MySQL/MSSQL)
function normalizeForeignKey(fk: any, sourceTableName: string): FKConnection | null {
  const col = fk.column_name || fk.COLUMN_NAME;
  const refTable = fk.foreign_table_name || fk.REFERENCED_TABLE_NAME;
  const refCol = fk.foreign_column_name || fk.REFERENCED_COLUMN_NAME;
  const name = fk.constraint_name || fk.CONSTRAINT_NAME || '';
  if (!col || !refTable || !refCol) return null;
  return {
    sourceTable: sourceTableName,
    sourceColumn: col,
    targetTable: refTable,
    targetColumn: refCol,
    constraintName: name,
  };
}

// Layout tables in a grid with dynamic sizing
function layoutTables(
  tableData: { name: string; schema?: string; columns: TableColumn[] }[],
): { tables: TableRect[]; svgWidth: number; svgHeight: number } {
  const COLS = 3;
  const GAP_X = 60;
  const GAP_Y = 50;
  const PADDING = 40;
  const HEADER_H = 24;
  const ROW_H = 18;
  const MIN_W = 150;

  // Calculate widths for each table
  const rects: TableRect[] = [];
  // Track max width per grid column for alignment
  const colMaxWidths: number[] = [];
  const rowMaxHeights: number[] = [];

  for (let i = 0; i < tableData.length; i++) {
    const td = tableData[i]!;
    const colWidth = Math.max(
      ...td.columns.map((c) => (c.name.length + c.type.length + 6) * 6.5 + 20),
      td.name.length * 8 + 30,
      MIN_W,
    );
    const colHeight = Math.max(td.columns.length * ROW_H + HEADER_H + 8, 50);

    const gc = i % COLS;
    const gr = Math.floor(i / COLS);

    if (!colMaxWidths[gc] || colWidth > colMaxWidths[gc]!) colMaxWidths[gc] = colWidth;
    if (!rowMaxHeights[gr] || colHeight > rowMaxHeights[gr]!) rowMaxHeights[gr] = colHeight;

    rects.push({
      name: td.name,
      schema: td.schema,
      x: 0, // will be calculated below
      y: 0,
      width: colWidth,
      height: colHeight,
      columns: td.columns,
    });
  }

  // Calculate positions
  for (let i = 0; i < rects.length; i++) {
    const gc = i % COLS;
    const gr = Math.floor(i / COLS);
    let x = PADDING;
    for (let c = 0; c < gc; c++) x += (colMaxWidths[c] || MIN_W) + GAP_X;
    let y = PADDING;
    for (let r = 0; r < gr; r++) y += (rowMaxHeights[r] || 50) + GAP_Y;
    rects[i]!.x = x;
    rects[i]!.y = y;
  }

  const svgWidth = rects.length > 0
    ? Math.max(800, ...rects.map((r) => r.x + r.width + PADDING))
    : 800;
  const svgHeight = rects.length > 0
    ? Math.max(400, ...rects.map((r) => r.y + r.height + PADDING))
    : 400;

  return { tables: rects, svgWidth, svgHeight };
}

// Build connection lines from FK data
function buildConnections(tables: TableRect[], fks: FKConnection[]): ConnectionLine[] {
  const tableMap = new Map<string, TableRect>();
  for (const t of tables) tableMap.set(t.name.toLowerCase(), t);

  const lines: ConnectionLine[] = [];
  for (const fk of fks) {
    const src = tableMap.get(fk.sourceTable.toLowerCase());
    const tgt = tableMap.get(fk.targetTable.toLowerCase());
    if (!src || !tgt || src === tgt) continue;

    // Find the column index in source and target
    const srcColIdx = src.columns.findIndex((c) => c.name.toLowerCase() === fk.sourceColumn.toLowerCase());
    const tgtColIdx = tgt.columns.findIndex((c) => c.name.toLowerCase() === fk.targetColumn.toLowerCase());

    const ROW_H = 18;
    const HEADER_H = 24;
    const srcY = src.y + HEADER_H + 8 + (srcColIdx >= 0 ? srcColIdx : 0) * ROW_H + ROW_H / 2;
    const tgtY = tgt.y + HEADER_H + 8 + (tgtColIdx >= 0 ? tgtColIdx : 0) * ROW_H + ROW_H / 2;

    // Connect from right edge of source to left edge of target (or vice versa)
    let x1: number, x2: number;
    if (src.x + src.width < tgt.x) {
      // Source is to the left
      x1 = src.x + src.width;
      x2 = tgt.x;
    } else if (tgt.x + tgt.width < src.x) {
      // Target is to the left
      x1 = src.x;
      x2 = tgt.x + tgt.width;
    } else {
      // Overlapping X — use right edges
      x1 = src.x + src.width;
      x2 = tgt.x + tgt.width;
    }

    lines.push({ x1, y1: srcY, x2, y2: tgtY, sourceTable: fk.sourceTable, targetTable: fk.targetTable });
  }
  return lines;
}

// SVG bezier path for a connection line
function connectionPath(line: ConnectionLine): string {
  const dx = Math.abs(line.x2 - line.x1);
  const cp = Math.max(dx * 0.4, 30);
  return `M ${line.x1} ${line.y1} C ${line.x1 + (line.x1 < line.x2 ? cp : -cp)} ${line.y1}, ${line.x2 + (line.x2 > line.x1 ? -cp : cp)} ${line.y2}, ${line.x2} ${line.y2}`;
}

// Shared SVG rendering for ER diagram
function ERDiagramSVG({ tables, connections, svgWidth, svgHeight }: {
  tables: TableRect[];
  connections: ConnectionLine[];
  svgWidth: number;
  svgHeight: number;
}) {
  return (
    <svg width={svgWidth} height={svgHeight} className="min-w-full min-h-full">
      <defs>
        <marker id="er-arrow" viewBox="0 0 10 10" refX="10" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--tab-active))" opacity="0.7" />
        </marker>
      </defs>

      {/* Connection lines */}
      {connections.map((line, i) => (
        <path
          key={i}
          d={connectionPath(line)}
          stroke="hsl(var(--tab-active))"
          strokeWidth="1.5"
          fill="none"
          opacity="0.6"
          markerEnd="url(#er-arrow)"
        />
      ))}

      {/* Table boxes */}
      {tables.map((table) => (
        <g key={table.name}>
          {/* Table header */}
          <rect
            x={table.x}
            y={table.y}
            width={table.width}
            height={24}
            rx={4}
            ry={4}
            fill="hsl(var(--tab-active))"
            opacity="0.9"
          />
          <rect
            x={table.x}
            y={table.y + 20}
            width={table.width}
            height={4}
            fill="hsl(var(--tab-active))"
            opacity="0.9"
          />
          <text
            x={table.x + 8}
            y={table.y + 16}
            fill="white"
            fontSize="11"
            fontWeight="bold"
          >
            {table.name}
          </text>

          {/* Table body */}
          <rect
            x={table.x}
            y={table.y + 24}
            width={table.width}
            height={table.height - 24}
            fill="hsl(var(--background))"
            stroke="hsl(var(--border))"
            strokeWidth="1"
            rx="0"
            ry="0"
          />
          {/* Bottom rounded corners */}
          <rect
            x={table.x}
            y={table.y + table.height - 4}
            width={table.width}
            height={4}
            fill="hsl(var(--background))"
            rx="4"
            ry="4"
          />

          {/* Columns */}
          {table.columns.map((col, ci) => {
            const prefix = col.isPK ? "PK" : col.isFK ? "FK" : "  ";
            const prefixColor = col.isPK
              ? "hsl(var(--tab-active))"
              : col.isFK
              ? "#60a5fa"
              : "hsl(var(--muted-foreground))";
            return (
              <g key={col.name}>
                {/* Prefix (PK/FK) */}
                <text
                  x={table.x + 6}
                  y={table.y + 40 + ci * 18}
                  fill={prefixColor}
                  fontSize="9"
                  fontFamily="monospace"
                  fontWeight={col.isPK || col.isFK ? "bold" : "normal"}
                >
                  {prefix}
                </text>
                {/* Column name */}
                <text
                  x={table.x + 24}
                  y={table.y + 40 + ci * 18}
                  fill={col.isPK ? "hsl(var(--tab-active))" : "hsl(var(--muted-foreground))"}
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {col.name}
                </text>
                {/* Column type */}
                <text
                  x={table.x + 24 + col.name.length * 6.5 + 6}
                  y={table.y + 40 + ci * 18}
                  fill="hsl(var(--muted-foreground))"
                  fontSize="9"
                  fontFamily="monospace"
                  opacity="0.6"
                >
                  {col.type}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

function ERDiagram({ isOpen = true, onClose, connectionId, schemaName, embedded }: ERDiagramProps) {
  const [tables, setTables] = useState<TableRect[]>([]);
  const [connections, setConnections] = useState<ConnectionLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableCount, setTableCount] = useState(0);

  // Load real data via API
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;

    const loadData = async () => {
      setLoading(true);
      setError(null);
      try {
        const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
        if (!isTauri) {
          setLoading(false);
          return;
        }

        // 1. Get all tables, optionally filter by schema
        let tableInfos = await getTables(connectionId);
        if (schemaName) {
          tableInfos = tableInfos.filter((ti) => !ti.schema || ti.schema === schemaName);
        }
        if (cancelled) return;
        setTableCount(tableInfos.length);

        // 2. For each table, load columns and foreign keys in parallel
        const allFKs: FKConnection[] = [];
        const fkSourceColumns = new Set<string>(); // "tableName.columnName"

        const tableDataArr = await Promise.all(
          tableInfos.map(async (ti) => {
            const [colsResult, fksResult] = await Promise.allSettled([
              getColumns(connectionId, ti.name, ti.schema),
              getTableForeignKeys(connectionId, ti.name, ti.schema),
            ]);

            const cols = colsResult.status === 'fulfilled' ? colsResult.value : [];
            const rawFks = fksResult.status === 'fulfilled' ? fksResult.value : [];

            // Normalize FKs
            for (const rawFk of rawFks) {
              const normalized = normalizeForeignKey(rawFk, ti.name);
              if (normalized) {
                allFKs.push(normalized);
                fkSourceColumns.add(`${ti.name.toLowerCase()}.${normalized.sourceColumn.toLowerCase()}`);
              }
            }

            return {
              name: ti.name,
              schema: ti.schema,
              columns: cols.map((c) => ({
                name: c.name,
                isPK: c.primaryKey,
                isFK: false, // will be set after all FKs are collected
                type: c.type || '',
              })),
            };
          }),
        );

        if (cancelled) return;

        // Mark FK columns
        for (const td of tableDataArr) {
          for (const col of td.columns) {
            if (fkSourceColumns.has(`${td.name.toLowerCase()}.${col.name.toLowerCase()}`)) {
              col.isFK = true;
            }
          }
        }

        // Layout
        const { tables: layoutTbls, svgWidth: _w, svgHeight: _h } = layoutTables(tableDataArr);
        const conns = buildConnections(layoutTbls, allFKs);

        setTables(layoutTbls);
        setConnections(conns);
      } catch (err) {
        if (!cancelled) {
          console.error('[ERDiagram] Failed to load data:', err);
          setError(t('er.loadError'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadData();
    return () => { cancelled = true; };
  }, [connectionId, schemaName]);

  // SVG dimensions computed from tables
  const svgWidth = useMemo(() => {
    if (tables.length === 0) return 800;
    return Math.max(800, ...tables.map((t) => t.x + t.width + 40));
  }, [tables]);

  const svgHeight = useMemo(() => {
    if (tables.length === 0) return 400;
    return Math.max(400, ...tables.map((t) => t.y + t.height + 40));
  }, [tables]);

  if (!isOpen) return null;

  const content = loading ? (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
      <div className="flex flex-col items-center gap-2">
        <Loader2 size={24} className="animate-spin" />
        <span>{t('er.loading')}</span>
      </div>
    </div>
  ) : error ? (
    <div className="flex items-center justify-center h-full text-xs text-destructive">
      {error}
    </div>
  ) : tables.length === 0 ? (
    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
      {t('er.noData')}
    </div>
  ) : (
    <ERDiagramSVG
      tables={tables}
      connections={connections}
      svgWidth={svgWidth}
      svgHeight={svgHeight}
    />
  );

  // Embedded mode
  if (embedded) {
    return (
      <div className="w-full h-full overflow-auto bg-background">
        {content}
      </div>
    );
  }

  // Modal mode
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[90vw] h-[85vh] bg-background border border-border rounded-lg shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t('er.title')}</span>
            <span className="text-[10px] text-muted-foreground">
              {t('er.tableCount', { count: String(tableCount) })}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* SVG Canvas */}
        <div className="flex-1 overflow-auto bg-muted/10">
          {content}
        </div>
      </div>
    </div>
  );
}

export default ERDiagram;
