import React, { useState, useMemo, useCallback } from "react";
import Editor from "@monaco-editor/react";
import {
  Play,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  FileText,
  Code,
  BarChart3,
  Table,
  Maximize2,
  Minimize2,
  Loader2
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line
} from "recharts";
import { t } from "@/lib/i18n";

interface Cell {
  id: string;
  type: "sql" | "markdown";
  content: string;
  name: string;
  executed: boolean;
  result?: any;
  error?: string;
  isRunning?: boolean;
}

interface SqlCellProps {
  cell: Cell;
  isActive: boolean;
  allCells: Cell[];
  onContentChange: (content: string) => void;
  onNameChange: (name: string) => void;
  onRun: (cell: Cell) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddSqlAfter: () => void;
  onAddMarkdownAfter: () => void;
}

type ResultViewMode = "table" | "chart" | "both";
type ChartType = "bar" | "line" | "pie";

const CHART_COLORS = [
  "#0088FE",
  "#00C49F",
  "#FFBB28",
  "#FF8042",
  "#8884d8",
  "#82ca9d",
];

const SqlCell: React.FC<SqlCellProps> = ({
  cell,
  isActive,
  onContentChange,
  onNameChange,
  onRun,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddSqlAfter,
  onAddMarkdownAfter
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>(cell.name);
  const [viewMode, setViewMode] = useState<ResultViewMode>("table");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [xAxisColumn, setXAxisColumn] = useState<string>("");
  const [yAxisColumns, setYAxisColumns] = useState<string[]>([]);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNameChange(editName);
    setIsEditingName(false);
  };

  const handleRunClick = useCallback(() => {
    onRun(cell);
  }, [cell, onRun]);

  // Prepare chart data
  const chartData = useMemo(() => {
    if (!cell.result || !cell.result.rows || cell.result.rows.length === 0) {
      return [];
    }

    const columns = cell.result.columns;
    const rows = cell.result.rows;

    return rows.map((row: any[]) => {
      const obj: Record<string, any> = {};
      columns.forEach((col: string, idx: number) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }, [cell.result]);

  // Pie chart data
  const pieData = useMemo(() => {
    if (!cell.result || !cell.result.rows || cell.result.rows.length === 0) {
      return [];
    }

    const xCol = xAxisColumn || cell.result.columns[0];
    const yCol = yAxisColumns[0] || cell.result.columns[1];
    
    if (!xCol || !yCol) return [];

    const xIndex = cell.result.columns.indexOf(xCol);
    const yIndex = cell.result.columns.indexOf(yCol);
    
    if (xIndex === -1 || yIndex === -1) return [];

    return cell.result.rows.map((row: any[], _idx: number) => ({
      name: String(row[xIndex]),
      value: Number(row[yIndex]) || 0
    }));
  }, [cell.result, xAxisColumn, yAxisColumns]);

  const availableColumns = cell.result?.columns || [];

  return (
    <div className={`border rounded overflow-hidden ${isActive ? "border-[hsl(var(--tab-active))]" : "border-border"} ${isExpanded ? "" : "h-8"}`}>
      {/* Cell Header */}
      <div className="flex items-center justify-between bg-muted/30 px-2 py-0.5">
        <div className="flex items-center gap-1">
          <Code size={14} className="text-[hsl(var(--tab-active))] shrink-0" />
          {isEditingName ? (
            <form onSubmit={handleNameSubmit} className="flex items-center">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-background text-foreground px-1.5 py-0.5 rounded text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] border border-border w-40"
                autoFocus
                onBlur={handleNameSubmit}
              />
            </form>
          ) : (
            <span
              className="text-xs font-medium cursor-pointer hover:text-[hsl(var(--tab-active))] truncate max-w-[200px]"
              onClick={() => setIsEditingName(true)}
            >
              {cell.name}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <button aria-label={t('notebook.runCell')} onClick={handleRunClick}
            disabled={cell.isRunning}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            title={t('notebook.runCell')}
          >
            {cell.isRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={isExpanded ? t('common.collapse') : t('common.expand')}
          >
            {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button aria-label={t('notebook.addSqlCell')} onClick={onAddSqlAfter}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.addSqlCell')}
          >
            <Plus size={12} />
          </button>
          <button aria-label={t('notebook.addMarkdownCell')} onClick={onAddMarkdownAfter}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.addMarkdownCell')}
          >
            <FileText size={12} />
          </button>
          <button aria-label={t('notebook.moveUp')} onClick={onMoveUp}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.moveUp')}
          >
            <ArrowUp size={12} />
          </button>
          <button aria-label={t('notebook.moveDown')} onClick={onMoveDown}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.moveDown')}
          >
            <ArrowDown size={12} />
          </button>
          <button aria-label={t('notebook.deleteCell')} onClick={onDelete}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
            title={t('notebook.deleteCell')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Cell Content */}
      {isExpanded && (
        <div className="flex flex-col">
          {/* Monaco Editor */}
          <div className="h-32 border-b border-border">
            <Editor
              height="100%"
              language="sql"
              value={cell.content}
              onChange={(val) => onContentChange(val || "")}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                tabSize: 2,
                renderLineHighlight: "line",
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                folding: true,
                lineNumbers: "on",
                glyphMargin: false,
                contextmenu: false,
              }}
            />
          </div>

          {/* Cell Result */}
          <div className="p-2">
            {cell.executed && cell.result && (
              <div className="bg-card rounded p-2 border border-border">
                {/* Result View Tabs */}
                <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-border">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">Results</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setViewMode("table")}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                          viewMode === "table" ? "bg-[hsl(var(--tab-active))] text-white" : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <Table size={12} />
                        {t('notebook.tableView')}
                      </button>
                      <button
                        onClick={() => setViewMode("chart")}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                          viewMode === "chart" ? "bg-[hsl(var(--tab-active))] text-white" : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <BarChart3 size={12} />
                        {t('notebook.chartView')}
                      </button>
                    </div>
                  </div>

                  {viewMode === "chart" && (
                    <div className="flex items-center gap-2">
                      <select
                        value={chartType}
                        onChange={(e) => setChartType(e.target.value as ChartType)}
                        className="text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
                      >
                        <option value="bar">{t('notebook.barChart')}</option>
                        <option value="line">{t('notebook.lineChart')}</option>
                        <option value="pie">{t('notebook.pieChart')}</option>
                      </select>

                      {availableColumns.length > 0 && (
                        <>
                          <select
                            value={xAxisColumn}
                            onChange={(e) => setXAxisColumn(e.target.value)}
                            className="text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"

                          >
                            <option value="">{t('notebook.xAxis')}</option>
                            {availableColumns.map((col: string) => (
                              <option key={col} value={col}>{col}</option>
                            ))}
                          </select>

                          {(chartType === "bar" || chartType === "line") && (
                            <select
                              value={yAxisColumns[0] || ""}
                              onChange={(e) => setYAxisColumns([e.target.value])}
                              className="text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"

                            >
                              <option value="">{t('notebook.yAxis')}</option>
                              {availableColumns.map((col: string) => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Table View */}
                {viewMode === "table" && (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-border">
                      <thead>
                        <tr>
                          {cell.result.columns.map((column: string, index: number) => (
                            <th key={index} className="px-2 py-0.5 text-left text-[11px] font-medium text-muted-foreground uppercase max-w-[300px]">
                              <span className="truncate block">{column}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-card divide-y divide-border">
                        {cell.result.rows.slice(0, 100).map((row: any[], index: number) => (
                          <tr key={index} className="hover:bg-muted/50">
                            {row.map((value: any, colIndex: number) => (
                              <td key={colIndex} className="px-2 py-0.5 text-xs text-foreground">
                                {value === null ? (
                                  <span className="text-muted-foreground">NULL</span>
                                ) : (
                                  String(value)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {cell.result.rows.length > 100 && (
                      <div className="text-xs text-muted-foreground mt-2 text-center">
                        {t('notebook.showingPartial', { count: 100, total: cell.result.rows.length })}
                      </div>
                    )}
                  </div>
                )}

                {/* Chart View */}
                {viewMode === "chart" && chartData.length > 0 && (
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      {chartType === "bar" && (
                        <BarChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                          <XAxis dataKey={xAxisColumn || chartData[0] && Object.keys(chartData[0])[0]} />
                          <YAxis />
                          <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} />
                          <Legend />
                          {(yAxisColumns.length > 0 ? yAxisColumns : [Object.keys(chartData[0] || {})[1]]).map((col, idx) => (
                            col && <Bar key={col} dataKey={col} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                          ))}
                        </BarChart>
                      )}

                      {chartType === "line" && (
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                          <XAxis dataKey={xAxisColumn || Object.keys(chartData[0])[0]} />
                          <YAxis />
                          <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} />
                          <Legend />
                          {(yAxisColumns.length > 0 ? yAxisColumns : [Object.keys(chartData[0] || {})[1]]).map((col, idx) => (
                            col && <Line key={col} type="monotone" dataKey={col} stroke={CHART_COLORS[idx % CHART_COLORS.length]} />
                          ))}
                        </LineChart>
                      )}

                      {chartType === "pie" && (
                        <PieChart>
                          <Pie
                            data={pieData.length > 0 ? pieData : chartData.slice(0, 10)}
                            cx="50%"
                            cy="50%"
                            labelLine={true}
                            label={({ name, value }) => `${name}: ${value}`}
                            outerRadius={100}
                            fill="#8884d8"
                            dataKey="value"
                          >
                            {(pieData.length > 0 ? pieData : chartData.slice(0, 10)).map((_entry: any, index: number) => (
                              <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} />
                        </PieChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {cell.executed && cell.error && (
              <div className="bg-destructive/20 border border-destructive rounded p-4">
                <h4 className="text-xs font-medium mb-1 text-destructive">Error</h4>
                <p className="text-xs text-destructive">{cell.error}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SqlCell;